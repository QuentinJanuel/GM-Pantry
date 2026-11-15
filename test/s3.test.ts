import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { addVersion, emptyRepo, loadRepo, serialize } from "../src/index.ts";
import { ConflictError, S3Error, S3Store, checkCors, choosePartSize, publishRepo, type UploadState } from "../src/s3.ts";
import { startFakeS3, type Options } from "./fake-s3.ts";

const MiB = 1024 * 1024;
const NOW = "2026-01-01T00:00:00.000Z";
const text = (b?: { bytes: Uint8Array }) => (b ? new TextDecoder().decode(b.bytes) : undefined);

async function setup(opts: Options = {}, cfg: Partial<ConstructorParameters<typeof S3Store>[0]> = {}) {
  const fake = await startFakeS3(opts);
  const store = new S3Store({ ...fake.config, endpoint: fake.endpoint, retryDelayMs: 1, ...cfg });
  return { fake, store };
}

test("signed requests work in path style and in virtual-host style", async () => {
  const { fake, store } = await setup();
  const virtual = new S3Store({ ...fake.config, endpoint: fake.virtualEndpoint, forcePathStyle: false, prefix: "/pre/fix/" });
  try {
    await store.putObject("a b/ü!.txt", "hello", { contentType: "text/plain", cacheControl: "no-cache", metadata: { sha256: "x" } });
    assert.equal(text(await store.getObject("a b/ü!.txt")), "hello");
    assert.deepEqual(await store.headObject("a b/ü!.txt"), { etag: fake.objects.get("a b/ü!.txt")!.etag, size: 5, metadata: { sha256: "x" } });
    assert.equal(fake.objects.get("a b/ü!.txt")!.headers["cache-control"], "no-cache");
    assert.equal(await store.getObject("missing"), undefined);
    await virtual.putObject("k.txt", "v");
    assert.ok(fake.objects.has("pre/fix/k.txt"));
    assert.deepEqual(await virtual.listKeys(), ["k.txt"]);
    await virtual.deleteObject("k.txt");
    assert.equal(fake.objects.size, 1);
    assert.deepEqual([...fake.state.styles].sort(), ["path", "virtual"]);
  } finally {
    fake.close();
  }
});

test("bad credentials, region and bucket are rejected distinctly", async () => {
  const { fake, store } = await setup();
  try {
    const code = (s: S3Store) => s.putObject("x", "y").then(() => "ok", (e) => (e as S3Error).code);
    assert.equal(await code(new S3Store({ ...store.config, secretAccessKey: "wrong" })), "SignatureDoesNotMatch");
    assert.equal(await code(new S3Store({ ...store.config, accessKeyId: "nope" })), "InvalidAccessKeyId");
    assert.equal(await code(new S3Store({ ...store.config, region: "eu-west-1" })), "AuthorizationHeaderMalformed");
    assert.equal(await code(new S3Store({ ...store.config, bucket: "other" })), "NoSuchBucket");
    assert.equal(await code(store), "ok");
  } finally {
    fake.close();
  }
});

test("testConnection tells the problems apart", async () => {
  const status = async (opts: Options, cfg = {}) => {
    const { fake, store } = await setup(opts, cfg);
    try {
      const r = await store.testConnection();
      return { ok: r.ok, by: Object.fromEntries(r.checks.map((c) => [c.name, c.status])), msg: r.checks.map((c) => c.message).join(" | "), left: fake.objects.size };
    } finally {
      fake.close();
    }
  };
  assert.deepEqual(await status({}), { ok: true, by: { list: "pass", write: "pass", delete: "pass" }, msg: "ListObjectsV2 allowed | PutObject allowed | DeleteObject allowed", left: 0 });
  assert.equal((await status({}, { secretAccessKey: "x" })).msg, "credentials rejected (SignatureDoesNotMatch)");
  assert.equal((await status({}, { bucket: "nope" })).msg, "the bucket does not exist");
  assert.match((await status({}, { region: "eu-west-1" })).msg, /wrong region/);
  const noList = await status({ deny: new Set(["list"]) });
  assert.equal(noList.ok, true);
  assert.equal(noList.by.list, "warn");
  const noPut = await status({ deny: new Set(["put"]) });
  assert.deepEqual([noPut.ok, noPut.by.write], [false, "fail"]);
  assert.match(noPut.msg, /s3:PutObject/);
  const noDelete = await status({ deny: new Set(["delete"]) });
  assert.deepEqual([noDelete.ok, noDelete.by.delete, noDelete.left], [false, "fail", 1]);
  const unreachable = await new S3Store({ endpoint: "http://127.0.0.1:1", region: "r", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }).testConnection();
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.checks[0].message, /no response/);
});

test("part size grows so 4 GB, and bigger, fit in 10,000 parts", () => {
  assert.equal(choosePartSize(4 * 1024 ** 3), 16 * MiB);
  assert.equal(choosePartSize(1, 1), 5 * MiB);
  const huge = 500 * 1024 ** 3;
  assert.ok(Math.ceil(huge / choosePartSize(huge)) <= 10_000);
});

test("multipart upload: parts, ETag, progress, and a small file takes one PUT", async () => {
  const { fake, store } = await setup();
  try {
    const bytes = Buffer.alloc(12 * MiB + 5, 3);
    const progress: number[] = [];
    const r = await store.uploadFile("big.zip", new Blob([bytes]), { partSize: 5 * MiB, concurrency: 3, contentType: "application/zip", metadata: { sha256: "h" }, onProgress: (u) => progress.push(u) });
    assert.equal(r.multipart, true);
    assert.match(r.etag, /-3"$/);
    assert.ok(fake.objects.get("big.zip")!.body.equals(bytes));
    assert.equal(fake.objects.get("big.zip")!.headers["content-type"], "application/zip");
    assert.equal(fake.objects.get("big.zip")!.headers["x-amz-meta-sha256"], "h");
    assert.equal(progress.at(-1), bytes.length);
    assert.equal(fake.uploads.size, 0);
    assert.equal((await store.uploadFile("small.zip", new Blob(["x"]))).multipart, false);
  } finally {
    fake.close();
  }
});

test("a multipart upload aborted midway resumes without re-sending finished parts", async () => {
  const { fake, store } = await setup();
  try {
    const bytes = Buffer.alloc(12 * MiB, 9);
    const blob = new Blob([bytes]);
    let saved: UploadState | undefined;
    const ac = new AbortController();
    await assert.rejects(store.uploadFile("big.zip", blob, { partSize: 5 * MiB, concurrency: 1, signal: ac.signal, onState: (s) => { saved = s; if (s.parts.length === 1) ac.abort(); } }), { name: "AbortError" });
    assert.equal(saved!.parts.length, 1);
    assert.equal(fake.uploads.size, 1);
    assert.equal(fake.objects.has("big.zip"), false);
    await store.uploadFile("big.zip", blob, { partSize: 5 * MiB, resume: saved });
    assert.equal(fake.log.filter((l) => l === "PUT big.zip").length, 3); // 3 parts in total, none twice
    assert.ok(fake.objects.get("big.zip")!.body.equals(bytes));

    // a resume state the service no longer knows starts over
    const stale = { ...saved!, uploadId: "gone" };
    await store.uploadFile("again.zip", blob, { partSize: 5 * MiB, resume: stale });
    assert.ok(fake.objects.get("again.zip")!.body.equals(bytes));
  } finally {
    fake.close();
  }
});

test("a failed part is retried, and incomplete uploads can be listed and aborted", async () => {
  const { fake, store } = await setup();
  try {
    fake.state.failNextPart = true;
    await store.uploadFile("r.zip", new Blob([Buffer.alloc(6 * MiB)]), { partSize: 5 * MiB, concurrency: 1 });
    assert.equal(fake.objects.get("r.zip")!.body.length, 6 * MiB);

    const ac = new AbortController();
    await store.uploadFile("left.zip", new Blob([Buffer.alloc(11 * MiB)]), { partSize: 5 * MiB, concurrency: 1, signal: ac.signal, onState: (s) => s.parts.length === 1 && ac.abort() }).catch(() => {});
    assert.deepEqual((await store.listUploads()).map((u) => u.key), ["left.zip"]);
    assert.equal(await store.abortIncompleteUploads(), 1);
    assert.equal(fake.uploads.size, 0);
  } finally {
    fake.close();
  }
});

/** A two-game repo as serialize would produce it, with the archive blobs. */
async function repoOf(games: Record<string, string>, previous?: object) {
  const repo = emptyRepo("T", NOW);
  const archives = [];
  for (const [id, content] of Object.entries(games)) {
    const sha256 = (await import("node:crypto")).createHash("sha256").update(content).digest("hex");
    addVersion(repo, { id, title: id, file: { url: `${id}.zip`, sha256, size: content.length } });
    archives.push({ url: `${id}.zip`, body: new Blob([content]), sha256 });
  }
  return { out: await serialize(repo, { shardSize: 1, previous, now: NOW }), archives };
}

test("publishRepo writes archives and shards first, repo.json last, then deletes orphan shards", async () => {
  const { fake, store } = await setup();
  try {
    const first = await repoOf({ a: "one", b: "two" });
    const r1 = await publishRepo(store, first.out, { archives: first.archives });
    assert.equal(r1.conditional, true);
    const puts = fake.log.filter((l) => l.startsWith("PUT"));
    assert.equal(puts.at(-1), "PUT repo.json");
    assert.equal(puts.filter((l) => l === "PUT repo.json").length, 1);
    assert.deepEqual(fake.log.filter((l) => l.startsWith("DELETE")), []);
    const repoObj = fake.objects.get("repo.json")!;
    assert.equal(repoObj.headers["content-type"], "application/json");
    assert.equal(repoObj.headers["cache-control"], "no-cache");
    const shardKey = [...fake.objects.keys()].find((k) => k.startsWith("shards/"))!;
    assert.equal(fake.objects.get(shardKey)!.headers["cache-control"], "public, max-age=31536000, immutable");

    // a reader sees a complete, verified repo
    const { repo, warnings } = await loadRepo(`${fake.endpoint}/bkt/repo.json`);
    assert.deepEqual([repo.games.map((g) => g.id), warnings], [["a", "b"], []]);

    // change one game: a new shard, the old one is deleted after repo.json
    const before = new Set(fake.objects.keys());
    fake.log.length = 0;
    const second = await repoOf({ a: "one", b: "TWO" }, JSON.parse(first.out.repoJson));
    const r2 = await publishRepo(store, second.out, { archives: second.archives });
    assert.equal(r2.deleted.length, 1);
    assert.deepEqual(r2.skipped.filter((u) => u.endsWith(".zip")), ["a.zip"]); // unchanged archive not re-sent
    const order = fake.log.filter((l) => l.startsWith("PUT") || l.startsWith("DELETE"));
    assert.equal(order.at(-1)!.startsWith("DELETE"), true);
    assert.equal(order.at(-2), "PUT repo.json");
    assert.ok(order.indexOf("PUT b.zip") < order.indexOf("PUT repo.json"));
    assert.equal(fake.objects.size, before.size);
    assert.equal(text(await store.getObject("b.zip")), "TWO");
  } finally {
    fake.close();
  }
});

test("repo.json writes are guarded by ETag, with a documented fallback when unsupported", async () => {
  const { fake, store } = await setup();
  try {
    const one = await repoOf({ a: "one" });
    await publishRepo(store, one.out, { archives: one.archives, ifMatch: null });
    // someone else wins: a publisher that loaded the old ETag is refused before it uploads anything
    const loadedEtag = fake.objects.get("repo.json")!.etag;
    const mine = await repoOf({ a: "one", c: "three" });
    await store.putObject("repo.json", (await repoOf({ a: "one", b: "two" })).out.repoJson, { ifMatch: loadedEtag });
    fake.log.length = 0;
    await assert.rejects(publishRepo(store, mine.out, { archives: mine.archives, ifMatch: loadedEtag }), ConflictError);
    assert.equal(fake.log.some((l) => l.startsWith("PUT")), false);
    // the same publisher with a creation guard on an existing repo is refused too
    await assert.rejects(publishRepo(store, mine.out, { ifMatch: null }), ConflictError);
  } finally {
    fake.close();
  }
  const odd = await setup({ brokenIfMatch: true });
  try {
    const one = await repoOf({ a: "one" });
    await publishRepo(odd.store, one.out, { archives: one.archives });
    const loaded = (await odd.store.getObject("repo.json"))!.etag;
    const two = await repoOf({ a: "one", b: "two" });
    const r = await publishRepo(odd.store, two.out, { archives: two.archives, ifMatch: loaded });
    assert.equal(r.conditional, false);
    // a real change is still refused
    await odd.store.putObject("repo.json", "{}", { contentType: "application/json" });
    await assert.rejects(publishRepo(odd.store, two.out, { ifMatch: loaded }), ConflictError);
  } finally {
    odd.fake.close();
  }
  const legacy = await setup({ conditional: false });
  try {
    const one = await repoOf({ a: "one" });
    const r = await publishRepo(legacy.store, one.out, { archives: one.archives });
    assert.equal(r.conditional, false);
    assert.ok(legacy.fake.objects.has("repo.json"));
  } finally {
    legacy.fake.close();
  }
});

test("checkCors reports what is missing and hands out snippets; setCors sends PutBucketCors", async () => {
  const full = { origins: ["*"], methods: ["GET", "HEAD", "PUT", "POST", "DELETE"], headers: ["*"], expose: ["ETag", "Content-Range"] };
  const run = async (cors: Options["cors"]) => {
    const { fake, store } = await setup({ cors });
    try {
      await store.putObject("repo.json", "{}");
      return { fake, store, report: await checkCors(`${fake.endpoint}/bkt/`, "https://app.example", { writeUrl: store.url("repo.json").href }) };
    } finally {
      fake.close();
    }
  };
  const good = await run(full);
  assert.equal(good.report.ok, true, JSON.stringify(good.report.checks));
  assert.equal(good.report.checks.find((c) => c.name === "range")!.status, "pass");

  const none = await run(undefined);
  assert.equal(none.report.ok, false);
  assert.deepEqual(none.report.checks.filter((c) => c.status === "fail").map((c) => c.name), ["allow-origin", "expose ETag", "preflight PUT", "preflight POST", "preflight DELETE"]);
  assert.deepEqual(Object.keys(none.report.snippets), ["s3", "r2", "b2"]);
  assert.equal(JSON.parse(none.report.snippets.s3.json).CORSRules[0].AllowedOrigins[0], "https://app.example");
  assert.match(none.report.snippets.s3.command, /put-bucket-cors/);
  assert.match(none.report.snippets.r2.command, /wrangler r2 bucket cors set/);

  const noPut = await run({ ...full, methods: ["GET", "HEAD"], headers: ["authorization"] });
  assert.match(noPut.report.checks.find((c) => c.name === "preflight PUT")!.message, /HTTP 403/);
  const wrongOrigin = await run({ ...full, origins: ["https://other.example"] });
  assert.equal(wrongOrigin.report.checks.find((c) => c.name === "allow-origin")!.status, "fail");

  const { fake, store } = await setup();
  try {
    await store.setCors(["https://app.example"]);
    assert.equal(fake.state.corsPut, true);
  } finally {
    fake.close();
  }
});

test("the CLI publishes a folder, skips unchanged archives, and prints or applies CORS", async () => {
  const run = promisify(execFile);
  const { fake } = await setup();
  const dir = await mkdtemp(join(tmpdir(), "pantry-"));
  await writeFile(join(dir, "My_Game.zip"), "one");
  await writeFile(join(dir, "other.zip"), "two");
  const env = { ...process.env, AWS_ACCESS_KEY_ID: "AKID", AWS_SECRET_ACCESS_KEY: "SECRET" };
  const flags = ["--endpoint", fake.endpoint, "--bucket", "bkt", "--region", "us-east-1", "--prefix", "games"];
  const cli = (...a: string[]) => run("node", ["src/cli.ts", ...a], { env });
  try {
    const first = await cli("publish", dir, ...flags);
    assert.match(first.stdout, /uploaded 3, skipped 0, deleted 0/);
    assert.deepEqual([...fake.objects.keys()].sort(), ["games/My_Game.zip", "games/other.zip", "games/repo.json"]);
    const { repo, warnings } = await loadRepo(`${fake.endpoint}/bkt/games/repo.json`);
    assert.deepEqual([repo.games.map((g) => g.id), warnings], [["my-game", "other"], []]);
    assert.match((await cli("publish", dir, ...flags)).stdout, /uploaded 1, skipped 2/);
    await assert.rejects(cli("publish", dir, ...flags, "--region", "eu-west-1"), /wrong region/);
    await assert.rejects(run("node", ["src/cli.ts", "publish", dir, ...flags], { env: { ...env, AWS_SECRET_ACCESS_KEY: "bad" } }));

    const shown = await cli("cors", ...flags);
    assert.match(shown.stdout, /put-bucket-cors/);
    await cli("cors", ...flags, "--apply");
    assert.equal(fake.state.corsPut, true);
  } finally {
    fake.close();
  }
});

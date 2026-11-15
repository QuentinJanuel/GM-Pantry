import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRepo, splitShards } from "../src/build.ts";
import { LIMITS, loadRepo, parseRepo, resolveUrl, validateHosting, verifyArchive } from "../src/index.ts";

const base = "https://example.com/games/repo.json";
const S = "0".repeat(64);
const sha = (b: string) => createHash("sha256").update(b).digest("hex");

/** A fetch that serves a map of path -> body under https://example.com/games/, counting requests. */
const fakeFetch = (files: Record<string, string>) => {
  const calls: string[] = [];
  const f = (async (u: string) => {
    calls.push(String(u));
    const body = files[new URL(String(u)).pathname.replace("/games/", "")];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { f, calls };
};

test("conformance fixtures", async () => {
  for (const name of await readdir("conformance")) {
    const dir = `conformance/${name}`;
    const files: Record<string, string> = {};
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) files[join(e.parentPath, e.name).slice(dir.length + 1)] = await readFile(join(e.parentPath, e.name), "utf8");
    }
    const expected = JSON.parse(files["expected.json"]);
    const { f } = fakeFetch(files);
    if (expected.error) {
      await assert.rejects(loadRepo(base, { fetch: f }), name);
      continue;
    }
    const { repo, warnings } = await loadRepo(base, { fetch: f });
    const games = Object.fromEntries(repo.games.map((g) => [g.id, g.versions.map((v) => v.version)]));
    assert.deepEqual(games, expected.games, name);
    assert.deepEqual(warnings.map((w) => w.path), expected.warnings, name);
  }
});

test("relative urls resolve against repo.json", () => {
  assert.equal(resolveUrl("a/b.zip", base), "https://example.com/games/a/b.zip");
  assert.equal(resolveUrl("/b.zip", base), "https://example.com/b.zip");
  assert.equal(resolveUrl("https://cdn.example/x.zip", base), "https://cdn.example/x.zip");
  const { repo } = parseRepo(
    { schema: 1, name: "n", updated: "2026-01-01", games: [{ id: "g", title: "G", versions: [{ version: "1", file: { url: "g.zip", sha256: S, size: 1 } }] }] },
    base,
  );
  assert.equal(repo.games[0].versions[0].file.url, "https://example.com/games/g.zip");
});

test("verifyArchive detects a mismatch", async () => {
  const bytes = new TextEncoder().encode("hello");
  const file = { sha256: sha("hello"), size: 5 };
  assert.deepEqual(await verifyArchive(bytes, file), { ok: true });
  assert.deepEqual(await verifyArchive(new Blob([bytes]).stream(), file), { ok: true });
  assert.equal((await verifyArchive(new TextEncoder().encode("hellO"), file)).ok, false);
  assert.deepEqual(await verifyArchive(bytes, { ...file, size: 6 }), { ok: false, reason: "size", expected: 6, actual: 5 });
});

test("build is deterministic and keeps hand edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pantry-"));
  await writeFile(join(dir, "My_Game.zip"), "one");
  await writeFile(join(dir, "other.7z"), "two");
  await buildRepo(dir, "Test", "2026-01-01T00:00:00.000Z");
  const first = await readFile(join(dir, "repo.json"), "utf8");
  const repo = JSON.parse(first);
  assert.deepEqual(repo.games.map((g: any) => [g.id, g.title]), [["my-game", "My Game"], ["other", "other"]]);
  assert.equal(repo.games[0].versions[0].file.sha256, sha("one"));

  // a rebuild with a later clock changes nothing, not even `updated`
  assert.equal((await buildRepo(dir, "Test", "2027-01-01T00:00:00.000Z")).changed, false);
  assert.equal(await readFile(join(dir, "repo.json"), "utf8"), first);

  // hand edits and unknown fields survive; a changed archive refreshes its hash and bumps `updated`
  repo.games[0].title = "Edited";
  repo.games[0].custom = 1;
  await writeFile(join(dir, "repo.json"), JSON.stringify(repo));
  await writeFile(join(dir, "My_Game.zip"), "uno");
  await buildRepo(dir, "Test", "2027-01-01T00:00:00.000Z");
  const next = JSON.parse(await readFile(join(dir, "repo.json"), "utf8"));
  assert.equal(next.games[0].title, "Edited");
  assert.equal(next.games[0].custom, 1);
  assert.equal(next.games[0].versions[0].file.sha256, sha("uno"));
  assert.equal(next.updated, "2027-01-01T00:00:00.000Z");
});

test("cli add and validate", async () => {
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), "pantry-"));
  const cli = (...a: string[]) => run("node", ["src/cli.ts", ...a]);
  await cli("init", dir, "--name", "T");
  await mkdir(join(dir, "sub"));
  await writeFile(join(dir, "sub", "A Game.zip"), "x");
  await cli("add", dir, join(dir, "sub", "A Game.zip"), "--version", "1.0");
  const repo = JSON.parse(await readFile(join(dir, "repo.json"), "utf8"));
  assert.equal(repo.games[0].versions[0].file.url, "sub/A%20Game.zip");
  await cli("validate", dir);
  await writeFile(join(dir, "sub", "A Game.zip"), "tampered");
  await assert.rejects(cli("validate", dir));
});

test("validateHosting reports CORS and Range", async () => {
  const body = "archive";
  const server = createServer((req, res) => {
    const cors = req.url!.startsWith("/nocors") ? {} : { "access-control-allow-origin": "*" };
    if (req.url!.endsWith("repo.json")) {
      res.writeHead(200, { ...cors, "content-type": "application/json", etag: '"x"' });
      res.end(JSON.stringify({ schema: 1, name: "n", updated: "2026-01-01", games: [{ id: "g", title: "G", versions: [{ version: "1", file: { url: "g.zip", sha256: sha(body), size: body.length } }] }] }));
    } else {
      res.writeHead(req.headers.range ? 206 : 200, { ...cors, "content-type": "application/zip" });
      res.end(body);
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const good = await validateHosting(`${root}/repo.json`);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.checks.find((c) => c.name === "archive range")!.status, "pass");
    const bad = await validateHosting(`${root}/nocors/repo.json`);
    assert.equal(bad.ok, false);
  } finally {
    server.close();
  }
});

const game = (id: string) => ({ id, title: id, versions: [{ version: "1", file: { url: `${id}.zip`, sha256: S, size: 1 } }] });
const entry = (shards: object[], games: object[] = []) => JSON.stringify({ schema: 1, name: "n", updated: "2026-01-01", games, shards });
const shardOf = (ids: string[]) => {
  const body = JSON.stringify({ games: ids.map(game) });
  return { body, ref: { url: `shards/${sha(body)}.json`, sha256: sha(body), size: body.length, count: ids.length } };
};

test("loadRepo merges inline then shards in order, with relative urls and a progress report", async () => {
  const a = shardOf(["a1", "a2"]);
  const b = shardOf(["b1"]);
  const { f } = fakeFetch({ "repo.json": entry([a.ref, b.ref], [game("inline")]), [a.ref.url]: a.body, [b.ref.url]: b.body });
  const progress: number[] = [];
  const { repo, warnings } = await loadRepo(base, { fetch: f, concurrency: 1, onProgress: (d) => progress.push(d) });
  assert.deepEqual(repo.games.map((g) => g.id), ["inline", "a1", "a2", "b1"]);
  assert.equal(repo.games[1].versions[0].file.url, "https://example.com/games/a1.zip");
  assert.equal(repo.shards![0].url, `https://example.com/games/${a.ref.url}`);
  assert.deepEqual(warnings, []);
  assert.deepEqual(progress, [1, 2]);
});

test("a hash-mismatched or missing shard is skipped, the rest loads", async () => {
  const a = shardOf(["a1"]);
  const b = shardOf(["b1"]);
  const c = shardOf(["c1"]);
  const { f } = fakeFetch({ "repo.json": entry([a.ref, b.ref, c.ref]), [a.ref.url]: a.body, [b.ref.url]: b.body.replace("b1", "b2") });
  const { repo, warnings } = await loadRepo(base, { fetch: f });
  assert.deepEqual(repo.games.map((g) => g.id), ["a1"]);
  assert.deepEqual(warnings.map((w) => w.path), ["shards[1]", "shards[2]"]);
});

test("a duplicate id across shards is skipped with a warning", async () => {
  const a = shardOf(["x", "y"]);
  const b = shardOf(["y", "z"]);
  const { f } = fakeFetch({ "repo.json": entry([a.ref, b.ref]), [a.ref.url]: a.body, [b.ref.url]: b.body });
  const { repo, warnings } = await loadRepo(base, { fetch: f });
  assert.deepEqual(repo.games.map((g) => g.id), ["x", "y", "z"]);
  assert.deepEqual(warnings.map((w) => w.path), ["shards[1].games[0]"]);
});

test("a shard cache hit skips the network, and a miss fills the cache", async () => {
  const a = shardOf(["a1"]);
  const store = new Map<string, Uint8Array>();
  const cache = { get: async (h: string) => store.get(h), put: async (h: string, b: Uint8Array) => void store.set(h, b) };
  const { f, calls } = fakeFetch({ "repo.json": entry([a.ref]), [a.ref.url]: a.body });
  await loadRepo(base, { fetch: f, shardCache: cache });
  assert.equal(calls.length, 2);
  assert.equal(store.size, 1);
  const again = await loadRepo(base, { fetch: f, shardCache: cache });
  assert.deepEqual(calls.length, 3); // repo.json only
  assert.equal(again.repo.games.length, 1);
});

test("a repo needs games or shards", () => {
  assert.throws(() => parseRepo({ schema: 1, name: "n", updated: "2026-01-01" }, base));
});

test("splitShards is deterministic, sorted and capped", () => {
  const games = ["c", "a", "e", "b", "d"].map(game);
  const one = splitShards(games, 2);
  const two = splitShards([...games].reverse(), 2);
  assert.deepEqual([...one.files], [...two.files]);
  assert.deepEqual(one.shards.map((s) => s.count), [2, 2, 1]);
  assert.deepEqual(JSON.parse([...one.files.values()][0]).games.map((g: any) => g.id), ["a", "b"]);
  assert.match(one.shards[0].url, /^shards\/[0-9a-f]{16}\.json$/);
});

test("build shards above the threshold, cleans stale shards, and stays inline below it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pantry-"));
  for (const n of ["a", "b", "c", "d", "e"]) await writeFile(join(dir, `${n}.zip`), n);
  const opts = { shardSize: 2 };
  const r1 = await buildRepo(dir, "T", "2026-01-01T00:00:00.000Z", opts);
  assert.equal(r1.shards, 3);
  const entry1 = await readFile(join(dir, "repo.json"), "utf8");
  const parsed = JSON.parse(entry1);
  assert.deepEqual(parsed.games, []);
  const names = (await readdir(join(dir, "shards"))).sort();
  assert.deepEqual(names, parsed.shards.map((s: any) => s.url.slice(7)).sort());
  // rebuild is byte-identical, `updated` included
  assert.equal((await buildRepo(dir, "T", "2027-01-01T00:00:00.000Z", opts)).changed, false);
  assert.equal(await readFile(join(dir, "repo.json"), "utf8"), entry1);
  // a changed archive makes one shard stale, and it is deleted
  await writeFile(join(dir, "a.zip"), "changed");
  await buildRepo(dir, "T", "2027-01-01T00:00:00.000Z", opts);
  const after = (await readdir(join(dir, "shards"))).sort();
  assert.equal(after.length, 3);
  assert.notDeepEqual(after, names);
  // an unrelated file in shards/ is left alone
  await writeFile(join(dir, "shards", "notes.txt"), "keep");
  // build still sees every game through the shards, and validate checks them
  await promisify(execFile)("node", ["src/cli.ts", "validate", dir]);
  // fewer games than the shard size: inline again, no generated shard left
  await buildRepo(dir, "T", "2027-01-01T00:00:00.000Z", { shardSize: 10 });
  assert.deepEqual(await readdir(join(dir, "shards")), ["notes.txt"]);
  assert.equal(JSON.parse(await readFile(join(dir, "repo.json"), "utf8")).games.length, 5);
});

test("--prune drops games whose archive is gone; the default keeps them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pantry-"));
  await writeFile(join(dir, "a.zip"), "a");
  await writeFile(join(dir, "b.zip"), "b");
  await buildRepo(dir, "T");
  await rm(join(dir, "b.zip"));
  assert.equal(JSON.parse((await buildRepo(dir, "T"), await readFile(join(dir, "repo.json"), "utf8"))).games.length, 2);
  const r = await buildRepo(dir, "T", undefined, { prune: true });
  assert.equal(r.pruned, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "repo.json"), "utf8")).games.map((g: any) => g.id), ["a"]);
});

test("15,000 games: a small entry file, shards under the cap, all loaded", async () => {
  const games = Array.from({ length: 15_000 }, (_, i) => ({
    ...game(`game-${String(i).padStart(5, "0")}`),
    title: `Synthetic game number ${i}`,
    meta: { author: "Someone", tags: ["platformer", "fangame"], description: "x".repeat(200) },
  }));
  const { files, shards } = splitShards(games, 1000);
  const entryJson = JSON.stringify({ schema: 1, name: "Big", updated: "2026-01-01", games: [], shards }, null, 2);
  const sizes = [...files.values()].map((c) => c.length);
  console.log(`15k: entry ${entryJson.length} B, ${shards.length} shards, ${Math.min(...sizes)}-${Math.max(...sizes)} B each`);
  assert.equal(shards.length, 15);
  assert.ok(entryJson.length < 5_000);
  assert.ok(shards.length <= LIMITS.shards && shards.every((s) => (s.count as number) <= LIMITS.gamesPerFile));
  const served: Record<string, string> = { "repo.json": entryJson };
  for (const [url, content] of files) served[url] = content;
  const { repo, warnings } = await loadRepo(base, { fetch: fakeFetch(served).f });
  assert.equal(repo.games.length, 15_000);
  assert.deepEqual(warnings, []);
});

test("validateHosting samples a shard when the repo is sharded", async () => {
  const a = shardOf(["a1"]);
  const server = createServer((req, res) => {
    const cors = req.url!.startsWith("/nocors") ? {} : { "access-control-allow-origin": "*" };
    if (req.url!.endsWith("repo.json")) {
      res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json", etag: '"x"' });
      res.end(entry([a.ref]));
    } else if (req.url!.includes("/shards/")) {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(a.body);
    } else {
      res.writeHead(206, { "access-control-allow-origin": "*", "content-type": "application/zip" });
      res.end("x");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const good = await validateHosting(`${root}/repo.json`);
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.checks.find((c) => c.name === "shard cors")!.status, "pass");
    assert.equal(good.checks.find((c) => c.name === "archive")!.status, "pass");
  } finally {
    server.close();
  }
});

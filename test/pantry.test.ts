import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRepo } from "../src/build.ts";
import { parseRepo, resolveUrl, validateHosting, verifyArchive } from "../src/index.ts";

const base = "https://example.com/games/repo.json";
const S = "0".repeat(64);
const sha = (b: string) => createHash("sha256").update(b).digest("hex");

test("conformance fixtures", async () => {
  for (const name of await readdir("conformance")) {
    const json = JSON.parse(await readFile(`conformance/${name}/repo.json`, "utf8"));
    const expected = JSON.parse(await readFile(`conformance/${name}/expected.json`, "utf8"));
    if (expected.error) {
      assert.throws(() => parseRepo(json, base));
      continue;
    }
    const { repo, warnings } = parseRepo(json, base);
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

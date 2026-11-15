import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRepo, addVersion, emptyRepo, inlineShards, loadRepo, removeGame, removeVersion, serialize, updateGame } from "../src/index.ts";

const S = "0".repeat(64);
const file = (url: string) => ({ url, sha256: S, size: 1 });
const NOW = "2026-01-01T00:00:00.000Z";

test("addVersion creates a game, extends it newest first, and refreshes a known url", () => {
  const repo = emptyRepo("T", NOW);
  addVersion(repo, { title: "My Game", file: file("a.zip") });
  assert.equal(repo.games[0].id, "my-game");
  addVersion(repo, { id: "my-game", version: "2.0", notes: "n", file: file("b.zip") });
  assert.deepEqual(repo.games[0].versions.map((v: any) => v.version), ["2.0", "1"]);
  assert.equal(repo.games[0].versions[0].notes, "n");
  addVersion(repo, { id: "my-game", file: { url: "a.zip", sha256: "f".repeat(64), size: 9 } });
  assert.equal(repo.games[0].versions.length, 2);
  assert.deepEqual(repo.games[0].versions[1].file, { url: "a.zip", sha256: "f".repeat(64), size: 9 });
  assert.throws(() => addVersion(repo, { id: "my-game", version: "2.0", file: file("c.zip") }), /already has/);
  assert.throws(() => addVersion(repo, { id: "new", file: file("d.zip") }), /title/);
  addVersion(repo, { title: "Zed", work: { delfruit: 1 }, file: file("z.zip") });
  addVersion(repo, { title: "Alpha", file: file("al.zip") });
  assert.deepEqual(repo.games.map((g: any) => g.id), ["alpha", "my-game", "zed"]);
});

test("removeVersion, removeGame and updateGame", () => {
  const repo = emptyRepo("T", NOW);
  addVersion(repo, { title: "G", meta: { author: "a", tags: ["x"] }, work: { delfruit: 1, other: 2 }, file: file("a.zip") });
  addVersion(repo, { id: "g", file: file("b.zip") });
  updateGame(repo, "g", { title: "Renamed", meta: { author: null, description: "d" }, work: { other: null } });
  assert.deepEqual(repo.games[0].meta, { tags: ["x"], description: "d" });
  assert.deepEqual(repo.games[0].work, { delfruit: 1 });
  assert.equal(repo.games[0].title, "Renamed");
  updateGame(repo, "g", { work: null });
  assert.equal("work" in repo.games[0], false);
  assert.throws(() => updateGame(repo, "nope", {}));
  assert.equal(removeVersion(repo, "g", "2"), true);
  assert.equal(removeVersion(repo, "g", "2"), false);
  assert.equal(repo.games.length, 1);
  assert.equal(removeVersion(repo, "g", "1"), true); // last version takes the game with it
  assert.equal(repo.games.length, 0);
  addVersion(repo, { title: "H", file: file("h.zip") });
  assert.equal(removeGame(repo, "h"), true);
  assert.equal(removeGame(repo, "h"), false);
});

test("serialize is deterministic, keeps `updated` when nothing changed, and reports orphan shards", async () => {
  const repo = emptyRepo("T", NOW);
  for (const t of ["c", "a", "b"]) addVersion(repo, { title: t, file: file(`${t}.zip`) });
  const one = await serialize(repo, { shardSize: 1, now: NOW });
  const reversed = { ...repo, games: [...repo.games].reverse() };
  const two = await serialize(reversed, { shardSize: 1, now: NOW });
  assert.equal(one.repoJson, two.repoJson);
  assert.deepEqual([...one.shards], [...two.shards]);
  assert.equal(one.shards.size, 3);
  assert.deepEqual(one.orphans, []);

  const previous = JSON.parse(one.repoJson);
  const same = await serialize(repo, { shardSize: 1, previous, now: "2030-01-01T00:00:00.000Z" });
  assert.equal(same.repoJson, one.repoJson);

  addVersion(repo, { id: "a", file: file("a2.zip") });
  const next = await serialize(repo, { shardSize: 1, previous, now: "2030-01-01T00:00:00.000Z" });
  assert.equal(JSON.parse(next.repoJson).updated, "2030-01-01T00:00:00.000Z");
  assert.equal(next.orphans.length, 1);
  assert.ok(previous.shards.some((s: any) => s.url === next.orphans[0]));
  // back to inline: every previous shard is an orphan, and the file has no shards key
  const inline = await serialize(repo, { shardSize: 10, previous, now: NOW });
  assert.equal(inline.orphans.length, 3);
  assert.equal(JSON.parse(inline.repoJson).shards, undefined);
  await assert.rejects(serialize(JSON.parse(one.repoJson)), /inlineShards/);
  await assert.rejects(serialize(repo, { shardSize: 0 }));
});

test("inlineShards makes a sharded repo editable and round-trips", async () => {
  const repo = emptyRepo("T", NOW);
  for (const t of ["a", "b", "c"]) addVersion(repo, { title: t, file: file(`${t}.zip`) });
  const out = await serialize(repo, { shardSize: 2, now: NOW });
  const entry = JSON.parse(out.repoJson);
  await inlineShards(entry, async (url) => out.shards.get(url)!);
  assert.deepEqual(entry.games.map((g: any) => g.id), ["a", "b", "c"]);
  assert.equal((await serialize(entry, { shardSize: 2, previous: JSON.parse(out.repoJson), now: "2031-01-01T00:00:00.000Z" })).repoJson, out.repoJson);
  await assert.rejects(inlineShards({ shards: [{ url: "shards/x.json" }] }, async () => "nope"), /unreadable/);
});

test("15,000 games built with the operations serialize deterministically and load back", async () => {
  const repo = emptyRepo("Big", NOW);
  for (let i = 0; i < 15_000; i++) addVersion(repo, { id: `game-${String(i).padStart(5, "0")}`, title: `Game ${i}`, meta: { author: "x" }, file: file(`g${i}.zip`) });
  const a = await serialize(repo, { now: NOW });
  const b = await serialize({ ...repo, games: [...repo.games].reverse() }, { now: NOW });
  assert.equal(a.repoJson, b.repoJson);
  assert.equal(a.shards.size, 15);
  const served: Record<string, string> = { "repo.json": a.repoJson };
  for (const [url, content] of a.shards) served[url] = content;
  const f = (async (u: string) => {
    const body = served[new URL(String(u)).pathname.slice(1)];
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  }) as typeof fetch;
  const { repo: loaded, warnings } = await loadRepo("https://example.com/repo.json", { fetch: f });
  assert.equal(loaded.games.length, 15_000);
  assert.deepEqual(warnings, []);
});

test("contents and readme travel with a version, survive parsing, and bad ones are dropped", () => {
  const repo = emptyRepo("T", NOW);
  const contents = [{ path: "game.exe", size: 10 }];
  addVersion(repo, { title: "G", file: file("https://e.com/a.zip"), contents, readme: "hello" });
  const ok = parseRepo(JSON.parse(JSON.stringify(repo)), "https://e.com/repo.json");
  assert.deepEqual(ok.repo.games[0].versions[0].contents, contents);
  assert.equal(ok.repo.games[0].versions[0].readme, "hello");
  // refreshing the same archive updates them
  addVersion(repo, { title: "G", file: file("https://e.com/a.zip"), readme: "bye" });
  assert.equal(repo.games[0].versions[0].readme, "bye");
  repo.games[0].versions[0].contents = [{ path: "", size: -1 }];
  const bad = parseRepo(JSON.parse(JSON.stringify(repo)), "https://e.com/repo.json");
  assert.equal(bad.repo.games[0].versions[0].contents, undefined);
  assert.equal(bad.warnings.length, 1);
});

// Writing a repo.json (SPEC.md §7): node-only, kept out of the library entry point.
// Works on the raw JSON, never on a parsed Repo, so hand-edited fields and unknown fields survive.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { LIMITS } from "./parse.ts";

type Json = Record<string, any>;

export const ARCHIVE_EXTENSIONS = [".zip", ".7z", ".rar"];

export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

const byId = (a: Json, b: Json) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const SHARD_FILE = /^[0-9a-f]{16}\.json$/;
const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|\/)/i.test(url);

export const slug = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** "My_Game-v2.zip" -> "My Game-v2" */
const titleOf = (file: string) => basename(file, extname(file)).replace(/_+/g, " ").trim();

export async function readRepoJson(dir: string): Promise<Json | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "repo.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`repo.json in ${dir} is unreadable: ${(e as Error).message}`);
  }
}

export function emptyRepo(name: string): Json {
  return { schema: 1, name, updated: new Date().toISOString(), games: [] };
}

/** Adds an archive, or refreshes sha256 and size of the version that already points at it. */
export function upsertArchive(
  repo: Json,
  url: string,
  hashed: { sha256: string; size: number },
  opts: { id?: string; title?: string; version?: string } = {},
): void {
  const file = { url, ...hashed };
  const games: Json[] = (repo.games ??= []);
  for (const game of games) {
    for (const v of game.versions ?? []) {
      if (v.file?.url === url) {
        v.file = { ...v.file, ...hashed };
        return;
      }
    }
  }
  const id = opts.id ?? slug(titleOf(decodeURIComponent(url)));
  if (id === "") throw new Error(`cannot derive an id from ${url}; pass --id`);
  let game = games.find((g) => g.id === id);
  if (!game) {
    game = { id, title: opts.title ?? titleOf(decodeURIComponent(url)), versions: [] };
    games.push(game);
    games.sort(byId);
  }
  game.versions.unshift({ version: opts.version ?? String(game.versions.length + 1), file });
}

/** Serialises repo.json; `updated` moves only when something else changed, so a rebuild is byte-identical. */
export async function writeRepoJson(dir: string, repo: Json, now = new Date().toISOString()): Promise<boolean> {
  const before = await readFile(join(dir, "repo.json"), "utf8").catch(() => undefined);
  const stable = (r: Json) => JSON.stringify({ ...r, updated: undefined });
  let old: Json | undefined;
  try { old = before ? JSON.parse(before) : undefined; } catch { /* rewritten below */ }
  const next = { ...repo, updated: old && stable(old) === stable(repo) ? old.updated : now };
  const out = JSON.stringify(next, null, 2) + "\n";
  if (out === before) return false;
  await writeFile(join(dir, "repo.json"), out);
  return true;
}

/** Every archive in `dir` (top level only), by name, as repo-relative urls. */
export async function listArchives(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && ARCHIVE_EXTENSIONS.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

/** Splits games, sorted by id, into content-addressed shard files of at most `size` games (SPEC.md §3.7). Pure: same input, same bytes. */
export function splitShards(games: Json[], size: number): { files: Map<string, string>; shards: Json[] } {
  const sorted = [...games].sort(byId);
  const files = new Map<string, string>();
  const shards: Json[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const chunk = sorted.slice(i, i + size);
    const content = JSON.stringify({ games: chunk }) + "\n";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const url = `shards/${sha256.slice(0, 16)}.json`;
    files.set(url, content);
    shards.push({ url, sha256, size: Buffer.byteLength(content), count: chunk.length });
  }
  return { files, shards };
}

/** Moves the games of a sharded repo.json inline, so build can edit one flat list. */
async function inlineShards(dir: string, repo: Json): Promise<void> {
  for (const shard of repo.shards ?? []) {
    if (!isRelative(shard.url)) throw new Error(`shard ${shard.url} is not a relative url; build can only rewrite shards inside ${dir}`);
    const file = join(dir, decodeURIComponent(shard.url));
    try {
      (repo.games ??= []).push(...JSON.parse(await readFile(file, "utf8")).games);
    } catch (e) {
      throw new Error(`shard ${file} is unreadable: ${(e as Error).message}`);
    }
  }
  delete repo.shards;
}

/** Drops versions whose relative archive url no longer exists in `dir`, then games left with none. */
async function pruneMissing(dir: string, repo: Json): Promise<number> {
  for (const game of repo.games) {
    const kept: Json[] = [];
    for (const v of game.versions ?? []) {
      const url: string = v.file?.url ?? "";
      if (!isRelative(url) || (await stat(join(dir, decodeURIComponent(url))).then(() => true, () => false))) kept.push(v);
    }
    game.versions = kept;
  }
  const before = repo.games.length;
  repo.games = repo.games.filter((g: Json) => g.versions.length > 0);
  return before - repo.games.length;
}

export interface BuildOptions {
  /** Games per shard; at or below this many games the output stays inline. Default 1000. */
  shardSize?: number;
  /** Remove games whose archive file is gone from the folder. By default entries are kept. */
  prune?: boolean;
}

export async function buildRepo(
  dir: string,
  name?: string,
  now?: string,
  { shardSize = 1000, prune = false }: BuildOptions = {},
): Promise<{ changed: boolean; count: number; shards: number; pruned: number }> {
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > LIMITS.gamesPerFile) {
    throw new Error(`--shard-size must be an integer from 1 to ${LIMITS.gamesPerFile}`);
  }
  const repo = (await readRepoJson(dir)) ?? emptyRepo(name ?? basename(dir));
  await inlineShards(dir, repo);
  const files = await listArchives(dir);
  for (const f of files) upsertArchive(repo, encodeURIComponent(f), await hashFile(join(dir, f)));
  const pruned = prune ? await pruneMissing(dir, repo) : 0;

  let out = repo;
  let written = new Map<string, string>();
  if (repo.games.length > shardSize) {
    const { files: shardFiles, shards } = splitShards(repo.games, shardSize);
    if (shards.length > LIMITS.shards) throw new Error(`${shards.length} shards exceeds the cap of ${LIMITS.shards}; raise --shard-size`);
    await mkdir(join(dir, "shards"), { recursive: true });
    for (const [url, content] of shardFiles) await writeFile(join(dir, url), content);
    written = shardFiles;
    out = { ...repo, games: [], shards };
  }
  const changed = await writeRepoJson(dir, out, now);
  // Only files shaped like ours are touched; anything else in shards/ is the owner's.
  for (const f of await readdir(join(dir, "shards")).catch(() => [])) {
    if (SHARD_FILE.test(f) && !written.has(`shards/${f}`)) await rm(join(dir, "shards", f));
  }
  return { changed, count: files.length, shards: written.size, pruned };
}

/** The repo-relative url of an archive that must live inside the repo directory. */
export async function relativeUrl(dir: string, archive: string): Promise<string> {
  await stat(archive);
  const rel = relative(dir, archive);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`${archive} is outside the repo directory ${dir}`);
  return rel.split(sep).map(encodeURIComponent).join("/");
}

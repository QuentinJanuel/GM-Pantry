// Editing and writing a repo.json (SPEC.md §3, §3.7) in memory. Browser-safe: no filesystem, no Node APIs.
// Works on the raw JSON, never on a parsed Repo, so hand-edited fields and unknown fields survive.

import { sha256Hex } from "./hash.ts";
import { LIMITS } from "./parse.ts";

export type Json = Record<string, any>;

const byId = (a: Json, b: Json) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const GENERATED_SHARD = /^shards\/[0-9a-f]{16}\.json$/;
const encoder = new TextEncoder();

export const slug = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** "dir/My_Game-v2.zip" -> "My Game-v2" */
export const titleOf = (file: string) => (file.split("/").pop() ?? file).replace(/\.[^.]*$/, "").replace(/_+/g, " ").trim();

export function emptyRepo(name: string, now = new Date().toISOString()): Json {
  return { schema: 1, name, updated: now, games: [] };
}

export interface NewVersion {
  /** Game id; defaults to the slug of `title`. */
  id?: string;
  /** Required when the game does not exist yet. */
  title?: string;
  work?: Record<string, string | number>;
  meta?: Json;
  /** Version label; defaults to the first unused number. */
  version?: string;
  notes?: string;
  released?: string;
  /** What is inside the archive (paths relative to its root) and its README text, if any. */
  contents?: { path: string; size: number }[];
  readme?: string;
  format?: string;
  file: { url: string; sha256: string; size: number };
}

/** Adds a version (newest first) to its game, creating the game if needed; a version already pointing at `file.url` just gets its hash and size refreshed. */
export function addVersion(repo: Json, v: NewVersion): Json {
  const games: Json[] = (repo.games ??= []);
  for (const game of games) {
    for (const old of game.versions ?? []) {
      if (old.file?.url === v.file.url) {
        old.file = { ...old.file, sha256: v.file.sha256, size: v.file.size };
        if (v.contents) old.contents = v.contents;
        if (v.readme) old.readme = v.readme;
        return game;
      }
    }
  }
  const id = v.id ?? slug(v.title ?? "");
  if (id === "") throw new Error("cannot derive a game id; pass an id or a title");
  let game = games.find((g) => g.id === id);
  if (!game) {
    if (!v.title) throw new Error(`game ${id} does not exist; a title is needed to create it`);
    game = { id, title: v.title, ...(v.work && { work: v.work }), ...(v.meta && { meta: v.meta }), versions: [] };
    games.push(game);
    games.sort(byId);
  }
  const taken = new Set(game.versions.map((x: Json) => x.version));
  let label = v.version;
  if (label === undefined) for (let n = game.versions.length + 1; taken.has((label = String(n))); n++);
  else if (taken.has(label)) throw new Error(`game ${id} already has a version ${label}`);
  const { notes, released, format, file, contents, readme } = v;
  game.versions.unshift({ version: label, file, ...(format && { format }), ...(notes && { notes }), ...(contents && { contents }), ...(readme && { readme }), ...(released && { released }) });
  return game;
}

/** Adds an archive by its url, deriving the game id and title from the file name. */
export function upsertArchive(
  repo: Json,
  url: string,
  hashed: { sha256: string; size: number },
  opts: { id?: string; title?: string; version?: string } = {},
): void {
  const title = opts.title ?? titleOf(decodeURIComponent(url));
  addVersion(repo, { ...opts, id: opts.id ?? slug(titleOf(decodeURIComponent(url))), title, file: { url, ...hashed } });
}

/** Drops one version; a game left with none is dropped too. False when nothing matched. */
export function removeVersion(repo: Json, gameId: string, version: string): boolean {
  const game = (repo.games ?? []).find((g: Json) => g.id === gameId);
  const i = game?.versions.findIndex((v: Json) => v.version === version) ?? -1;
  if (i < 0) return false;
  game.versions.splice(i, 1);
  if (game.versions.length === 0) removeGame(repo, gameId);
  return true;
}

export function removeGame(repo: Json, gameId: string): boolean {
  const before = repo.games?.length ?? 0;
  repo.games = (repo.games ?? []).filter((g: Json) => g.id !== gameId);
  return repo.games.length < before;
}

export interface GamePatch {
  title?: string;
  /** Merged key by key; a key set to null is removed, `null` for the whole object removes it. */
  work?: Record<string, string | number | null> | null;
  meta?: Json | null;
}

export function updateGame(repo: Json, gameId: string, patch: GamePatch): Json {
  const game = (repo.games ?? []).find((g: Json) => g.id === gameId);
  if (!game) throw new Error(`no game ${gameId}`);
  if (patch.title !== undefined) game.title = patch.title;
  for (const key of ["work", "meta"] as const) {
    const p = patch[key];
    if (p === undefined) continue;
    if (p === null) { delete game[key]; continue; }
    game[key] = { ...game[key], ...p };
    for (const k of Object.keys(game[key])) if (game[key][k] === null) delete game[key][k];
    if (Object.keys(game[key]).length === 0) delete game[key];
  }
  return game;
}

/** Moves the games of a sharded repo.json inline, so one flat list can be edited. `readShard` returns a shard file's text by its (repo-relative) url. */
export async function inlineShards(repo: Json, readShard: (url: string) => Promise<string>): Promise<void> {
  for (const shard of repo.shards ?? []) {
    try {
      (repo.games ??= []).push(...JSON.parse(await readShard(shard.url)).games);
    } catch (e) {
      throw new Error(`shard ${shard.url} is unreadable: ${(e as Error).message}`);
    }
  }
  delete repo.shards;
}

/** Splits games, sorted by id, into content-addressed shard files of at most `size` games (SPEC.md §3.7). Pure: same input, same bytes. */
export async function splitShards(games: Json[], size: number): Promise<{ files: Map<string, string>; shards: Json[] }> {
  const sorted = [...games].sort(byId);
  const files = new Map<string, string>();
  const shards: Json[] = [];
  for (let i = 0; i < sorted.length; i += size) {
    const chunk = sorted.slice(i, i + size);
    const content = JSON.stringify({ games: chunk }) + "\n";
    const bytes = encoder.encode(content);
    const sha256 = await sha256Hex(bytes);
    const url = `shards/${sha256.slice(0, 16)}.json`;
    files.set(url, content);
    shards.push({ url, sha256, size: bytes.byteLength, count: chunk.length });
  }
  return { files, shards };
}

export interface SerializeOptions {
  /** Games per shard; at or below this many games the output stays inline. Default 1000. */
  shardSize?: number;
  /** The repo.json this one replaces, as parsed JSON. `updated` is kept when nothing else changed, and the shards it listed that are no longer used are reported as orphans. */
  previous?: Json;
  now?: string;
}

export interface Serialized {
  /** The bytes of repo.json. */
  repoJson: string;
  /** Shard files to write, by repo-relative url. */
  shards: Map<string, string>;
  /** Generated shards (`shards/<sha16>.json`) the previous repo.json listed that this one does not: delete them after repo.json is live. */
  orphans: string[];
}

/** Serialises a flat repo. Byte-identical for the same input, and `updated` moves only when something else changed. */
export async function serialize(repo: Json, { shardSize = 1000, previous, now = new Date().toISOString() }: SerializeOptions = {}): Promise<Serialized> {
  if (!Number.isInteger(shardSize) || shardSize < 1 || shardSize > LIMITS.gamesPerFile) {
    throw new Error(`shard size must be an integer from 1 to ${LIMITS.gamesPerFile}`);
  }
  if (repo.shards?.length) throw new Error("repo has shards; inlineShards first");
  let out: Json = repo;
  let shardFiles = new Map<string, string>();
  if ((repo.games?.length ?? 0) > shardSize) {
    const { files, shards } = await splitShards(repo.games, shardSize);
    if (shards.length > LIMITS.shards) throw new Error(`${shards.length} shards exceeds the cap of ${LIMITS.shards}; raise the shard size`);
    shardFiles = files;
    out = { ...repo, games: [], shards };
  }
  const stable = (r: Json) => JSON.stringify({ ...r, updated: undefined });
  const next = { ...out, updated: previous && stable(previous) === stable(out) ? previous.updated : now };
  const orphans = (previous?.shards ?? []).map((s: Json) => s.url).filter((u: string) => GENERATED_SHARD.test(u) && !shardFiles.has(u));
  return { repoJson: JSON.stringify(next, null, 2) + "\n", shards: shardFiles, orphans };
}

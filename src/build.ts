// Building a repo.json from a folder (SPEC.md §3.7): node-only, kept out of the library entry point. The editing and serialising live in builder.ts.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { emptyRepo, inlineShards, serialize, upsertArchive, type Json } from "./builder.ts";

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

const SHARD_FILE = /^[0-9a-f]{16}\.json$/;
const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|\/)/i.test(url);

export async function readRepoJson(dir: string): Promise<Json | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "repo.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`repo.json in ${dir} is unreadable: ${(e as Error).message}`);
  }
}

/** Writes repo.json unless it already holds exactly these bytes; true when it changed. */
export async function writeRepoJson(dir: string, repoJson: string): Promise<boolean> {
  if (repoJson === (await readFile(join(dir, "repo.json"), "utf8").catch(() => undefined))) return false;
  await writeFile(join(dir, "repo.json"), repoJson);
  return true;
}

/** Every archive in `dir` (top level only), by name, as repo-relative urls. */
export async function listArchives(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isFile() && ARCHIVE_EXTENSIONS.includes(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

/** Moves the games of a sharded repo.json inline, so build can edit one flat list. */
async function inline(dir: string, repo: Json): Promise<void> {
  for (const shard of repo.shards ?? []) {
    if (!isRelative(shard.url)) throw new Error(`shard ${shard.url} is not a relative url; build can only rewrite shards inside ${dir}`);
  }
  await inlineShards(repo, (url) => readFile(join(dir, decodeURIComponent(url)), "utf8"));
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
  const repo = (await readRepoJson(dir)) ?? emptyRepo(name ?? basename(dir), now);
  const previous = structuredClone(repo);
  await inline(dir, repo);
  const files = await listArchives(dir);
  for (const f of files) upsertArchive(repo, encodeURIComponent(f), await hashFile(join(dir, f)));
  const pruned = prune ? await pruneMissing(dir, repo) : 0;

  const out = await serialize(repo, { shardSize, previous, now });
  if (out.shards.size) await mkdir(join(dir, "shards"), { recursive: true });
  for (const [url, content] of out.shards) await writeFile(join(dir, url), content);
  const written = out.shards;
  const changed = await writeRepoJson(dir, out.repoJson);
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

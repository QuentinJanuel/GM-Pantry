// Writing a repo.json (SPEC.md §7): node-only, kept out of the library entry point.
// Works on the raw JSON, never on a parsed Repo, so hand-edited fields and unknown fields survive.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";

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
    games.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

export async function buildRepo(dir: string, name?: string, now?: string): Promise<{ changed: boolean; count: number }> {
  const repo = (await readRepoJson(dir)) ?? emptyRepo(name ?? basename(dir));
  const files = await listArchives(dir);
  for (const f of files) upsertArchive(repo, encodeURIComponent(f), await hashFile(join(dir, f)));
  return { changed: await writeRepoJson(dir, repo, now), count: files.length };
}

/** The repo-relative url of an archive that must live inside the repo directory. */
export async function relativeUrl(dir: string, archive: string): Promise<string> {
  await stat(archive);
  const rel = relative(dir, archive);
  if (rel.startsWith("..") || rel.startsWith(sep)) throw new Error(`${archive} is outside the repo directory ${dir}`);
  return rel.split(sep).map(encodeURIComponent).join("/");
}

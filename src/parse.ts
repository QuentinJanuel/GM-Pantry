// SPEC.md §4 and §5: reading a repo.json. Entries that are malformed are skipped and reported;
// advisory fields that are malformed are dropped and reported. Only a broken envelope throws.

import type { ArchiveFile, Format, Game, Meta, Repo, Shard, Version, Warning } from "./types.ts";

/** The caps of SPEC.md §4.4. */
export const LIMITS = {
  name: 80,
  repoDescription: 280,
  gamesPerFile: 2000,
  shards: 1000,
  id: 64,
  title: 200,
  versions: 200,
  versionLabel: 64,
  url: 2048,
  iconData: 16384,
  metaText: 2000,
  author: 120,
  notes: 2000,
  contents: 2000,
  contentPath: 260,
  readme: 20000,
  tags: 20,
  tag: 40,
  screenshots: 20,
  links: 20,
  linkName: 80,
  work: 8,
  workKey: 32,
  workText: 128,
} as const;

export class RepoError extends Error {}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WORK_KEY = /^[a-z][a-z0-9_-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/;
const FORMATS = ["zip", "7z", "rar"];
/** An icon carried inside repo.json: a raster image only (no SVG, which can hold script). */
const DATA_ICON = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Resolves a possibly relative url against the url of repo.json. Returns undefined if it is not a url. */
export function resolveUrl(url: string, baseUrl: string): string | undefined {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return undefined;
  }
}

/** https, or http on a loopback host (so a repo can be tried locally). */
export function isSecureUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > LIMITS.url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ||
      (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() !== "" && v.trim().length <= max ? v.trim() : undefined;

const validDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !isNaN(Date.parse(v));

/** Parses a repo.json already decoded from JSON. `baseUrl` is where it was fetched from. Throws RepoError. */
export function parseRepo(json: unknown, baseUrl: string): { repo: Repo; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const warn = (path: string, message: string) => warnings.push({ path, message });
  if (!isObject(json)) throw new RepoError("repo.json is not an object");
  if (json.schema !== 1) throw new RepoError(`unsupported schema ${JSON.stringify(json.schema)}; this reader implements 1`);
  const name = text(json.name, LIMITS.name);
  if (name === undefined) throw new RepoError(`"name" must be a non-empty string of at most ${LIMITS.name} characters`);
  if (!validDate(json.updated)) throw new RepoError(`"updated" must be an ISO-8601 date or timestamp`);
  if (json.games === undefined && json.shards === undefined) throw new RepoError(`"games" or "shards" must be present`);
  if (json.games !== undefined && !Array.isArray(json.games)) throw new RepoError(`"games" must be an array`);
  if (json.shards !== undefined && !Array.isArray(json.shards)) throw new RepoError(`"shards" must be an array`);

  const repo: Repo = { schema: 1, name, updated: json.updated, games: [] };
  const description = text(json.description, LIMITS.repoDescription);
  if (description) repo.description = description;
  else if (json.description !== undefined) warn("description", "dropped: not a string of 1-280 characters");
  if (isSecureUrl(json.homepage)) repo.homepage = json.homepage;
  else if (json.homepage !== undefined) warn("homepage", "dropped: not an https url");

  if (typeof json.icon === "string" && json.icon.startsWith("data:")) {
    if (json.icon.length <= LIMITS.iconData && DATA_ICON.test(json.icon)) repo.icon = json.icon;
    else warn("icon", "dropped: a data url must be a base64 png, jpeg or webp of at most 16384 characters");
  } else if (typeof json.icon === "string" && json.icon.length <= LIMITS.url) {
    const icon = resolveUrl(json.icon, baseUrl);
    if (icon !== undefined && isSecureUrl(icon)) repo.icon = icon;
    else warn("icon", "dropped: not an https url");
  } else if (json.icon !== undefined) warn("icon", "dropped: not an https url");

  repo.games = parseGames(json.games ?? [], baseUrl, new Set(), warn);
  if (json.shards) {
    const shards: Shard[] = [];
    json.shards.slice(0, LIMITS.shards).forEach((entry, i) => {
      const shard = parseShardRef(entry, `shards[${i}]`, baseUrl, warn);
      if (shard) shards.push(shard);
    });
    if (json.shards.length > LIMITS.shards) warn("shards", `only the first ${LIMITS.shards} entries are read`);
    if (shards.length) repo.shards = shards;
  }
  return { repo, warnings };
}

/** Parses a shard file already decoded from JSON (SPEC.md §3.7). `baseUrl` is the url of repo.json, not of the shard. `seen` carries ids already taken elsewhere in the repo. Throws RepoError. */
export function parseShard(json: unknown, baseUrl: string, seen = new Set<string>()): { games: Game[]; warnings: Warning[] } {
  const warnings: Warning[] = [];
  if (!isObject(json) || !Array.isArray(json.games)) throw new RepoError(`a shard must be an object with a "games" array`);
  const games = parseGames(json.games, baseUrl, seen, (path, message) => warnings.push({ path, message }));
  return { games, warnings };
}

function parseGames(list: unknown[], baseUrl: string, seen: Set<string>, warn: (p: string, m: string) => void): Game[] {
  const games: Game[] = [];
  list.slice(0, LIMITS.gamesPerFile).forEach((entry, i) => {
    const path = `games[${i}]`;
    const game = parseGame(entry, path, baseUrl, warn);
    if (!game) return;
    if (seen.has(game.id)) return warn(path, `skipped: duplicate id "${game.id}"`);
    seen.add(game.id);
    games.push(game);
  });
  if (list.length > LIMITS.gamesPerFile) warn("games", `only the first ${LIMITS.gamesPerFile} entries are read`);
  return games;
}

function parseShardRef(entry: unknown, path: string, baseUrl: string, warn: (p: string, m: string) => void): Shard | undefined {
  if (!isObject(entry)) return void warn(path, "skipped: not an object");
  const url = typeof entry.url === "string" && entry.url.length <= LIMITS.url ? resolveUrl(entry.url, baseUrl) : undefined;
  if (url === undefined || !isSecureUrl(url)) return void warn(path, `skipped: "url" must resolve to an https url`);
  if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) return void warn(path, `skipped: "sha256" must be 64 lowercase hex digits`);
  if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) return void warn(path, `skipped: "size" must be a non-negative integer`);
  const shard: Shard = { url, sha256: entry.sha256, size: entry.size as number };
  if (Number.isSafeInteger(entry.count) && (entry.count as number) >= 0) shard.count = entry.count as number;
  else if (entry.count !== undefined) warn(`${path}.count`, "dropped: not a non-negative integer");
  return shard;
}

function parseGame(entry: unknown, path: string, baseUrl: string, warn: (p: string, m: string) => void): Game | undefined {
  if (!isObject(entry)) return void warn(path, "skipped: not an object");
  if (typeof entry.id !== "string" || entry.id.length > LIMITS.id || !ID.test(entry.id)) {
    return void warn(path, `skipped: "id" must match ${ID} and be at most ${LIMITS.id} characters`);
  }
  const title = text(entry.title, LIMITS.title);
  if (title === undefined) return void warn(path, `skipped: "title" must be a non-empty string of at most ${LIMITS.title} characters`);
  if (!Array.isArray(entry.versions)) return void warn(path, `skipped: "versions" must be an array`);
  const versions: Version[] = [];
  entry.versions.slice(0, LIMITS.versions).forEach((v, i) => {
    const version = parseVersion(v, `${path}.versions[${i}]`, baseUrl, warn);
    if (version) versions.push(version);
  });
  if (versions.length === 0) return void warn(path, "skipped: no valid version");
  const game: Game = { id: entry.id, title, versions };
  const work = parseWork(entry.work);
  if (work) game.work = work;
  else if (entry.work !== undefined) warn(`${path}.work`, "dropped: not an object of short string or integer values");
  if (entry.meta !== undefined) game.meta = parseMeta(entry.meta, `${path}.meta`, baseUrl, warn);
  return game;
}

function parseVersion(v: unknown, path: string, baseUrl: string, warn: (p: string, m: string) => void): Version | undefined {
  if (!isObject(v)) return void warn(path, "skipped: not an object");
  const label = text(v.version, LIMITS.versionLabel);
  if (label === undefined) return void warn(path, `skipped: "version" must be a non-empty string of at most ${LIMITS.versionLabel} characters`);
  const f = v.file;
  if (!isObject(f)) return void warn(path, `skipped: "file" must be an object`);
  if (typeof f.url !== "string" || f.url.length > LIMITS.url) return void warn(path, `skipped: "file.url" must be a url`);
  const url = resolveUrl(f.url, baseUrl);
  if (url === undefined || !isSecureUrl(url)) return void warn(path, `skipped: "file.url" must resolve to an https url`);
  if (typeof f.sha256 !== "string" || !SHA256.test(f.sha256)) return void warn(path, `skipped: "file.sha256" must be 64 lowercase hex digits`);
  if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) return void warn(path, `skipped: "file.size" must be a non-negative integer`);
  const file: ArchiveFile = { url, sha256: f.sha256, size: f.size as number };
  const version: Version = { version: label, file };
  if (typeof v.format === "string" && FORMATS.includes(v.format)) version.format = v.format as Format;
  else if (v.format !== undefined) warn(`${path}.format`, "dropped: not zip, 7z or rar");
  if (typeof v.build === "string" && SHA256.test(v.build)) version.build = v.build;
  else if (v.build !== undefined) warn(`${path}.build`, "dropped: not 64 lowercase hex digits");
  const notes = text(v.notes, LIMITS.notes);
  if (notes) version.notes = notes;
  else if (v.notes !== undefined) warn(`${path}.notes`, "dropped");
  const contents = parseContents(v.contents);
  if (contents) version.contents = contents;
  else if (v.contents !== undefined) warn(`${path}.contents`, "dropped: not a list of {path, size} of at most 2000 entries");
  if (typeof v.readme === "string" && v.readme.trim() !== "" && v.readme.length <= LIMITS.readme) version.readme = v.readme;
  else if (v.readme !== undefined) warn(`${path}.readme`, "dropped");
  if (validDate(v.released)) version.released = v.released;
  else if (v.released !== undefined) warn(`${path}.released`, "dropped: not an ISO-8601 date");
  return version;
}

function parseContents(c: unknown): { path: string; size: number }[] | undefined {
  if (!Array.isArray(c) || c.length === 0 || c.length > LIMITS.contents) return undefined;
  const out: { path: string; size: number }[] = [];
  for (const e of c) {
    if (!isObject(e) || typeof e.path !== "string" || e.path === "" || e.path.length > LIMITS.contentPath) return undefined;
    if (!Number.isSafeInteger(e.size) || (e.size as number) < 0) return undefined;
    out.push({ path: e.path, size: e.size as number });
  }
  return out;
}

function parseWork(w: unknown): Record<string, string | number> | undefined {
  if (!isObject(w)) return undefined;
  const entries = Object.entries(w);
  if (entries.length === 0 || entries.length > LIMITS.work) return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, val] of entries) {
    if (k.length > LIMITS.workKey || !WORK_KEY.test(k)) return undefined;
    if (typeof val === "number" ? !Number.isSafeInteger(val) : text(val, LIMITS.workText) === undefined) return undefined;
    out[k] = typeof val === "string" ? val.trim() : val as number;
  }
  return out;
}

function parseMeta(m: unknown, path: string, baseUrl: string, warn: (p: string, m: string) => void): Meta | undefined {
  if (!isObject(m)) return void warn(path, "dropped: not an object");
  const meta: Meta = {};
  const url = (v: unknown) => {
    const resolved = typeof v === "string" ? resolveUrl(v, baseUrl) : undefined;
    return resolved !== undefined && isSecureUrl(resolved) ? resolved : undefined;
  };
  const author = text(m.author, LIMITS.author);
  if (author) meta.author = author;
  const description = text(m.description, LIMITS.metaText);
  if (description) meta.description = description;
  if (Array.isArray(m.tags)) {
    const tags = m.tags.map((t) => text(t, LIMITS.tag)).filter((t): t is string => t !== undefined).slice(0, LIMITS.tags);
    if (tags.length) meta.tags = tags;
  }
  const cover = url(m.cover);
  if (cover) meta.cover = cover;
  if (Array.isArray(m.screenshots)) {
    const shots = m.screenshots.map(url).filter((u): u is string => u !== undefined).slice(0, LIMITS.screenshots);
    if (shots.length) meta.screenshots = shots;
  }
  if (Array.isArray(m.links)) {
    const links = m.links.flatMap((l) => {
      const name = isObject(l) ? text(l.name, LIMITS.linkName) : undefined;
      const href = isObject(l) ? url(l.url) : undefined;
      return name && href ? [{ name, url: href }] : [];
    }).slice(0, LIMITS.links);
    if (links.length) meta.links = links;
  }
  return Object.keys(meta).length ? meta : undefined;
}

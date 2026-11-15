// SPEC.md §4.6: loading a whole repo, shards included. Web Crypto and fetch only, so it runs in a browser.

import { RepoError, parseRepo, parseShard } from "./parse.ts";
import type { Repo, Warning } from "./types.ts";
import { verifyArchive } from "./verify.ts";

/** Lets a consumer keep shards by hash: a hit skips the network. */
export interface ShardCache {
  get(sha256: string): Promise<Uint8Array | undefined>;
  put(sha256: string, bytes: Uint8Array): Promise<void>;
}

export interface LoadOptions {
  fetch?: typeof fetch;
  /** Parallel shard downloads. Default 4. */
  concurrency?: number;
  /** Called after each shard is settled, loaded or skipped. */
  onProgress?: (done: number, total: number) => void;
  shardCache?: ShardCache;
}

/** Fetches repo.json and its shards. Throws RepoError only if repo.json itself is unusable; a bad shard is skipped and reported. */
export async function loadRepo(url: string, opts: LoadOptions = {}): Promise<{ repo: Repo; warnings: Warning[] }> {
  const fetchImpl = opts.fetch ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) throw new RepoError(`repo.json: HTTP ${res.status}`);
  const entryUrl = res.url || url;
  const { repo, warnings } = parseRepo(await res.json(), entryUrl);
  const shards = repo.shards ?? [];
  const seen = new Set(repo.games.map((g) => g.id));
  const results: Awaited<ReturnType<typeof loadShard>>[] = new Array(shards.length);

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < shards.length) {
      const i = next++;
      results[i] = await loadShard(shards[i], fetchImpl, opts.shardCache);
      opts.onProgress?.(++done, shards.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, shards.length)) }, worker));

  // Merged in shard order, after all downloads, so the result does not depend on which one finished first.
  results.forEach((r, i) => {
    if ("error" in r) return void warnings.push({ path: `shards[${i}]`, message: `skipped: ${r.error}` });
    try {
      const shard = parseShard(r.json, entryUrl, seen);
      repo.games.push(...shard.games);
      for (const w of shard.warnings) warnings.push({ path: `shards[${i}].${w.path}`, message: w.message });
    } catch (e) {
      warnings.push({ path: `shards[${i}]`, message: `skipped: ${(e as Error).message}` });
    }
  });
  return { repo, warnings };
}

async function loadShard(
  shard: { url: string; sha256: string; size: number },
  fetchImpl: typeof fetch,
  cache?: ShardCache,
): Promise<{ json: unknown } | { error: string }> {
  try {
    let bytes = await cache?.get(shard.sha256);
    if (bytes && !(await verifyArchive(bytes, shard)).ok) bytes = undefined; // a corrupt cache entry is a miss
    if (!bytes) {
      const res = await fetchImpl(shard.url);
      if (!res.ok) return { error: `HTTP ${res.status}` };
      bytes = new Uint8Array(await res.arrayBuffer());
      const check = await verifyArchive(bytes, shard);
      if (!check.ok) return { error: `${check.reason} is ${check.actual}, repo.json says ${check.expected}` };
      await cache?.put(shard.sha256, bytes).catch(() => {}); // a failing cache must not lose the shard
    }
    return { json: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

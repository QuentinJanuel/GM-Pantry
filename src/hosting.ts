// SPEC.md §2: does a URL actually serve a repo the way a browser consumer needs?

import { parseRepo, parseShard } from "./parse.ts";

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface HostingReport {
  ok: boolean; // no failing check
  checks: Check[];
}

/** Fetches repo.json and the newest archive of the first game; checks CORS, Range, content types and validators. */
export async function validateHosting(url: string, fetchImpl: typeof fetch = fetch): Promise<HostingReport> {
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], message: string) => checks.push({ name, status, message });
  const report = () => ({ ok: !checks.some((c) => c.status === "fail"), checks });

  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    add("repo.json", "fail", `fetch failed (no CORS or unreachable): ${(e as Error).message}`);
    return report();
  }
  add("repo.json", res.ok ? "pass" : "fail", `HTTP ${res.status}`);
  if (!res.ok) return report();
  cors(res, "repo.json cors", add);
  const type = res.headers.get("content-type") ?? "";
  add("repo.json content-type", /json|text\/plain/.test(type) ? "pass" : "warn", type || "missing");
  const hasValidator = res.headers.has("etag") || res.headers.has("last-modified");
  add("repo.json validators", hasValidator ? "pass" : "warn", hasValidator ? "ETag or Last-Modified present" : "no ETag or Last-Modified");

  let archive: string | undefined;
  try {
    const { repo } = parseRepo(await res.json(), res.url || url);
    archive = repo.games[0]?.versions[0]?.file.url;
    add("repo.json parses", "pass", `${repo.games.length} inline game(s), ${repo.shards?.length ?? 0} shard(s)`);
    if (repo.shards?.length) archive ??= await checkShard(repo.shards[0].url, res.url || url, fetchImpl, add);
  } catch (e) {
    add("repo.json parses", "fail", (e as Error).message);
    return report();
  }
  if (!archive) return add("archive", "warn", "no game to sample"), report();

  try {
    const a = await fetchImpl(archive, { headers: { Range: "bytes=0-0" } });
    await a.body?.cancel();
    add("archive", a.ok ? "pass" : "fail", `HTTP ${a.status}`);
    if (!a.ok) return report();
    cors(a, "archive cors", add);
    add("archive range", a.status === 206 ? "pass" : "warn", a.status === 206 ? "206 Partial Content" : `Range ignored (HTTP ${a.status}); optional`);
    const t = a.headers.get("content-type") ?? "";
    add("archive content-type", /text\/html/.test(t) ? "fail" : "pass", t || "missing");
  } catch (e) {
    add("archive", "fail", `fetch failed (no CORS or unreachable): ${(e as Error).message}`);
  }
  return report();
}

/** Fetches one shard; returns the first archive url in it, if any. */
async function checkShard(url: string, repoUrl: string, fetchImpl: typeof fetch, add: (n: string, s: Check["status"], m: string) => void): Promise<string | undefined> {
  try {
    const res = await fetchImpl(url);
    add("shard", res.ok ? "pass" : "fail", `HTTP ${res.status}`);
    if (!res.ok) return;
    cors(res, "shard cors", add);
    const type = res.headers.get("content-type") ?? "";
    add("shard content-type", /json|text\/plain/.test(type) ? "pass" : "warn", type || "missing");
    return parseShard(await res.json(), repoUrl).games[0]?.versions[0]?.file.url;
  } catch (e) {
    add("shard", "fail", `fetch failed (no CORS or unreachable): ${(e as Error).message}`);
  }
}

function cors(res: Response, name: string, add: (n: string, s: Check["status"], m: string) => void) {
  const v = res.headers.get("access-control-allow-origin");
  add(name, v === "*" ? "pass" : "fail", `Access-Control-Allow-Origin: ${v ?? "missing"}`);
}

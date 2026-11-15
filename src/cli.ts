#!/usr/bin/env node
import { openAsBlob } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { emptyRepo, serialize, upsertArchive } from "./builder.ts";
import { buildRepo, hashFile, readRepoJson, relativeUrl, writeRepoJson } from "./build.ts";
import { validateHosting } from "./hosting.ts";
import { loadRepo } from "./load.ts";
import { S3Store, checkCors, corsSnippets, publishRepo, type S3Config } from "./s3.ts";
import { verifyArchive } from "./verify.ts";

const USAGE = `gm-pantry init <dir> [--name NAME]
gm-pantry build <dir> [--shard-size N] [--prune]
gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
gm-pantry validate <url|path> [--hosting]
gm-pantry publish <dir> --endpoint URL --bucket NAME --region R [--prefix P] [--shard-size N] [--path-style|--virtual-host]
gm-pantry cors --endpoint URL --bucket NAME --region R [--prefix P] [--origin O] [--public-url URL] [--apply]

publish and cors read credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN)
or --access-key-id / --secret-access-key / --session-token.`;

const S3_OPTIONS = {
  endpoint: { type: "string" }, bucket: { type: "string" }, region: { type: "string" }, prefix: { type: "string" },
  "access-key-id": { type: "string" }, "secret-access-key": { type: "string" }, "session-token": { type: "string" },
  "path-style": { type: "boolean" }, "virtual-host": { type: "boolean" },
  origin: { type: "string" }, "public-url": { type: "string" }, apply: { type: "boolean" },
} as const;

function s3Config(o: Record<string, string | boolean | undefined>): S3Config {
  const env = process.env;
  const cfg = {
    endpoint: o.endpoint as string | undefined ?? env.AWS_ENDPOINT_URL,
    bucket: o.bucket as string | undefined,
    region: o.region as string | undefined ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
    accessKeyId: o["access-key-id"] as string | undefined ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: o["secret-access-key"] as string | undefined ?? env.AWS_SECRET_ACCESS_KEY,
    sessionToken: o["session-token"] as string | undefined ?? env.AWS_SESSION_TOKEN,
  };
  const missing = Object.entries(cfg).filter(([k, v]) => !v && k !== "sessionToken").map(([k]) => k);
  if (missing.length) throw new Error(`missing ${missing.join(", ")} (see usage)`);
  return { ...(cfg as S3Config), prefix: o.prefix as string | undefined, forcePathStyle: o["path-style"] ? true : o["virtual-host"] ? false : undefined };
}

/** Builds the folder's repo.json, then uploads the archives it lists, the shards and repo.json (in that order). */
async function publish(dir: string, o: Record<string, string | boolean | undefined>): Promise<number> {
  const store = new S3Store(s3Config(o));
  const shardSize = o["shard-size"] === undefined ? undefined : Number(o["shard-size"]);
  await buildRepo(dir, o.name as string | undefined, undefined, { shardSize });
  const repoJson = await readFile(join(dir, "repo.json"), "utf8");
  const repo = JSON.parse(repoJson);
  const shards = new Map<string, string>();
  for (const s of repo.shards ?? []) shards.set(s.url, await readFile(join(dir, decodeURIComponent(s.url)), "utf8"));
  const archives = [];
  for (const g of [...repo.games, ...[...shards.values()].flatMap((c) => JSON.parse(c).games)]) {
    for (const v of g.versions) {
      const url: string = v.file.url;
      if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(url)) continue; // not ours to upload
      archives.push({ url, body: await openAsBlob(join(dir, decodeURIComponent(url))), sha256: v.file.sha256 as string });
    }
  }
  const t = await store.testConnection();
  if (!t.ok) return t.checks.forEach((c) => console.error(`${c.status.padEnd(4)} ${c.name}: ${c.message}`)), 1;
  const r = await publishRepo(store, { repoJson, shards }, {
    archives,
    onProgress: (url, done, total) => process.stderr.write(`\r${url}: ${Math.floor((done / total) * 100)}%   `),
  });
  console.log(`\nuploaded ${r.uploaded.length}, skipped ${r.skipped.length}, deleted ${r.deleted.length} old shard(s)`);
  if (!r.conditional) console.log("warning: the service ignores conditional writes, so a concurrent publisher could be overwritten (last writer wins)");
  return 0;
}

async function cors(o: Record<string, string | boolean | undefined>): Promise<number> {
  const store = new S3Store(s3Config(o));
  const origin = o.origin as string | undefined;
  if (o.apply) {
    await store.setCors(origin ? [origin] : ["*"]);
    return console.log("bucket CORS configuration replaced"), 0;
  }
  const publicUrl = o["public-url"] as string | undefined;
  const snippets = corsSnippets(origin);
  if (publicUrl) {
    const report = await checkCors(publicUrl, origin, { writeUrl: store.url("repo.json").href });
    for (const c of report.checks) console.log(`${c.status.padEnd(4)} ${c.name}: ${c.message}`);
    if (report.ok) return 0;
  }
  console.log(`S3 (${snippets.s3.command}):\n${snippets.s3.json}\n\nR2 dashboard JSON (or: ${snippets.r2.command}, with the wrangler JSON below):\n${snippets.r2.json}\n${snippets.r2.wranglerJson}\n\nB2: ${snippets.b2.command}\n\nor run this command again with --apply (needs a key that may call PutBucketCors).`);
  return publicUrl ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const { positionals: [cmd, target, archive], values: o } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...S3_OPTIONS, name: { type: "string" }, id: { type: "string" }, title: { type: "string" }, version: { type: "string" }, hosting: { type: "boolean" }, prune: { type: "boolean" }, "shard-size": { type: "string" } },
  });
  if (!cmd || (!target && cmd !== "cors")) return console.error(USAGE), 2;
  const dir = resolve(target ?? ".");
  switch (cmd) {
    case "init": {
      if (await readRepoJson(dir)) return console.error("repo.json already exists"), 1;
      await writeRepoJson(dir, (await serialize(emptyRepo(o.name ?? dir.split("/").pop()!))).repoJson);
      return console.log(`wrote ${join(dir, "repo.json")}`), 0;
    }
    case "build": {
      const { changed, count, shards, pruned } = await buildRepo(dir, o.name, undefined, {
        shardSize: o["shard-size"] === undefined ? undefined : Number(o["shard-size"]),
        prune: o.prune,
      });
      return console.log(`${count} archive(s), ${shards} shard(s), ${pruned} pruned; repo.json ${changed ? "written" : "unchanged"}`), 0;
    }
    case "add": {
      if (!archive) return console.error(USAGE), 2;
      const repo = (await readRepoJson(dir)) ?? emptyRepo(o.name ?? dir.split("/").pop()!);
      if (repo.shards?.length) return console.error("repo.json is sharded; put the archive in the folder and run build"), 1;
      const previous = structuredClone(repo);
      upsertArchive(repo, await relativeUrl(dir, resolve(archive)), await hashFile(resolve(archive)), o);
      await writeRepoJson(dir, (await serialize(repo, { previous })).repoJson);
      return console.log("repo.json updated"), 0;
    }
    case "publish":
      return publish(dir, o);
    case "cors":
      return cors(o);
    case "validate":
      return validate(target, o.hosting === true);
    default:
      return console.error(USAGE), 2;
  }
}

async function validate(target: string, hosting: boolean): Promise<number> {
  let failed = false;
  const isUrl = /^https?:\/\//.test(target);
  // A local path is served to the loader through a virtual origin, so relative urls (shards, archives) resolve as they would online.
  const origin = "http://localhost/";
  let url = target;
  let dir = "";
  let localFetch: typeof fetch | undefined;
  if (!isUrl) {
    const isDir = (await stat(target)).isDirectory();
    dir = isDir ? resolve(target) : resolve(target, "..");
    url = origin + (isDir ? "repo.json" : encodeURIComponent(basename(target)));
    localFetch = async (u) => {
      try {
        return new Response(await readFile(join(dir, decodeURIComponent(new URL(String(u)).pathname))));
      } catch {
        return new Response(null, { status: 404 });
      }
    };
  }
  const { repo, warnings } = await loadRepo(url, { fetch: localFetch });
  console.log(`${repo.name}: ${repo.games.length} game(s)${repo.shards ? ` in ${repo.shards.length} shard(s) plus inline` : ""}`);
  for (const w of warnings) console.log(`warning ${w.path}: ${w.message}`), (failed = true);
  if (!isUrl) {
    for (const g of repo.games) for (const v of g.versions) {
      if (!v.file.url.startsWith(origin)) continue;
      const path = join(dir, decodeURIComponent(v.file.url.slice(origin.length)));
      try {
        const r = await verifyArchive(await readFile(path), v.file);
        if (!r.ok) console.log(`error ${g.id} ${v.version}: ${r.reason} is ${r.actual}, repo.json says ${r.expected}`), (failed = true);
      } catch {
        console.log(`error ${g.id} ${v.version}: ${path} is missing`), (failed = true);
      }
    }
  }
  if (hosting) {
    if (!isUrl) return console.error("--hosting needs a url"), 2;
    const report = await validateHosting(target);
    for (const c of report.checks) console.log(`${c.status.padEnd(4)} ${c.name}: ${c.message}`);
    if (!report.ok) failed = true;
  }
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => (console.error(e.message), process.exit(1)));

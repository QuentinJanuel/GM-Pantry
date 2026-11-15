#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRepo, emptyRepo, hashFile, readRepoJson, relativeUrl, upsertArchive, writeRepoJson } from "./build.ts";
import { validateHosting } from "./hosting.ts";
import { loadRepo } from "./load.ts";
import { verifyArchive } from "./verify.ts";

const USAGE = `gm-pantry init <dir> [--name NAME]
gm-pantry build <dir> [--shard-size N] [--prune]
gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
gm-pantry validate <url|path> [--hosting]`;

async function main(argv: string[]): Promise<number> {
  const { positionals: [cmd, target, archive], values: o } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" }, id: { type: "string" }, title: { type: "string" }, version: { type: "string" }, hosting: { type: "boolean" }, prune: { type: "boolean" }, "shard-size": { type: "string" } },
  });
  if (!cmd || !target) return console.error(USAGE), 2;
  const dir = resolve(target);
  switch (cmd) {
    case "init": {
      if (await readRepoJson(dir)) return console.error("repo.json already exists"), 1;
      await writeRepoJson(dir, emptyRepo(o.name ?? dir.split("/").pop()!));
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
      upsertArchive(repo, await relativeUrl(dir, resolve(archive)), await hashFile(resolve(archive)), o);
      await writeRepoJson(dir, repo);
      return console.log("repo.json updated"), 0;
    }
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

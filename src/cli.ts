#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildRepo, emptyRepo, hashFile, readRepoJson, relativeUrl, upsertArchive, writeRepoJson } from "./build.ts";
import { validateHosting } from "./hosting.ts";
import { parseRepo } from "./parse.ts";
import { verifyArchive } from "./verify.ts";

const USAGE = `gm-pantry init <dir> [--name NAME]
gm-pantry build <dir>
gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
gm-pantry validate <url|path> [--hosting]`;

async function main(argv: string[]): Promise<number> {
  const { positionals: [cmd, target, archive], values: o } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { name: { type: "string" }, id: { type: "string" }, title: { type: "string" }, version: { type: "string" }, hosting: { type: "boolean" } },
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
      const { changed, count } = await buildRepo(dir, o.name);
      return console.log(`${count} archive(s); repo.json ${changed ? "written" : "unchanged"}`), 0;
    }
    case "add": {
      if (!archive) return console.error(USAGE), 2;
      const repo = (await readRepoJson(dir)) ?? emptyRepo(o.name ?? dir.split("/").pop()!);
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
  let json: unknown;
  let base: string;
  let dir: string | undefined;
  if (isUrl) {
    base = target;
    const res = await fetch(target);
    if (!res.ok) return console.error(`HTTP ${res.status}`), 1;
    json = await res.json();
  } else {
    dir = (await stat(target)).isDirectory() ? resolve(target) : resolve(target, "..");
    // Relative urls are checked against the folder itself below; resolution only needs a valid https base.
    base = "https://repo.invalid/";
    json = JSON.parse(await readFile((await stat(target)).isDirectory() ? join(target, "repo.json") : target, "utf8"));
  }
  const { repo, warnings } = parseRepo(json, base);
  console.log(`${repo.name}: ${repo.games.length} game(s)`);
  for (const w of warnings) console.log(`warning ${w.path}: ${w.message}`), (failed = true);
  if (dir) {
    for (const g of repo.games) for (const v of g.versions) {
      if (!v.file.url.startsWith(base)) continue;
      const path = join(dir, decodeURIComponent(v.file.url.slice(base.length)));
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

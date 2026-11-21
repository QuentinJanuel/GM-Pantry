---
sidebar_position: 4
title: API and CLI reference
---

# API and CLI reference

```bash
npm install gm-pantry
```

The library uses Web Crypto, `fetch` and [hash-wasm](https://github.com/Daninet/hash-wasm), so it runs in browsers and Node 24 or newer. Only the CLI uses Node APIs.
There are two entry points: `gm-pantry` and `gm-pantry/s3`.

## `gm-pantry`

### Reading

```ts
import { loadRepo, parseRepo, parseShard, verifyArchive } from "gm-pantry";

const { repo, warnings } = await loadRepo(url, { concurrency: 4, onProgress: (done, total) => {}, shardCache });
const result = await verifyArchive(bytes, repo.games[0].versions[0].file); // { ok: true, verified, sha256 } or { ok: false, reason, expected, actual }
```

- `loadRepo(url, options?)` fetches `repo.json` and every shard, verifies the shards by hash, and returns `{ repo, warnings }`. It throws `RepoError` only if `repo.json` is unusable.
  `shardCache` is `{ get(sha256), put(sha256, bytes) }`: a hit skips the request.
- `parseRepo(json, baseUrl)` and `parseShard(json, baseUrl, seen?)` read the two kinds of file you fetched yourself. A parsed `Repo` has every url resolved to an absolute one.
- `verifyArchive(source, file)` checks size and SHA-256 of bytes, a `Blob` or a stream, hashing chunk by chunk. A `file` without `sha256` is
  checked on size (and `sha1`, if given) and comes back `{ ok: true, verified: false, sha256 }`: the computed hash, to pin, not a proof.
- `validateHosting(url)` runs the hosting checks of `validate --hosting` and returns a `HostingReport` of `Check`s.
- `hashBlob(blob, { onProgress, signal })` and `hashStream(stream, options)` stream a SHA-256 and return `{ sha256, size }`; a 4 GB `File` is fine. `{ sha1: true }` also returns a `sha1`.
- Also exported: `LIMITS` (the caps), `RepoError`, `isSecureUrl`, `resolveUrl`, and the types `Repo`, `Game`, `Version`, `ArchiveFile`, `Meta`, `Shard`, `Format`, `Warning`.

### Editing in memory

These work on the raw `repo.json` object (type `Json`):

```ts
import { addVersion, emptyRepo, inlineShards, removeGame, removeVersion, serialize, updateGame } from "gm-pantry";

const repo = emptyRepo("My Pantry");
addVersion(repo, { title: "My Game", version: "1.0", file: { url: "My_Game.zip", sha256, size } });
updateGame(repo, "my-game", { meta: { author: "Me" }, work: { delfruit: 1234 } }); // null removes a key
removeVersion(repo, "my-game", "0.9");
removeGame(repo, "old-game");
const { repoJson, shards, orphans } = await serialize(repo, { shardSize: 1000, previous });
```

- `emptyRepo(name)`, `addVersion(repo, newVersion)` (a new newest version; creates the game when `title` is given), `updateGame`, `removeVersion`, `removeGame`, and `slug(text)`.
- `inlineShards(repo, readShard)` folds a sharded raw `repo.json` back into inline games so you can edit it; `splitShards(games, size)` is the splitting step.
- `serialize(repo, { shardSize, previous })` returns the bytes of `repo.json`, the shard files to write (`shards/<sha16>.json`) and the `orphans`: shards `previous` listed that are now unused.
  The same input always gives the same bytes, and `updated` only moves when something changed.

## `gm-pantry/s3`

Publishing to S3-compatible storage, from a browser or Node. Requests are signed with SigV4 ([aws4fetch](https://github.com/mhart/aws4fetch)); archive bodies are sent unsigned
(`UNSIGNED-PAYLOAD`), so use HTTPS.

```ts
import { S3Store, publishRepo, checkCors } from "gm-pantry/s3";

const store = new S3Store({ endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken, prefix: "games", forcePathStyle });
await store.testConnection();                      // list, write, delete a probe object
const loaded = await store.getObject("repo.json"); // { bytes, etag } or undefined
const result = await publishRepo(store, { repoJson, shards, orphans }, {
  archives: [{ url: "My_Game.zip", body: file, sha256 }],
  ifMatch: loaded?.etag ?? null,
  resume: (url) => saved.get(url), onState: (url, state) => saved.set(url, state),
  onProgress: (url, done, total) => {},
});
```

- `S3Store`: `testConnection()` tells bad credentials, wrong region, missing bucket and missing permissions apart; `getObject(key)`; `uploadFile(key, blob, { partSize, concurrency, onProgress, signal, onState, resume })`
  is the multipart upload on its own (parts default to 16 MiB and grow so any file fits in 10 000 parts, three in flight, resumable from `resume`);
  `abortUpload` and `abortIncompleteUploads()` discard unfinished uploads; `setCors()` applies a CORS rule (use it from Node or a desktop app, where CORS is not enforced).
- `publishRepo(store, input, options)` uploads archives and new shards first and `repo.json` last (`Content-Type: application/json`, `Cache-Control: no-cache`; shards get
  `public, max-age=31536000, immutable`), then deletes unreferenced shards. It writes `repo.json` with `If-Match` / `If-None-Match: *` and throws `ConflictError` if it changed since you loaded it.
  If the service rejects conditional writes (`501`) it writes unconditionally and returns `conditional: false`: with several publishers, the last writer wins.
- `checkCors(publicBaseUrl, origin, { writeUrl })` runs the checks a browser would and returns what is missing, with snippets; `corsSnippets(origin)` gives the rules for S3, R2 and B2.
- Also exported: `S3Error`, `ConflictError`, `choosePartSize`, `contentTypeOf`.

## CLI

```
gm-pantry init <dir> [--name NAME]
gm-pantry build <dir> [--shard-size N] [--prune]
gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
gm-pantry validate <url|path> [--hosting]
gm-pantry publish <dir> --endpoint URL --bucket NAME --region R [--prefix P] [--shard-size N] [--path-style|--virtual-host]
gm-pantry cors --endpoint URL --bucket NAME --region R [--prefix P] [--origin O] [--public-url URL] [--apply]
```

| command | does |
|---|---|
| `init` | Creates the directory with an empty `repo.json`. |
| `build` | Hashes the `.zip`, `.7z` and `.rar` files at the top of the folder and writes `repo.json`, keeping what is already there; shards above `--shard-size` (default 1000); `--prune` drops games whose archive is gone. |
| `add` | Adds one archive from inside the directory as a new newest version; refuses a sharded repo. |
| `validate` | Parses a `repo.json` (url, folder or file) and reports every skipped entry; for a folder also loads shards and checks hashes. `--hosting` (url only) checks CORS, `Range`, content types and validators. Exit code 1 on any problem. |
| `publish` | Builds, then uploads archives, shards and `repo.json` (last) to S3-compatible storage. |
| `cors` | Prints the CORS configuration; `--public-url` checks what a browser sees; `--apply` calls `PutBucketCors`. |

`publish` and `cors` read credentials from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN`) or `--access-key-id` / `--secret-access-key` / `--session-token`.
`--endpoint`, `--region` also fall back to `AWS_ENDPOINT_URL`, `AWS_REGION` / `AWS_DEFAULT_REGION`.

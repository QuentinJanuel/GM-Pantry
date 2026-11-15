# GM-Pantry

A format for game repositories: a static directory served over HTTPS that lists game archives, with
a TypeScript library, a validator and a CLI. The specification is [SPEC.md](SPEC.md), at revision 1.

## The format at a glance

A repo is a directory. Its entry point is `repo.json`, and the URL of that file is the repo's identity.

```json
{
  "schema": 1,
  "name": "Example Pantry",
  "updated": "2026-11-15",
  "games": [
    {
      "id": "my-fangame",
      "title": "My Fangame",
      "work": { "delfruit": 1234 },
      "versions": [
        { "version": "1.0", "file": { "url": "My_Fangame.zip", "sha256": "<64 hex digits>", "size": 1048576 } }
      ]
    }
  ]
}
```

- Archives are stored exactly as distributed and are never modified. Their sha256 is checked after
  download; a mismatch discards the file.
- File urls may be relative, so a mirror of the directory is a working repo.
- Unknown fields are ignored; a malformed game or version is skipped and the rest of the repo still loads.
- A big repo lists content-addressed `shards` (files of at most 1 000 games) instead of inlining its
  games; a bad or tampered shard is skipped and the rest still loads.
- Nothing lists or indexes repos. A private repo is an unguessable URL.

## CLI

```
npx gm-pantry init <dir> [--name NAME]
npx gm-pantry build <dir> [--shard-size N] [--prune]
npx gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
npx gm-pantry validate <url|path> [--hosting]
npx gm-pantry publish <dir> --endpoint URL --bucket NAME --region R [--prefix P] [--shard-size N] [--path-style|--virtual-host]
npx gm-pantry cors --endpoint URL --bucket NAME --region R [--prefix P] [--origin O] [--public-url URL] [--apply]
```

- `build` hashes every `.zip`, `.7z` and `.rar` at the top of the folder (streaming), derives each
  game's id and title from the file name, and writes `repo.json`. An existing `repo.json` is kept:
  hand-edited metadata, other versions and unknown fields survive, and a changed archive only has its
  hash and size refreshed. By default it never deletes an entry (`--prune` removes games whose archive file is gone from the
  folder). Above `--shard-size` games (default 1000) it writes `shards/<sha16>.json` files of at most
  N games sorted by id plus an entry `repo.json`, deletes the shards it generated earlier that are no
  longer referenced, and gives the same bytes for the same input; at or below it the output stays
  inline. `add` refuses a sharded repo: put the archive in the folder and run `build`. `updated` moves only when something changed, so
  a rebuild of an unchanged folder is byte-identical.
- `add` does the same for one archive, which must be inside the directory, as a new newest version.
- `validate` parses a `repo.json` (a URL, a folder or a file) and reports every skipped entry; for a
  folder it also loads every shard and checks each archive's hash. `--hosting` (URL only) fetches `repo.json` and a sample
  archive and checks CORS, Range, content types and validators. Exit code 1 on any problem.

- `publish` builds the folder as `build` does, then uploads to S3-compatible storage: archives (multipart
  above 16 MiB, an archive the bucket already holds with the same size and hash is skipped), new shards,
  and `repo.json` last, then deletes shards nothing lists any more. Credentials come from
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN`) or `--access-key-id` /
  `--secret-access-key` / `--session-token`. It checks the connection first and reports bad
  credentials, a wrong region, a missing bucket or missing permissions separately.
- `cors` prints the CORS configuration to paste (below). With `--public-url` it also checks what a
  browser would see; with `--apply` it calls `PutBucketCors` for you (needs a key allowed to).

## Library

```ts
import { loadRepo, parseRepo, parseShard, verifyArchive, validateHosting } from "gm-pantry";

// repo.json plus every shard, verified by hash; throws RepoError only if repo.json is unusable
const { repo, warnings } = await loadRepo(url, { concurrency: 4, onProgress: (done, total) => {}, shardCache });
// parseRepo(json, url) and parseShard(json, url) read the two kinds of file you fetched yourself
// shardCache is { get(sha256), put(sha256, bytes) }: persist shards by hash and a hit skips the network
const result = await verifyArchive(bytes, repo.games[0].versions[0].file); // { ok: true } or { ok: false, ... }
```

The library uses Web Crypto, `fetch` and [hash-wasm](https://github.com/Daninet/hash-wasm) (streaming
SHA-256), so it runs in browsers and Node. Only the CLI uses Node APIs.

### Editing a repo in memory and hashing big files

```ts
import { addVersion, emptyRepo, hashBlob, inlineShards, removeGame, removeVersion, serialize, updateGame } from "gm-pantry";

const { sha256, size } = await hashBlob(file, { onProgress: (bytes) => {}, signal }); // streams: a 4 GB File is fine
const repo = emptyRepo("My Pantry");          // or the raw repo.json, with inlineShards() when it is sharded
addVersion(repo, { title: "My Game", version: "1.0", file: { url: "My_Game.zip", sha256, size } });
updateGame(repo, "my-game", { meta: { author: "Me" }, work: { delfruit: 1234 } }); // null removes a key
removeVersion(repo, "my-game", "0.9"); removeGame(repo, "old-game");
const { repoJson, shards, orphans } = await serialize(repo, { shardSize: 1000, previous }); // previous: the repo.json being replaced
```

`serialize` gives the bytes of `repo.json`, the shard files to write (`shards/<sha16>.json`) and the shards
the previous `repo.json` listed that are now unused. The same input always gives the same bytes. The
CLI's `build` and `add` use these functions. `verifyArchive` also accepts a `Blob` or stream and hashes it
chunk by chunk.

### Publishing to S3-compatible storage from a browser (`gm-pantry/s3`)

```ts
import { S3Store, publishRepo, checkCors } from "gm-pantry/s3";

const store = new S3Store({ endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken, prefix: "games", forcePathStyle });
const test = await store.testConnection();   // list, write, delete a probe object; bad credentials, region, bucket and permissions are told apart
const loaded = await store.getObject("repo.json");   // { bytes, etag } or undefined; keep the etag
const result = await publishRepo(store, { repoJson, shards, orphans }, {
  archives: [{ url: "My_Game.zip", body: file, sha256 }],   // uploaded first, multipart when large
  ifMatch: loaded?.etag ?? null,                            // refuses with ConflictError if repo.json changed since
  resume: (url) => saved.get(url), onState: (url, state) => saved.set(url, state),   // persist the multipart state
  onProgress: (url, done, total) => {},
});
```

`publishRepo` uploads archives and new shards first and `repo.json` last (`Content-Type: application/json`,
`Cache-Control: no-cache`; shards get `public, max-age=31536000, immutable`), writes it with `If-Match` /
`If-None-Match: *`, and deletes unreferenced shards only afterwards. If the service rejects conditional
writes (`501`), it writes unconditionally and returns `conditional: false`: with several publishers,
the last writer wins. `store.uploadFile(key, blob, { partSize, concurrency, onProgress, signal, onState, resume })`
is the multipart upload on its own: parts default to 16 MiB and grow so any file fits in 10 000
parts, three are in flight at once, and an upload stopped by `signal` or a crash continues from
`resume`. `store.abortUpload` and `store.abortIncompleteUploads()` discard unfinished uploads. Requests are signed
with SigV4 by [aws4fetch](https://github.com/mhart/aws4fetch); archive bodies are sent with
`UNSIGNED-PAYLOAD`, so use HTTPS.

### CORS: set it once, outside the browser

A browser can only call the bucket after the bucket allows it, and `PutBucketCors` is itself a
cross-origin request, so a web page cannot set the first rule. The owner sets it once with the
provider's tools (or `gm-pantry cors --apply`, or `store.setCors()` from Node or a desktop app, where
CORS is not enforced). `checkCors(publicBaseUrl, origin, { writeUrl })` runs the checks a browser would
(read `repo.json` with CORS, `ETag` exposed, `Range`, and preflights for the `PUT`, `POST` and `DELETE`
with the headers the publisher sends) and returns what is missing plus these snippets
(`corsSnippets(origin)`; `origin` is the web app, or `*`):

- **Amazon S3**: save as `cors.json`, then `aws s3api put-bucket-cors --bucket BUCKET --cors-configuration file://cors.json`

  ```json
  { "CORSRules": [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"], "MaxAgeSeconds": 3600 }] }
  ```

- **Cloudflare R2**: paste into the bucket's Settings, CORS policy in the dashboard:

  ```json
  [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD", "PUT", "POST", "DELETE"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag", "Content-Length", "Content-Range"], "MaxAgeSeconds": 3600 }]
  ```

  or, with wrangler, `npx wrangler r2 bucket cors set BUCKET --file cors.json` and this file:

  ```json
  { "rules": [{ "allowed": { "origins": ["*"], "methods": ["GET", "HEAD", "PUT", "POST", "DELETE"], "headers": ["*"] }, "exposeHeaders": ["ETag", "Content-Length", "Content-Range"], "maxAgeSeconds": 3600 }] }
  ```

- **Backblaze B2**: its S3 API accepts the S3 rule above; with the B2 CLI,
  `b2 bucket update --cors-rules '<json>' BUCKET allPrivate`, where the JSON is
  `[{"corsRuleName":"gm-pantry","allowedOrigins":["*"],"allowedOperations":["s3_get","s3_head","s3_put","s3_post","s3_delete"],"allowedHeaders":["*"],"exposeHeaders":["ETag","Content-Length","Content-Range"],"maxAgeSeconds":3600}]`.
  (`allPrivate` is the bucket type: use your bucket's current one.)

For publishing, prefer your web app's origin over `*`. For readers only, the `GET`/`HEAD` rule further
down is enough. These snippets were written from the providers' documentation and checked against a
fake S3, not against the real services.

## Hosting

The host must serve HTTPS and send `Access-Control-Allow-Origin: *` on `repo.json` and the archives.
`Range` on archives, `ETag`/`Last-Modified` on `repo.json`, and a long `Cache-Control: immutable` on
shards (they are named after their hash) are recommended. Check with
`gm-pantry validate <url> --hosting`.

- **GitHub Pages** serves `Access-Control-Allow-Origin: *` already. Keep archives under its size limits.
- **Amazon S3** needs a CORS rule on the bucket:

  ```json
  [{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"], "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"], "MaxAgeSeconds": 86400 }]
  ```

- **Cloudflare R2** takes the same rule in the bucket's CORS policy (dashboard, Settings, CORS policy).
- **Backblaze B2** needs CORS rules on the bucket allowing `GET`/`HEAD` from any origin (its S3
  compatible API accepts the S3 rule above).

## Development

```
pnpm install
pnpm run typecheck && pnpm test && pnpm run build
```

`conformance/` holds `repo.json` inputs with their expected result; a reader in any language can use them.

MIT licensed.

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
- Nothing lists or indexes repos. A private repo is an unguessable URL.

## CLI

```
npx @sculptr/gm-pantry init <dir> [--name NAME]
npx @sculptr/gm-pantry build <dir>
npx @sculptr/gm-pantry add <dir> <archive> [--id ID] [--title TITLE] [--version LABEL]
npx @sculptr/gm-pantry validate <url|path> [--hosting]
```

- `build` hashes every `.zip`, `.7z` and `.rar` at the top of the folder (streaming), derives each
  game's id and title from the file name, and writes `repo.json`. An existing `repo.json` is kept:
  hand-edited metadata, other versions and unknown fields survive, and a changed archive only has its
  hash and size refreshed. It never deletes an entry. `updated` moves only when something changed, so
  a rebuild of an unchanged folder is byte-identical.
- `add` does the same for one archive, which must be inside the directory, as a new newest version.
- `validate` parses a `repo.json` (a URL, a folder or a file) and reports every skipped entry; for a
  folder it also checks each archive's hash. `--hosting` (URL only) fetches `repo.json` and a sample
  archive and checks CORS, Range, content types and validators. Exit code 1 on any problem.

## Library

```ts
import { parseRepo, resolveUrl, verifyArchive, validateHosting } from "@sculptr/gm-pantry";

const { repo, warnings } = parseRepo(await (await fetch(url)).json(), url); // throws RepoError if unusable
const result = await verifyArchive(bytes, repo.games[0].versions[0].file); // { ok: true } or { ok: false, ... }
```

The library uses Web Crypto and `fetch` only, so it runs in browsers and Node. Only the CLI uses Node
APIs.

## Hosting

The host must serve HTTPS and send `Access-Control-Allow-Origin: *` on `repo.json` and the archives.
`Range` on archives and `ETag`/`Last-Modified` on `repo.json` are recommended. Check with
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

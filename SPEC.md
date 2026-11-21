# GM-Pantry: the game repository format

Revision 2.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

## 1. What a repository is

A game repository, here a *repo*, is a directory of static files served over HTTPS. Its entry point
is a JSON file named `repo.json`. The URL of `repo.json` is the identity of the repo: two repos are
the same repo if and only if those URLs are equal. A repo lists *games*; each game has one or more
*versions*; each version points at one *archive*, the file the game was distributed as.

A repo is not a service. It has no API, no authentication and no index. Nothing lists or indexes
repo URLs: a consumer is given a URL. A private repo is a repo at an unguessable URL.

## 2. Hosting

A server that hosts a repo:

1. MUST serve `repo.json` and every archive over HTTPS.
2. MUST send `Access-Control-Allow-Origin: *` on `repo.json`, on every shard (§3.7) and on every archive, so that a web
   page on any origin can read them.
3. SHOULD answer `Range` requests on archives with `206 Partial Content`.
4. SHOULD send `ETag` or `Last-Modified` on `repo.json`, so that a consumer can revalidate it cheaply.
5. SHOULD serve `repo.json` and shards as `application/json` and MUST NOT serve an archive as `text/html`.
6. SHOULD serve shards with `Cache-Control: public, max-age=31536000, immutable`: a shard is
   content-addressed (§3.7), so any cache may keep it forever.

An implementation SHOULD accept `http` on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) so a
repo can be tried locally. No other plain-`http` URL is valid anywhere in this format.

### 2.1 Hosting notes (informative)

These notes add no requirement; the revision of this document does not change.

- **Caching.** `repo.json` is the only mutable file: serve it with `Cache-Control: no-cache`, so a cache
  revalidates it with its `ETag` and an update shows at once. A shard is named after its content (§3.7)
  and never changes: `public, max-age=31536000, immutable`. An archive is whatever the owner chose;
  it is checked by size and hash anyway (§5).
- **Publication order.** A publisher uploads archives and new shards first and `repo.json` last, and
  deletes shards that nothing lists any more only after `repo.json` is live. A reader then never
  sees a `repo.json` that points at a missing file.
- **Concurrent publishers.** Where the service supports conditional writes, a publisher writes
  `repo.json` with `If-Match: <ETag it loaded>` (`If-None-Match: *` for the first write) and reloads
  and retries on `412`. Where it does not, the last writer wins.
- **S3-compatible storage** (Amazon S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi) serves a repo
  as it is: put the files under a key prefix and serve the bucket publicly (or through the provider's
  public domain). Reading needs `Access-Control-Allow-Origin` on `GET`/`HEAD` and, for `Range`, the
  `Range` request header. A *web page that publishes* also needs, on the S3 API endpoint it uploads
  to: `PUT`, `POST` (multipart) and `DELETE` in the allowed methods; the request headers it sends
  (`Authorization`, `Content-Type`, `Cache-Control`, `If-Match`, `If-None-Match`, `x-amz-*`) allowed;
  and `ETag` exposed, because a multipart upload reads each part's `ETag`. A browser cannot set
  that CORS rule itself: `PutBucketCors` is a cross-origin request, which needs the rule it would
  create. The owner sets it once with the provider's tooling.
- **Large archives** go up as multipart uploads (parts of at least 5 MiB, at most 10 000 of them), so
  the part size must grow with the file: a 4 GiB archive needs parts of at least 430 KB, a 500 GiB
  one 52 MiB.

## 3. Document model

`repo.json` is one UTF-8 JSON object.

### 3.1 Repo

| field | type | |
|---|---|---|
| `schema` | integer | MUST be `1`. |
| `name` | string | MUST be present. |
| `description` | string | MAY. |
| `icon` | string | MAY. An https url (MAY be relative to `repo.json`) of a small square image that stands for the repository, or the image itself as a `data:image/png`, `data:image/jpeg` or `data:image/webp` base64 url of at most 16384 characters (so a repository with nowhere to put an image can still have one). Advisory; a consumer without one makes its own. |
| `homepage` | https url | MAY. |
| `updated` | string | MUST be present. ISO-8601 date or timestamp of the last change to the file. |
| `games` | Game[] | Inline games. MAY be empty. |
| `shards` | Shard[] | MAY. Files holding more games (§3.7). |

At least one of `games` and `shards` MUST be present. A repo MAY have both: the games of a repo are
`games` followed by the games of each shard in order.

### 3.2 Game

| field | type | |
|---|---|---|
| `id` | string | MUST be present. A stable slug, unique within the repo. |
| `title` | string | MUST be present. |
| `work` | object | MAY. Names the abstract game, independent of any repo: `{"delfruit": 1234}`, `{"iww": "slug"}`. Several keys MAY be given. Keys are lowercase identifiers; values are strings or integers. A consumer ignores keys it does not know. |
| `meta` | Meta | MAY. Advisory. |
| `versions` | Version[] | MUST be present and non-empty, newest first. |

`id` MUST NOT change once published: consumers key their data on `(repo URL, id)`.

### 3.3 Meta (all advisory)

`author` (string), `description` (string), `tags` (string[]), `cover` (url), `screenshots` (url[]),
`links` (`{ "name": string, "url": url }[]`). Urls MAY be relative to `repo.json` (§3.5).

### 3.4 Version

| field | type | |
|---|---|---|
| `version` | string | MUST be present. A free-form label; it is displayed, never compared. |
| `file` | File | MUST be present. |
| `format` | `"zip"`, `"7z"` or `"rar"` | MAY. If absent the consumer guesses from the file name or bytes. |
| `build` | string | MAY. The claimed lowercase-hex SHA-256 of the normalised game payload inside the archive. A hint only: a consumer that needs it MUST recompute it. |
| `notes` | string | MAY. |
| `contents` | list of `{ path, size }` | MAY. The files inside the archive: `path` relative to the archive root, `size` the unpacked length in bytes. Advisory: lets a consumer tell what the game is without downloading it; a consumer that needs certainty MUST read the archive. |
| `readme` | string | MAY. The text of the archive's README, so it can be shown without downloading the archive. Advisory. |
| `released` | string | MAY. ISO-8601 date. |

File:

| field | type | |
|---|---|---|
| `url` | string | MUST be present. MAY be relative to `repo.json`. |
| `size` | integer | MUST be present. The archive length in bytes, a non-negative integer. |
| `sha256` | string | SHOULD be present. Lowercase hex SHA-256 of the archive bytes, exactly as served. A publisher MAY leave it out when hashing is too costly (a large list added by url: the size comes cheaply from `Content-Length`, the hash only from the whole download); the archive is then *unverified* (§5). |
| `sha1` | string | MAY. 40 lowercase hex digits: a SHA-1 the host reported for the archive, such as Backblaze B2's `X-Bz-Content-Sha1`. Advisory, and no substitute for `sha256`: SHA-1 is not collision resistant. |

A reader of revision 1 (gm-pantry 0.6.0 and earlier) skips a Version without `sha256` as malformed,
and a Game left with no Version at all: a repo with entries that have none is only fully visible to
newer readers.

### 3.5 URLs

A url is resolved against the URL `repo.json` was fetched from, as in RFC 3986. A repo SHOULD use
relative urls for its own files, so that a mirror of the directory is a working repo at its own URL.
After resolution, every url MUST be `https` (§2).

### 3.6 Archives

An archive is stored exactly as the author distributed it. A repo tool MUST NOT modify, recompress
or repack an archive, and the `sha256` (when given) is the hash of that unmodified file.

### 3.7 Shards

A repo too large for one `repo.json` (a few thousand games) lists *shards*. A Shard is
`{ "url", "sha256", "size", "count" }`: `url` (MAY be relative to `repo.json`), `sha256` and `size`
of the shard file's bytes exactly as served (as for a File), and `count`, the number of games in it,
which is advisory.

A shard file is one UTF-8 JSON object `{ "games": Game[] }`. Urls inside its games are resolved
against the URL of `repo.json`, not of the shard. A shard is immutable by convention: a repo tool
SHOULD name it after its content (`shards/<first 16 hex digits of its sha256>.json`) and never
rewrite a file under that name, so that a cache may keep it forever. A game `id` MUST be unique
across the whole repo (inline and every shard).

A repo with at most 1 000 games SHOULD keep them inline. Otherwise it SHOULD use shards of at most
1 000 games each, sorted by `id`.

## 4. Reading a repo

A consumer follows these rules, so that one bad entry never hides the rest of a repo.

1. Unknown fields are ignored, at every level. This is how the format grows (§7).
2. If `repo.json` is not an object, `schema` is not `1`, or `name`, `updated` or `games` is missing or
   malformed, the repo fails to load.
3. A Game that is malformed, a duplicate of an earlier `id` (in `games`, then in each shard in order), or left with no valid Version is skipped.
   A Version that is malformed is skipped. A skipped entry SHOULD be reported, not silently lost.
4. A malformed advisory field (`description`, `homepage`, `icon`, `work`, `meta` and its parts, `format`,
   `build`, `notes`, `contents`, `readme`, `released`, `file.sha1`) is dropped; the entry stays. A
   `file.sha256` that is present but malformed is not advisory: its Version is skipped.
5. A Shard entry that is malformed is skipped. A shard that cannot be fetched, whose bytes do not match
   its `size` and `sha256` (a consumer MUST check both and MUST NOT use any part of such a file), or
   that is not `{ "games": [...] }` is skipped. Each is reported and the rest of the repo still
   loads. A malformed `count` is dropped.
6. A consumer MAY fetch shards in parallel and MAY keep them, keyed by `sha256`; a kept shard that
   still matches its `sha256` needs no request.
7. Caps. A value over its cap is malformed. Strings are trimmed first.

| value | cap |
|---|---|
| `name` | 80 characters |
| repo `description` | 280 |
| `games` per file (`repo.json` and each shard) | 2 000 read; more are ignored |
| `shards` | 1 000 read; more are ignored |
| `id` | 64, matching `[a-z0-9][a-z0-9._-]*` |
| `title` | 200 |
| `versions` per game | 200 read |
| `version` label | 64 |
| any url | 2048 |
| `icon` as a data url | 16384 |
| `meta.description`, `notes` | 2000 |
| `contents` | 2000 entries of at most 260 characters per path |
| `readme` | 20000 |
| `meta.author` | 120 |
| `tags` | 20 of at most 40 characters |
| `screenshots`, `links` | 20 each; `links[].name` 80 |
| `work` | 8 keys; key 32 characters matching `[a-z][a-z0-9_-]*`; string value 128 |

The caps give a repo at most 2 000 inline games plus 1 000 shards of 2 000 games: 2 002 000 games.

## 5. Using an archive

1. A consumer MUST check the downloaded bytes against `file.size` and `file.sha256`. On a mismatch it
   MUST discard the file and MUST NOT use any part of it.
2. Without `file.sha256` the archive is *unverified*. A consumer MUST still check `file.size`, and
   `file.sha1` when it is given, and discard the file on a mismatch as in 1. It MUST NOT treat the
   archive as verified, nor show it as such. It MAY use it (trust on first use): it SHOULD then keep
   the SHA-256 of what it downloaded, for that repo and that file url, and treat a later download of
   the same url whose SHA-256 differs as a mismatch (the file at that address changed since first
   use).
3. A consumer that downloads with `Range` MUST verify the assembled whole before use.
4. A consumer SHOULD revalidate `repo.json` with its `ETag` or `Last-Modified` rather than refetch it.

## 6. Not in revision 1

Signatures, authentication headers, streaming a game from the repo, and a
loose-file layout (games stored unpacked). Archives only.

## 7. Versioning and change log

`schema` is the major version of the document model. A change that old readers can ignore (a new
optional field) does not change it. A change that alters the meaning of an existing field or makes
old readers misbehave raises it, and a reader that does not implement the number fails to load the
repo (§4.2). The revision of this document counts every edit that changes a requirement.

| revision | change |
|---|---|
| 1 | First revision: `schema` 1. Sharding (§3.7) is part of it: nothing was published before it, so `schema` stays 1. |
| 2 | `file.sha256` is optional (SHOULD), `file.sha1` is added (advisory), and §5.2 says how to use an unverified archive. `schema` stays 1: every revision-1 repo is a valid revision-2 repo, and a revision-1 reader skips a Version without `sha256` the way §4.3 skips any malformed entry, so it shows fewer games but loads the repo. |

## 8. Example

```json
{
  "schema": 1,
  "name": "Example Pantry",
  "description": "A few fangames.",
  "homepage": "https://example.com/pantry",
  "updated": "2026-11-15",
  "games": [
    {
      "id": "my-fangame",
      "title": "My Fangame",
      "work": { "delfruit": 1234 },
      "meta": { "author": "Someone", "tags": ["platformer"], "cover": "covers/my-fangame.png" },
      "versions": [
        {
          "version": "1.1",
          "file": {
            "url": "archives/My_Fangame_1.1.zip",
            "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "size": 1048576
          },
          "format": "zip",
          "released": "2026-10-01"
        },
        {
          "version": "1.0",
          "file": {
            "url": "https://mirror.example.org/My_Fangame_1.0.7z",
            "sha256": "1111111111111111111111111111111111111111111111111111111111111111",
            "size": 900000
          }
        }
      ]
    }
  ]
}
```

A sharded repo keeps an entry file like this; its games live in the shards (`size` and `count` here
are illustrative):

```json
{
  "schema": 1,
  "name": "Big Pantry",
  "updated": "2026-11-15",
  "games": [],
  "shards": [
    {
      "url": "shards/3b1f0c9a7d2e4f58.json",
      "sha256": "3b1f0c9a7d2e4f58000000000000000000000000000000000000000000000000",
      "size": 481012,
      "count": 1000
    }
  ]
}
```

The `conformance/` directory holds `repo.json` inputs (and the shard files they list) with the expected games and skipped entries;
a reader implementation SHOULD pass them.

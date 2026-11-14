# GM-Pantry: the game repository format

Revision 1.

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
2. MUST send `Access-Control-Allow-Origin: *` on `repo.json` and on every archive, so that a web
   page on any origin can read them.
3. SHOULD answer `Range` requests on archives with `206 Partial Content`.
4. SHOULD send `ETag` or `Last-Modified` on `repo.json`, so that a consumer can revalidate it cheaply.
5. SHOULD serve `repo.json` as `application/json` and MUST NOT serve an archive as `text/html`.

An implementation SHOULD accept `http` on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) so a
repo can be tried locally. No other plain-`http` URL is valid anywhere in this format.

## 3. Document model

`repo.json` is one UTF-8 JSON object.

### 3.1 Repo

| field | type | |
|---|---|---|
| `schema` | integer | MUST be `1`. |
| `name` | string | MUST be present. |
| `description` | string | MAY. |
| `homepage` | https url | MAY. |
| `updated` | string | MUST be present. ISO-8601 date or timestamp of the last change to the file. |
| `games` | Game[] | MUST be present. MAY be empty. |

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
| `released` | string | MAY. ISO-8601 date. |

File: `url` (string, MAY be relative to `repo.json`), `sha256` (lowercase hex SHA-256 of the archive
bytes, exactly as served), `size` (the archive length in bytes, a non-negative integer).

### 3.5 URLs

A url is resolved against the URL `repo.json` was fetched from, as in RFC 3986. A repo SHOULD use
relative urls for its own files, so that a mirror of the directory is a working repo at its own URL.
After resolution, every url MUST be `https` (§2).

### 3.6 Archives

An archive is stored exactly as the author distributed it. A repo tool MUST NOT modify, recompress
or repack an archive, and the `sha256` is the hash of that unmodified file.

## 4. Reading a repo

A consumer follows these rules, so that one bad entry never hides the rest of a repo.

1. Unknown fields are ignored, at every level. This is how the format grows (§7).
2. If `repo.json` is not an object, `schema` is not `1`, or `name`, `updated` or `games` is missing or
   malformed, the repo fails to load.
3. A Game that is malformed, a duplicate of an earlier `id`, or left with no valid Version is skipped.
   A Version that is malformed is skipped. A skipped entry SHOULD be reported, not silently lost.
4. A malformed advisory field (`description`, `homepage`, `work`, `meta` and its parts, `format`,
   `build`, `notes`, `released`) is dropped; the entry stays.
5. Caps. A value over its cap is malformed. Strings are trimmed first.

| value | cap |
|---|---|
| `name` | 80 characters |
| repo `description` | 280 |
| `games` | 10 000 read; more are ignored |
| `id` | 64, matching `[a-z0-9][a-z0-9._-]*` |
| `title` | 200 |
| `versions` per game | 200 read |
| `version` label | 64 |
| any url | 2048 |
| `meta.description`, `notes` | 2000 |
| `meta.author` | 120 |
| `tags` | 20 of at most 40 characters |
| `screenshots`, `links` | 20 each; `links[].name` 80 |
| `work` | 8 keys; key 32 characters matching `[a-z][a-z0-9_-]*`; string value 128 |

## 5. Using an archive

1. A consumer MUST check the downloaded bytes against `file.size` and `file.sha256`. On a mismatch it
   MUST discard the file and MUST NOT use any part of it.
2. A consumer that downloads with `Range` MUST verify the assembled whole before use.
3. A consumer SHOULD revalidate `repo.json` with its `ETag` or `Last-Modified` rather than refetch it.

## 6. Not in revision 1

Signatures, authentication headers, sharding of `repo.json`, streaming a game from the repo, and a
loose-file layout (games stored unpacked). Archives only.

## 7. Versioning and change log

`schema` is the major version of the document model. A change that old readers can ignore (a new
optional field) does not change it. A change that alters the meaning of an existing field or makes
old readers misbehave raises it, and a reader that does not implement the number fails to load the
repo (§4.2). The revision of this document counts every edit that changes a requirement.

| revision | change |
|---|---|
| 1 | First revision: `schema` 1. |

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

The `conformance/` directory holds `repo.json` inputs with the expected games and skipped entries;
a reader implementation SHOULD pass them.

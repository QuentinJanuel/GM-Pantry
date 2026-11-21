---
sidebar_position: 3
title: Protocol reference
---

# Protocol reference

Protocol **v1**: `schema` is `1`, specification revision 2. This page summarises
[SPEC.md](https://github.com/QuentinJanuel/GM-Pantry/blob/main/SPEC.md), which is normative. `repo.json` is one UTF-8 JSON object.

## Repository

| field | |
|---|---|
| `schema` | Integer, must be `1`. A reader that does not know the number fails to load the repo. |
| `name` | Required. At most 80 characters. |
| `updated` | Required. ISO-8601 date or timestamp of the last change. |
| `games` | Inline games; may be empty. |
| `shards` | Files holding more games. At least one of `games` and `shards` is required; the games are `games` then each shard in order. |
| `description` | Optional, at most 280 characters. |
| `homepage` | Optional https url. |
| `icon` | Optional. An https url, relative allowed, of a small square image that stands for the repository, or the image itself as a base64 `data:image/png`, `data:image/jpeg` or `data:image/webp` url of at most 16384 characters. Advisory. |

## Game

| field | |
|---|---|
| `id` | Required stable slug, unique across the whole repo, matching `[a-z0-9][a-z0-9._-]*`, at most 64 characters. It must never change once published. |
| `title` | Required, at most 200 characters. |
| `versions` | Required, non-empty, newest first. |
| `work` | Optional. Names the abstract game, independent of any repo. |
| `meta` | Optional, advisory. |

### `work`

An object of up to 8 keys. Keys are lowercase identifiers (`[a-z][a-z0-9_-]*`, at most 32 characters); values are strings (at most 128 characters) or
integers. A consumer ignores keys it does not know.

```json
"work": { "delfruit": 1234, "iww": "slug" }
```

### `work.icon` {#work-icon}

A convention on top of `work`, not a field of revision 1: the key `icon` holds a path relative to `repo.json` to a small PNG that stands
for the game, for example `"work": { "icon": "icons/my-fangame.png" }`. As for any `work` value the library keeps it as the string you wrote (it does not
resolve or fetch it), so a consumer resolves it against the url of `repo.json` as it does for any relative url. You upload the file yourself.
The `icon` on the repository itself is the repo icon, a real field.

### `meta`

All advisory: `author` (at most 120 characters), `description` (2000), `tags` (up to 20 of at most 40), `cover` (url),
`screenshots` (up to 20 urls) and `links` (up to 20 of `{ "name": string, "url": url }`). A malformed `meta` field is dropped and the game stays.

## Version

| field | |
|---|---|
| `version` | Required free-form label, at most 64 characters. It is displayed, never compared. |
| `file` | Required: `url` (may be relative) and `size` (bytes). `sha256` (lowercase hex of the archive bytes exactly as served) should be there; it may be left out when hashing costs too much (see [Unverified archives](#unverified-archives)). Optional `sha1`: 40 lowercase hex digits a host reported for the file (Backblaze's `X-Bz-Content-Sha1`); advisory. |
| `format` | Optional `"zip"`, `"7z"` or `"rar"`; if absent the consumer guesses. |
| `build` | Optional claimed SHA-256 of the normalised game payload inside the archive. A hint: recompute it if you need it. |
| `notes` | Optional, at most 2000 characters. |
| `contents` | Optional list of `{ path, size }` for the files inside the archive. Advisory. |
| `readme` | Optional text of the archive's README, at most 20000 characters. Advisory. |
| `released` | Optional ISO-8601 date. |

Archives are stored exactly as distributed. A repo tool never modifies, recompresses or repacks one,
and a consumer checks `size` and `sha256` after downloading and discards the file on a mismatch (also when it assembled the file from `Range` requests).

### Unverified archives

A `file` without `sha256` is unverified. A reader still checks `size` (and `sha1` if given) and discards the file on a mismatch, and must not
treat or show it as verified. It may use it on trust on first use: keep the SHA-256 of what it downloaded for that repo and file url, and treat a later
download whose SHA-256 differs as a mismatch, since the file at that address changed. Readers of revision 1 (gm-pantry 0.6.0 and earlier) skip a
version without `sha256`, and a game left with none, so a repo that uses them is only fully visible to newer readers.

## URLs

A url is resolved against the url `repo.json` was fetched from (RFC 3986). Use relative urls for your own files so a mirror of the directory is
a working repo. After resolution every url must be `https`, except `http` on a loopback host (`localhost`, `127.0.0.1`, `[::1]`).

## Shards

A repo with at most 1 000 games should keep them inline; a larger one lists shards of at most 1 000 games each, sorted by `id`.

```json
{ "url": "shards/3b1f0c9a7d2e4f58.json", "sha256": "<64 hex digits>", "size": 481012, "count": 1000 }
```

`url`, `sha256` and `size` describe the shard file exactly as served; `count` is advisory. The shard file is `{ "games": [...] }`. Urls inside its
games resolve against `repo.json`, not the shard. A shard is named `shards/<first 16 hex digits of its sha256>.json` and never rewritten, so a cache may keep it
forever. A consumer must check a shard's size and hash and must not use any part of one that fails.

## Reading rules

- Unknown fields are ignored at every level.
- `repo.json` fails to load if it is not an object, `schema` is not `1`, or `name`, `updated` or `games` is missing or malformed.
- A malformed game, a duplicate `id` (the first wins) or a game left with no valid version is skipped; a malformed version is skipped. Skips should be reported.
- A malformed advisory field (`file.sha1` among them) is dropped and the entry stays. A `file.sha256` that is present but malformed skips its version.
- A bad shard (unreachable, wrong size or hash, not `{ "games": [...] }`) is skipped and reported; the rest loads.
- Caps: a value over its cap is malformed. Beyond 2 000 games per file, 1 000 shards, or 200 versions per game, the extras are ignored.

## Hosting requirements

HTTPS; `Access-Control-Allow-Origin: *` on `repo.json`, every shard and every archive. Recommended: `206` answers to `Range` on archives, `ETag` or `Last-Modified` on
`repo.json`, `application/json` for `repo.json` and shards, and `Cache-Control: public, max-age=31536000, immutable` on shards.

## Versioning

`schema` is the major version of the document model. Adding an optional field does not change it; changing the meaning of a field does. Not in v1: signatures,
authentication headers, streaming a game from the repo, loose-file games.

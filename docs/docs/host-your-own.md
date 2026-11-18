---
sidebar_position: 2
title: Host your own repository
---

# Host your own repository

You need a folder of archives, a public HTTPS location for it, and Node 24 or newer for the CLI.

## 1. Build `repo.json`

```bash
npx gm-pantry init my-pantry --name "My Pantry"
cp My_Fangame.zip my-pantry/
npx gm-pantry build my-pantry
npx gm-pantry validate my-pantry
```

`build` hashes every `.zip`, `.7z` and `.rar` at the top of the folder, derives each game's id and title from the
file name, and writes `repo.json`. An existing `repo.json` is kept: hand-edited metadata, other versions and unknown fields survive, and a changed archive only
has its hash and size refreshed. It never deletes an entry unless you pass `--prune`. Above `--shard-size` games (default 1000) it writes shards. `add` puts one
archive in as a new newest version (it refuses a sharded repo: put the archive in the folder and run `build`).

`validate` reports every skipped entry, and for a folder also loads every shard and re-checks each archive's hash.

## 2. Create a bucket

Any S3-compatible storage works: Amazon S3, Cloudflare R2, Backblaze B2. Serve it publicly over HTTPS
(the provider's public domain is fine) and put the repo under a key prefix if you like. You need an
access key allowed to list, write and delete objects.

## 3. Allow CORS

A web page can only read the bucket once the bucket allows it, so set a rule once. Reading needs `GET` and `HEAD`:

```json
[{ "AllowedOrigins": ["*"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"], "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"], "MaxAgeSeconds": 86400 }]
```

Publishing from a web page needs more (`PUT`, `POST`, `DELETE`, the request headers the publisher sends, and `ETag`
exposed); and prefer your web app's origin over `*` for that. Print the complete snippets for each provider, and
optionally apply them (needs a key allowed to call `PutBucketCors`):

```bash
npx gm-pantry cors --endpoint https://<account>.r2.cloudflarestorage.com --bucket my-bucket --region auto --origin https://my-app.example
npx gm-pantry cors ... --apply
```

Pass `--public-url` to also check what a browser would see. The snippets come from the providers'
documentation and were tested against a fake S3, not the real services.

## 4. Publish

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
npx gm-pantry publish my-pantry --endpoint https://<account>.r2.cloudflarestorage.com --bucket my-bucket --region auto --prefix games
```

`publish` builds the folder as `build` does, checks the connection first (bad credentials, wrong region,
missing bucket and missing permissions are reported separately), then uploads archives (multipart above 16 MiB; an archive the bucket already holds
with the same size and hash is skipped), new shards, and `repo.json` last. Shards nothing lists any more are deleted afterwards, so a
reader never sees a `repo.json` that points at a missing file. `--path-style` or `--virtual-host` forces the addressing style.

The CLI uploads archives, shards and `repo.json` only. Files you reference otherwise, such as
[game icons](./protocol#work-icon), a repo icon or covers, you upload yourself, next to `repo.json` at the relative path you wrote.

## 5. Check the hosting

```bash
npx gm-pantry validate https://pub.example.com/games/repo.json --hosting
```

It fetches `repo.json` and a sample archive and checks CORS, `Range`, content types and validators. The url of `repo.json` is now
your repository's identity: hand it to whoever should use it. `repo.json` is the only mutable file; serve it with `Cache-Control: no-cache`
(`publish` sets it, and `Cache-Control: public, max-age=31536000, immutable` on shards).

Other hosts work too: GitHub Pages already sends `Access-Control-Allow-Origin: *` (mind its size limits).

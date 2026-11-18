---
sidebar_position: 1
slug: /
title: Introduction
---

# GM-Pantry

GM-Pantry is a format for game repositories, with a TypeScript library, a validator and a CLI. The
protocol is **v1** (`schema` 1, specification revision 1, [SPEC.md](https://github.com/QuentinJanuel/GM-Pantry/blob/main/SPEC.md)).

A repository is a directory of static files served over HTTPS. Its entry point is `repo.json`, and the
URL of that file is the repository's identity. It lists games, each game lists versions, and each
version points at one archive (`.zip`, `.7z` or `.rar`), stored exactly as it was distributed.

## What it offers

- **No server.** A repo is files: any static host or S3-compatible bucket serves one, and a copy of the
  directory is a working repo (file urls may be relative).
- **Integrity.** Every archive carries its size and SHA-256, and a consumer discards a download that does not match.
- **Resilience.** Unknown fields are ignored, and a malformed game or version is skipped and reported while the
  rest of the repo still loads.
- **Scale.** A big repo lists content-addressed shards of at most 1 000 games each instead of inlining its games.
- **Tooling.** `npx gm-pantry` builds, validates, publishes and checks CORS; the library runs in
  browsers and Node (the CLI needs Node 24 or newer).

## What it requires

- HTTPS, and `Access-Control-Allow-Origin: *` on `repo.json`, every shard and every archive. See
  [Host your own repository](./host-your-own).
- Nothing lists or indexes repositories: a consumer is given a URL, and a private repo is an unguessable URL.

Not in v1: signatures, authentication headers, streaming a game from the repo, and unpacked (loose-file) games.

## Where next

1. [Host your own repository](./host-your-own): a bucket, CORS, `repo.json`, publishing.
2. [Protocol reference](./protocol): every field of `repo.json`.
3. [API and CLI reference](./api): the package exports and the commands.

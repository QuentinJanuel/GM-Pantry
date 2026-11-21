# GM-Pantry

A format for game repositories: a static directory served over HTTPS that lists game archives, with
a TypeScript library, a validator and a CLI. The protocol is v1: the specification is [SPEC.md](SPEC.md), at revision 1.

**Documentation: https://quentinjanuel.github.io/GM-Pantry/** (hosting your own repository, the protocol reference, the API and CLI).

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

- Archives are stored exactly as distributed and are never modified. Their size and sha256 are checked after
  download; a mismatch discards the file. An archive listed without a sha256 is unverified (SPEC.md §5).
- File urls may be relative, so a mirror of the directory is a working repo.
- Unknown fields are ignored; a malformed game or version is skipped and the rest of the repo still loads.
- A big repo lists content-addressed `shards` (files of at most 1 000 games) instead of inlining its
  games; a bad or tampered shard is skipped and the rest still loads.
- Nothing lists or indexes repos. A private repo is an unguessable URL.

## Quick start

```
npx gm-pantry init my-pantry
npx gm-pantry build my-pantry
npx gm-pantry validate my-pantry
```

## Development

```
pnpm install
pnpm run typecheck && pnpm test && pnpm run build
```

`conformance/` holds `repo.json` inputs with their expected result; a reader in any language can use them.
The documentation site lives in `docs/` (its own pnpm project: `cd docs && pnpm install && pnpm dev`).

MIT licensed.

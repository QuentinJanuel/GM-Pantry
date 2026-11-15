// The types of SPEC.md §3. A parsed Repo has every url resolved to an absolute one.

export type Format = "zip" | "7z" | "rar";

export interface ArchiveFile {
  url: string;
  /** Lowercase hex SHA-256 of the archive, exactly as stored. */
  sha256: string;
  /** Bytes. */
  size: number;
}

export interface Version {
  version: string;
  file: ArchiveFile;
  format?: Format;
  /** Claimed hash of the normalised game payload; a hint, consumers recompute. */
  build?: string;
  notes?: string;
  /** What is inside the archive, so a consumer can tell what it holds without downloading it. Advisory. */
  contents?: { path: string; size: number }[];
  /** The archive's README text, so it can be shown without downloading the archive. Advisory. */
  readme?: string;
  /** YYYY-MM-DD, or a full ISO-8601 timestamp. */
  released?: string;
}

export interface Meta {
  author?: string;
  description?: string;
  tags?: string[];
  cover?: string;
  screenshots?: string[];
  links?: { name: string; url: string }[];
}

export interface Game {
  id: string;
  title: string;
  work?: Record<string, string | number>;
  meta?: Meta;
  /** Non-empty, newest first. */
  versions: Version[];
}

/** A file of games listed by repo.json. Content-addressed: its bytes must hash to `sha256`. */
export interface Shard {
  url: string;
  /** Lowercase hex SHA-256 of the shard file, exactly as stored. */
  sha256: string;
  /** Bytes. */
  size: number;
  /** Number of games in it; advisory. */
  count?: number;
}

export interface Repo {
  schema: 1;
  name: string;
  description?: string;
  homepage?: string;
  /** A small square image (https url, relative ok) that stands for the repository. Advisory. */
  icon?: string;
  updated: string;
  /** Inline games; with `shards`, these come first. */
  games: Game[];
  shards?: Shard[];
}

/** Something skipped or dropped while parsing; `path` is a JSON path such as `games[3].versions[0]`. */
export interface Warning {
  path: string;
  message: string;
}

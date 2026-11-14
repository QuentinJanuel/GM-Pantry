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

export interface Repo {
  schema: 1;
  name: string;
  description?: string;
  homepage?: string;
  updated: string;
  games: Game[];
}

/** Something skipped or dropped while parsing; `path` is a JSON path such as `games[3].versions[0]`. */
export interface Warning {
  path: string;
  message: string;
}

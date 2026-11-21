// SPEC.md §5: the size and hash check on a downloaded archive. Runs in a browser.

import { hashStream, sha1Hex, sha256Hex, type HashOptions } from "./hash.ts";
import type { ArchiveFile } from "./types.ts";

export type VerifyResult =
  /** Nothing contradicts the entry. `verified` is true only when `sha256` matched the entry's; without one it is the
   *  hash just computed, for the consumer to pin (trust on first use), never a proof the bytes are the publisher's. */
  | { ok: true; verified: boolean; sha256: string }
  | { ok: false; reason: "size" | "sha256" | "sha1"; expected: string | number; actual: string | number };

/**
 * Checks bytes against a `file` entry: size first, then sha256, or, when the entry has none, its advisory sha1 if any.
 * A consumer discards the archive on `ok: false`. A Blob or stream is hashed chunk by chunk, never buffered whole.
 */
export async function verifyArchive(
  data: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
  file: Pick<ArchiveFile, "sha256" | "size" | "sha1">,
  options?: HashOptions,
): Promise<VerifyResult> {
  const sha1 = !file.sha256 && !!file.sha1;
  let actual: { sha256: string; size: number; sha1?: string };
  if (data instanceof ReadableStream || data instanceof Blob) {
    actual = await hashStream(data instanceof Blob ? data.stream() : data, { ...options, sha1 });
  } else {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength !== file.size) return { ok: false, reason: "size", expected: file.size, actual: bytes.byteLength };
    actual = { sha256: await sha256Hex(bytes), size: bytes.byteLength, ...(sha1 && { sha1: await sha1Hex(bytes) }) };
  }
  if (actual.size !== file.size) return { ok: false, reason: "size", expected: file.size, actual: actual.size };
  if (file.sha256) {
    return actual.sha256 === file.sha256
      ? { ok: true, verified: true, sha256: actual.sha256 }
      : { ok: false, reason: "sha256", expected: file.sha256, actual: actual.sha256 };
  }
  if (sha1 && actual.sha1 !== file.sha1) return { ok: false, reason: "sha1", expected: file.sha1!, actual: actual.sha1! };
  return { ok: true, verified: false, sha256: actual.sha256 };
}

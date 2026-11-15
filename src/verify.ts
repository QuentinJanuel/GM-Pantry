// SPEC.md §6: the sha256 check on a downloaded archive. Runs in a browser.

import { hashStream, sha256Hex, type HashOptions } from "./hash.ts";
import type { ArchiveFile } from "./types.ts";

export type VerifyResult = { ok: true } | { ok: false; reason: "size" | "sha256"; expected: string | number; actual: string | number };

/**
 * Checks bytes against a `file` entry: size first, then sha256. A consumer discards the archive on `ok: false`.
 * A Blob or stream is hashed chunk by chunk, never buffered whole.
 */
export async function verifyArchive(
  data: Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
  file: Pick<ArchiveFile, "sha256" | "size">,
  options?: HashOptions,
): Promise<VerifyResult> {
  let actual: { sha256: string; size: number };
  if (data instanceof ReadableStream || data instanceof Blob) {
    actual = await hashStream(data instanceof Blob ? data.stream() : data, options);
  } else {
    const bytes = new Uint8Array(data);
    if (bytes.byteLength !== file.size) return { ok: false, reason: "size", expected: file.size, actual: bytes.byteLength };
    actual = { sha256: await sha256Hex(bytes), size: bytes.byteLength };
  }
  if (actual.size !== file.size) return { ok: false, reason: "size", expected: file.size, actual: actual.size };
  return actual.sha256 === file.sha256 ? { ok: true } : { ok: false, reason: "sha256", expected: file.sha256, actual: actual.sha256 };
}

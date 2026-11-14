// SPEC.md §6: the sha256 check on a downloaded archive. Web Crypto only, so it runs in a browser.

import type { ArchiveFile } from "./types.ts";

export type VerifyResult = { ok: true } | { ok: false; reason: "size" | "sha256"; expected: string | number; actual: string | number };

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Checks bytes against a `file` entry: size first, then sha256. A consumer discards the archive on `ok: false`.
 * shortcut: a stream is buffered whole (Web Crypto has no incremental digest), upgrade when archives outgrow memory.
 */
export async function verifyArchive(
  data: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>,
  file: Pick<ArchiveFile, "sha256" | "size">,
): Promise<VerifyResult> {
  const bytes = data instanceof ReadableStream
    ? new Uint8Array(await new Response(data).arrayBuffer())
    : new Uint8Array(data);
  if (bytes.byteLength !== file.size) return { ok: false, reason: "size", expected: file.size, actual: bytes.byteLength };
  const actual = hex(await crypto.subtle.digest("SHA-256", bytes));
  return actual === file.sha256 ? { ok: true } : { ok: false, reason: "sha256", expected: file.sha256, actual };
}

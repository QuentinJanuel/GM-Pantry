// Streaming SHA-256 for archives too big to buffer. Web Crypto has no incremental digest, so hash-wasm does the work.
// Browser-safe: no Node APIs.

import { createSHA256 } from "hash-wasm";

export interface HashOptions {
  /** Called after every chunk with the bytes hashed so far. */
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
}

export interface Hashed {
  sha256: string;
  size: number;
}

/** Hashes a stream chunk by chunk; memory use is one chunk, whatever the size. */
export async function hashStream(stream: ReadableStream<Uint8Array>, { onProgress, signal }: HashOptions = {}): Promise<Hashed> {
  const hasher = await createSHA256();
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      onProgress?.(size);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return { sha256: hasher.digest(), size };
}

/** Hashes a Blob or File (a 4 GB file works: it is read as a stream, never as one buffer). */
export const hashBlob = (blob: Blob, options?: HashOptions): Promise<Hashed> => hashStream(blob.stream(), options);

/** Lowercase hex SHA-256 of bytes already in memory. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

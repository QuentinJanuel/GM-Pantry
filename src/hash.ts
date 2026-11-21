// Streaming SHA-256 for archives too big to buffer. Web Crypto has no incremental digest, so hash-wasm does the work.
// Browser-safe: no Node APIs.

import { createSHA1, createSHA256 } from "hash-wasm";

export interface HashOptions {
  /** Called after every chunk with the bytes hashed so far. */
  onProgress?: (bytes: number) => void;
  signal?: AbortSignal;
  /** Also compute a SHA-1, to compare with a host's advisory `file.sha1`. */
  sha1?: boolean;
}

export interface Hashed {
  sha256: string;
  size: number;
  /** Present when `sha1` was asked for. */
  sha1?: string;
}

/** Hashes a stream chunk by chunk; memory use is one chunk, whatever the size. */
export async function hashStream(stream: ReadableStream<Uint8Array>, { onProgress, signal, sha1 }: HashOptions = {}): Promise<Hashed> {
  const hasher = await createSHA256();
  const hasher1 = sha1 ? await createSHA1() : undefined;
  const reader = stream.getReader();
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      hasher1?.update(value);
      size += value.byteLength;
      onProgress?.(size);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  }
  return { sha256: hasher.digest(), size, ...(hasher1 && { sha1: hasher1.digest() }) };
}

/** Hashes a Blob or File (a 4 GB file works: it is read as a stream, never as one buffer). */
export const hashBlob = (blob: Blob, options?: HashOptions): Promise<Hashed> => hashStream(blob.stream(), options);

const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex SHA-256 of bytes already in memory. */
export const sha256Hex = async (bytes: BufferSource): Promise<string> => hex(await crypto.subtle.digest("SHA-256", bytes));

/** Lowercase hex SHA-1 of bytes already in memory. */
export const sha1Hex = async (bytes: BufferSource): Promise<string> => hex(await crypto.subtle.digest("SHA-1", bytes));

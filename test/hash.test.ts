import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { hashBlob, hashStream, verifyArchive } from "../src/index.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A stream of `total` bytes in `chunk`-sized pieces, produced on demand so it never exists whole. */
const synthetic = (total: number, chunk: number, fill: Uint8Array) => {
  let left = total;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (left === 0) return c.close();
      const n = Math.min(left, chunk);
      c.enqueue(n === fill.length ? fill : fill.subarray(0, n));
      left -= n;
    },
  });
};

test("hashBlob matches known vectors and Node's digest", async () => {
  assert.deepEqual(await hashBlob(new Blob([])), { sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", size: 0 });
  assert.equal((await hashBlob(new Blob(["abc"]))).sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const big = randomBytes(10 * 1024 * 1024 + 7);
  const seen: number[] = [];
  const r = await hashBlob(new Blob([big]), { onProgress: (n) => seen.push(n) });
  assert.deepEqual(r, { sha256: sha(big), size: big.length });
  assert.equal(seen.at(-1), big.length);
});

test("hashStream stops on abort", async () => {
  const ac = new AbortController();
  const stream = synthetic(1 << 30, 1 << 20, new Uint8Array(1 << 20));
  await assert.rejects(hashStream(stream, { signal: ac.signal, onProgress: (n) => n >= 8 << 20 && ac.abort() }), { name: "AbortError" });
});

test("a 4 GiB stream hashes in constant memory", { timeout: 120_000 }, async () => {
  const total = 4 * 1024 ** 3;
  const piece = new Uint8Array(8 << 20).fill(7);
  const ref = createHash("sha256");
  for (let i = 0; i < total / piece.length; i++) ref.update(piece);
  const rssBefore = process.memoryUsage().rss;
  let peak = 0;
  const r = await hashStream(synthetic(total, piece.length, piece), { onProgress: () => (peak = Math.max(peak, process.memoryUsage().rss)) });
  assert.deepEqual(r, { sha256: ref.digest("hex"), size: total });
  assert.ok(peak - rssBefore < 512 * 1024 ** 2, `rss grew by ${((peak - rssBefore) / 1024 ** 2).toFixed(0)} MiB`);
});

test("verifyArchive streams a Blob or a stream instead of buffering", async () => {
  const bytes = randomBytes(3 << 20);
  const file = { sha256: sha(bytes), size: bytes.length };
  assert.deepEqual(await verifyArchive(new Blob([bytes]), file), { ok: true });
  assert.deepEqual(await verifyArchive(new Blob([bytes]).stream(), file), { ok: true });
  assert.deepEqual(await verifyArchive(new Blob([bytes]), { ...file, size: 1 }), { ok: false, reason: "size", expected: 1, actual: bytes.length });
  const bad = await verifyArchive(new Blob([bytes]), { ...file, sha256: "0".repeat(64) });
  assert.equal(bad.ok === false && bad.reason, "sha256");
});

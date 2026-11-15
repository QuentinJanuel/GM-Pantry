// Publishing a repo to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Wasabi): `gm-pantry/s3`.
// Browser-safe: SigV4 by aws4fetch, `fetch` for transport, no Node APIs.

import { AwsClient } from "aws4fetch";
import type { Check } from "./hosting.ts";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Key prefix inside the bucket (the repo lives under it). */
  prefix?: string;
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key`. Default: true unless the endpoint is amazonaws.com. */
  forcePathStyle?: boolean;
  /** Transport; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Wait before the first retry of a failed part (doubles each time). Default 500. */
  retryDelayMs?: number;
}

export class S3Error extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

/** repo.json changed under the publisher (or did not match the ETag it was loaded with). */
export class ConflictError extends Error {}

export interface UploadState {
  uploadId: string;
  size: number;
  partSize: number;
  parts: { partNumber: number; etag: string }[];
}

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  /** Stored as `x-amz-meta-<key>`. */
  metadata?: Record<string, string>;
  /** Only write when the current ETag matches. */
  ifMatch?: string;
  /** `"*"`: only write when the key does not exist. */
  ifNoneMatch?: string;
  signal?: AbortSignal;
}

export interface UploadOptions extends Omit<PutOptions, "ifMatch" | "ifNoneMatch"> {
  /** Default 16 MiB; raised so the file fits in 10 000 parts, never below the 5 MiB S3 minimum. */
  partSize?: number;
  /** Parts in flight at once. Default 3. */
  concurrency?: number;
  onProgress?: (uploaded: number, total: number) => void;
  /** Called after the upload is created and after every part: persist it, and pass it back as `resume` after a crash or abort. */
  onState?: (state: UploadState) => void;
  resume?: UploadState;
}

const MiB = 1024 * 1024;
const MAX_PARTS = 10_000;
const encoder = new TextEncoder();
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const xmlUnescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => xmlUnescape(m[1]));

export const choosePartSize = (size: number, requested = 16 * MiB) => Math.max(5 * MiB, requested, Math.ceil(size / MAX_PARTS));

const CONTENT_TYPES: Record<string, string> = { zip: "application/zip", "7z": "application/x-7z-compressed", rar: "application/vnd.rar", json: "application/json" };
export const contentTypeOf = (key: string) => CONTENT_TYPES[key.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export class S3Store {
  private aws: AwsClient;
  private fetchImpl: typeof fetch;
  private prefix: string;
  config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    this.aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, sessionToken: config.sessionToken, service: "s3", region: config.region });
    this.fetchImpl = config.fetch ?? ((...a) => fetch(...a));
    this.prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    if (this.prefix) this.prefix += "/";
  }

  /** The URL of a key under the prefix (`""` is the bucket itself). */
  url(key = "", query: Record<string, string> = {}): URL {
    const { endpoint, bucket, forcePathStyle } = this.config;
    const base = new URL(endpoint);
    const pathStyle = forcePathStyle ?? !base.hostname.endsWith(".amazonaws.com");
    const path = key === "" ? "" : this.prefix + key;
    const encoded = path.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
    const host = pathStyle ? base.origin : `${base.protocol}//${bucket}.${base.host}`;
    const url = new URL(`${host}${pathStyle ? "/" + bucket : ""}/${encoded}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url;
  }

  private async send(method: string, key: string, o: { query?: Record<string, string>; headers?: Record<string, string>; body?: BodyInit; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = new Headers(o.headers);
    // aws4fetch can only hash in-memory bodies; a Blob goes out unsigned-payload (standard for S3 over TLS).
    if (o.body instanceof Blob) headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
    const req = await this.aws.sign(this.url(key, o.query), { method, headers, body: o.body, signal: o.signal });
    const res = await this.fetchImpl(req);
    if (res.ok) return res;
    const text = method === "HEAD" ? "" : await res.text().catch(() => "");
    throw new S3Error(res.status, tags(text, "Code")[0] ?? res.statusText ?? "Error", tags(text, "Message")[0] ?? "");
  }

  private meta(headers?: Record<string, string>, o: PutOptions = {}) {
    const h: Record<string, string> = { ...headers };
    if (o.contentType) h["content-type"] = o.contentType;
    if (o.cacheControl) h["cache-control"] = o.cacheControl;
    if (o.ifMatch) h["if-match"] = o.ifMatch;
    if (o.ifNoneMatch) h["if-none-match"] = o.ifNoneMatch;
    for (const [k, v] of Object.entries(o.metadata ?? {})) h[`x-amz-meta-${k.toLowerCase()}`] = v;
    return h;
  }

  async putObject(key: string, body: string | Uint8Array | Blob, o: PutOptions = {}): Promise<{ etag: string }> {
    const res = await this.send("PUT", key, { headers: this.meta({}, o), body: typeof body === "string" ? body : (body as BodyInit), signal: o.signal });
    return { etag: res.headers.get("etag") ?? "" };
  }

  /** The object's bytes and ETag, or undefined when it does not exist. */
  async getObject(key: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; etag: string } | undefined> {
    try {
      const res = await this.send("GET", key, { signal });
      return { bytes: new Uint8Array(await res.arrayBuffer()), etag: res.headers.get("etag") ?? "" };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return undefined;
      throw e;
    }
  }

  async headObject(key: string, signal?: AbortSignal): Promise<{ etag: string; size: number; metadata: Record<string, string> } | undefined> {
    try {
      const res = await this.send("HEAD", key, { signal });
      const metadata: Record<string, string> = {};
      res.headers.forEach((v, k) => k.startsWith("x-amz-meta-") && (metadata[k.slice(11)] = v));
      return { etag: res.headers.get("etag") ?? "", size: Number(res.headers.get("content-length")), metadata };
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return undefined;
      throw e;
    }
  }

  async deleteObject(key: string, signal?: AbortSignal): Promise<void> {
    await this.send("DELETE", key, { signal });
  }

  /** One page of keys under `sub` (relative to the store prefix). */
  async listKeys(sub = "", maxKeys = 1000): Promise<string[]> {
    const res = await this.send("GET", "", { query: { "list-type": "2", prefix: this.prefix + sub, "max-keys": String(maxKeys) } });
    return tags(await res.text(), "Key").map((k) => k.slice(this.prefix.length));
  }

  // --- multipart ---

  private async createUpload(key: string, o: UploadOptions): Promise<string> {
    const res = await this.send("POST", key, { query: { uploads: "" }, headers: this.meta({}, o), signal: o.signal });
    const id = tags(await res.text(), "UploadId")[0];
    if (!id) throw new S3Error(200, "NoUploadId", "CreateMultipartUpload returned no UploadId");
    return id;
  }

  /** Parts the service already holds for an upload; undefined when the upload no longer exists. */
  private async listParts(key: string, uploadId: string, signal?: AbortSignal): Promise<UploadState["parts"] | undefined> {
    const parts: UploadState["parts"] = [];
    let marker = "0";
    try {
      for (;;) {
        const xml = await (await this.send("GET", key, { query: { uploadId, "part-number-marker": marker }, signal })).text();
        for (const block of tags(xml, "Part")) {
          parts.push({ partNumber: Number(tags(block, "PartNumber")[0]), etag: tags(block, "ETag")[0] });
        }
        const next = tags(xml, "NextPartNumberMarker")[0];
        if (tags(xml, "IsTruncated")[0] !== "true" || !next) return parts;
        marker = next;
      }
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return undefined;
      throw e;
    }
  }

  async abortUpload(key: string, uploadId: string): Promise<void> {
    await this.send("DELETE", key, { query: { uploadId } });
  }

  /** Multipart uploads started and never completed under `sub`. */
  async listUploads(sub = ""): Promise<{ key: string; uploadId: string }[]> {
    const xml = await (await this.send("GET", "", { query: { uploads: "", prefix: this.prefix + sub } })).text();
    return tags(xml, "Upload").map((u) => ({ key: tags(u, "Key")[0].slice(this.prefix.length), uploadId: tags(u, "UploadId")[0] }));
  }

  /** Aborts every incomplete multipart upload under `sub` (they are billed as storage until aborted). Returns how many. */
  async abortIncompleteUploads(sub = ""): Promise<number> {
    const uploads = await this.listUploads(sub);
    for (const u of uploads) await this.abortUpload(u.key, u.uploadId);
    return uploads.length;
  }

  /**
   * Uploads a Blob or File: one PUT when it fits in a part, else a resumable multipart upload.
   * Aborting through `signal` leaves the upload in place so `resume` can continue it; `abortUpload` discards it.
   */
  async uploadFile(key: string, blob: Blob, o: UploadOptions = {}): Promise<{ etag: string; multipart: boolean }> {
    const partSize = choosePartSize(blob.size, o.partSize);
    if (blob.size <= partSize) {
      const { etag } = await this.putObject(key, blob, o);
      o.onProgress?.(blob.size, blob.size);
      return { etag, multipart: false };
    }
    let state: UploadState | undefined;
    let done = new Map<number, string>();
    if (o.resume?.size === blob.size && o.resume.partSize === partSize) {
      const held = await this.listParts(key, o.resume.uploadId, o.signal);
      if (held) { state = o.resume; done = new Map(held.map((p) => [p.partNumber, p.etag])); }
    }
    if (!state) {
      state = { uploadId: await this.createUpload(key, o), size: blob.size, partSize, parts: [] };
      o.onState?.({ ...state });
    }
    const total = Math.ceil(blob.size / partSize);
    const pending = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !done.has(n));
    let uploaded = [...done.keys()].reduce((sum, n) => sum + Math.min(partSize, blob.size - (n - 1) * partSize), 0);
    o.onProgress?.(uploaded, blob.size);
    const { uploadId } = state;
    let failed = false; // one part giving up stops the others from starting new parts
    const worker = async () => {
      for (let n = pending.shift(); n !== undefined && !failed; n = pending.shift()) {
        o.signal?.throwIfAborted();
        const part = blob.slice((n - 1) * partSize, Math.min(n * partSize, blob.size));
        try {
          done.set(n, await this.retrying(() => this.uploadPart(key, uploadId, n, part, o.signal), o.signal));
        } catch (e) {
          failed = true;
          throw e;
        }
        uploaded += part.size;
        o.onState?.({ ...state, parts: [...done].map(([partNumber, etag]) => ({ partNumber, etag })) });
        o.onProgress?.(uploaded, blob.size);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 3, pending.length) }, worker));
    const body = `<CompleteMultipartUpload>${[...done].sort((a, b) => a[0] - b[0]).map(([n, etag]) => `<Part><PartNumber>${n}</PartNumber><ETag>${xmlEscape(etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const res = await this.send("POST", key, { query: { uploadId }, headers: { "content-type": "application/xml" }, body, signal: o.signal });
    const xml = await res.text();
    // Complete can answer 200 and still carry an <Error>.
    if (xml.includes("<Error>")) throw new S3Error(200, tags(xml, "Code")[0] ?? "Error", tags(xml, "Message")[0] ?? "");
    return { etag: tags(xml, "ETag")[0] ?? "", multipart: true };
  }

  private async uploadPart(key: string, uploadId: string, n: number, part: Blob, signal?: AbortSignal): Promise<string> {
    const res = await this.send("PUT", key, { query: { partNumber: String(n), uploadId }, body: part, signal });
    const etag = res.headers.get("etag");
    if (!etag) throw new S3Error(200, "NoETag", "no ETag on the part response; the bucket CORS must expose ETag");
    return etag;
  }

  private async retrying<T>(fn: () => Promise<T>, signal?: AbortSignal, attempts = 3): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        const transient = e instanceof TypeError || (e instanceof S3Error && e.status >= 500);
        if (!transient || i >= attempts || signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, (this.config.retryDelayMs ?? 500) * 2 ** (i - 1)));
      }
    }
  }

  /** Reports, one check each, whether this key can list, write and delete. Distinguishes bad credentials, a missing bucket, a wrong region and missing permissions. */
  async testConnection(): Promise<{ ok: boolean; checks: Check[] }> {
    const checks: Check[] = [];
    const add = (name: string, status: Check["status"], message: string) => checks.push({ name, status, message });
    const report = () => ({ ok: !checks.some((c) => c.status === "fail"), checks });
    const fatal = (name: string, e: unknown): boolean => {
      if (!(e instanceof S3Error)) return add(name, "fail", `no response (network, wrong endpoint, or CORS not set on the bucket): ${(e as Error).message}`), true;
      if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "InvalidToken", "ExpiredToken"].includes(e.code)) return add(name, "fail", `credentials rejected (${e.code})`), true;
      if (e.code === "NoSuchBucket") return add(name, "fail", "the bucket does not exist"), true;
      if (["AuthorizationHeaderMalformed", "PermanentRedirect", "IllegalLocationConstraintException"].includes(e.code) || e.status === 301) return add(name, "fail", `wrong region or endpoint (${e.code}): ${e.message}`), true;
      return false;
    };
    try {
      await this.listKeys("", 1);
      add("list", "pass", "ListObjectsV2 allowed");
    } catch (e) {
      if (fatal("list", e)) return report();
      add("list", "warn", `listing denied (${(e as S3Error).code}); publishing does not need it, testing and cleaning up incomplete uploads do`);
    }
    const probe = `.gm-pantry-probe-${Math.random().toString(36).slice(2)}`;
    try {
      await this.putObject(probe, "probe", { contentType: "text/plain" });
      add("write", "pass", "PutObject allowed");
    } catch (e) {
      if (!fatal("write", e)) add("write", "fail", `PutObject denied (${(e as S3Error).code}): the key needs s3:PutObject on ${this.prefix || "the bucket"}*`);
      return report();
    }
    try {
      await this.deleteObject(probe);
      add("delete", "pass", "DeleteObject allowed");
    } catch (e) {
      add("delete", "fail", `DeleteObject denied (${(e as S3Error).code}); the probe object ${probe} is left behind and old shards could not be cleaned up`);
    }
    return report();
  }

  /** PutBucketCors. Only usable where CORS is not enforced (Node, the CLI, a desktop app): a browser cannot call it before a CORS rule exists. Replaces the bucket's whole CORS configuration. */
  async setCors(origins: string[] = ["*"]): Promise<void> {
    const r = corsRule(origins);
    const xml = `<CORSConfiguration><CORSRule>${r.origins.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join("")}${r.methods.map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join("")}${r.allowedHeaders.map((h) => `<AllowedHeader>${h}</AllowedHeader>`).join("")}${r.expose.map((h) => `<ExposeHeader>${h}</ExposeHeader>`).join("")}<MaxAgeSeconds>${r.maxAge}</MaxAgeSeconds></CORSRule></CORSConfiguration>`;
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(xml));
    // S3 wants Content-MD5 or a checksum; Web Crypto has no MD5, so SHA-256.
    const checksum = btoa(String.fromCharCode(...new Uint8Array(digest)));
    await this.send("PUT", "", { query: { cors: "" }, headers: { "content-type": "application/xml", "x-amz-checksum-sha256": checksum, "x-amz-sdk-checksum-algorithm": "SHA256" }, body: xml });
  }
}

// --- publishing ---

export interface PublishInput {
  /** The bytes of repo.json, from `serialize`. */
  repoJson: string;
  /** Shard files by repo-relative url, from `serialize`. */
  shards: Map<string, string>;
  /** Shards to delete once repo.json is live, from `serialize`; the ones the remote repo.json lists and the new one does not are added. */
  orphans?: string[];
}

export interface PublishOptions {
  /** Archives to upload before repo.json; `url` is the repo-relative url they are listed under. With `sha256` set, an archive the bucket already holds (same size and recorded hash) is skipped. */
  archives?: { url: string; body: Blob; sha256?: string }[];
  /** The ETag of the repo.json this edit started from (what the caller loaded); null: there was none. Default: whatever is there now. */
  ifMatch?: string | null;
  upload?: Omit<UploadOptions, "resume" | "onState" | "onProgress" | "metadata" | "contentType">;
  /** Persist and return the multipart state per archive url. */
  resume?: (url: string) => UploadState | undefined;
  onState?: (url: string, state: UploadState) => void;
  onProgress?: (url: string, uploaded: number, total: number) => void;
}

export interface PublishResult {
  uploaded: string[];
  skipped: string[];
  deleted: string[];
  /** False: the service ignored conditional writes, so a concurrent publisher could have been overwritten (last writer wins). */
  conditional: boolean;
}

const GENERATED_SHARD = /^shards\/[0-9a-f]{16}\.json$/;
const keyOf = (url: string) => decodeURIComponent(url);

/**
 * Uploads archives and new shards first and repo.json last, so a reader never sees a repo.json that points at missing files;
 * then deletes the shards nothing lists any more. repo.json is written with `If-Match` (or `If-None-Match: *`) where the service supports it.
 */
export async function publishRepo(store: S3Store, input: PublishInput, o: PublishOptions = {}): Promise<PublishResult> {
  const result: PublishResult = { uploaded: [], skipped: [], deleted: [], conditional: true };
  const current = await store.getObject("repo.json");
  const expected = o.ifMatch === undefined ? (current?.etag ?? null) : o.ifMatch;
  if ((current?.etag ?? null) !== expected) throw new ConflictError("repo.json changed since it was loaded; reload and apply the edit again");

  for (const a of o.archives ?? []) {
    const key = keyOf(a.url);
    const head = a.sha256 ? await store.headObject(key) : undefined;
    if (head && head.size === a.body.size && head.metadata.sha256 === a.sha256) { result.skipped.push(a.url); continue; }
    await store.uploadFile(key, a.body, {
      ...o.upload,
      contentType: contentTypeOf(key),
      metadata: a.sha256 ? { sha256: a.sha256 } : undefined,
      resume: o.resume?.(a.url),
      onState: (s) => o.onState?.(a.url, s),
      onProgress: (u, t) => o.onProgress?.(a.url, u, t),
    });
    result.uploaded.push(a.url);
  }
  for (const [url, content] of input.shards) {
    const key = keyOf(url);
    const size = encoder.encode(content).byteLength;
    if ((await store.headObject(key))?.size === size) { result.skipped.push(url); continue; }
    await store.putObject(key, content, { contentType: "application/json", cacheControl: "public, max-age=31536000, immutable" });
    result.uploaded.push(url);
  }

  const guard = expected ? { ifMatch: expected } : { ifNoneMatch: "*" };
  const put = { contentType: "application/json", cacheControl: "no-cache" };
  try {
    await store.putObject("repo.json", input.repoJson, { ...put, ...guard });
  } catch (e) {
    if (e instanceof S3Error && e.status === 412) throw new ConflictError("repo.json changed while publishing; reload and apply the edit again");
    if (!(e instanceof S3Error) || (e.status !== 501 && e.code !== "NotImplemented")) throw e;
    result.conditional = false;
    await store.putObject("repo.json", input.repoJson, put);
  }
  result.uploaded.push("repo.json");

  let previous: string[] = [];
  try {
    previous = (JSON.parse(new TextDecoder().decode(current?.bytes)).shards ?? []).map((s: { url: string }) => s.url);
  } catch { /* no usable previous repo.json: nothing to compare */ }
  const orphans = new Set([...(input.orphans ?? []), ...previous].filter((u) => GENERATED_SHARD.test(u) && !input.shards.has(u)));
  for (const url of orphans) {
    try {
      await store.deleteObject(keyOf(url));
      result.deleted.push(url);
    } catch { /* an orphan that stays is only wasted space */ }
  }
  return result;
}

// --- CORS ---

const corsRule = (origins: string[]) => ({
  origins,
  methods: ["GET", "HEAD", "PUT", "POST", "DELETE"],
  allowedHeaders: ["*"],
  expose: ["ETag", "Content-Length", "Content-Range"],
  maxAge: 3600,
});

/** Ready-to-paste CORS configuration for the services that matter. `origin` is the web app that will publish ("*" for any). */
export function corsSnippets(origin = "*") {
  const r = corsRule([origin]);
  const s3 = JSON.stringify({ CORSRules: [{ AllowedOrigins: r.origins, AllowedMethods: r.methods, AllowedHeaders: r.allowedHeaders, ExposeHeaders: r.expose, MaxAgeSeconds: r.maxAge }] }, null, 2);
  const r2 = JSON.stringify([{ AllowedOrigins: r.origins, AllowedMethods: r.methods, AllowedHeaders: r.allowedHeaders, ExposeHeaders: r.expose, MaxAgeSeconds: r.maxAge }], null, 2);
  const r2Wrangler = JSON.stringify({ rules: [{ allowed: { origins: r.origins, methods: r.methods, headers: r.allowedHeaders }, exposeHeaders: r.expose, maxAgeSeconds: r.maxAge }] }, null, 2);
  const b2 = JSON.stringify([{ corsRuleName: "gm-pantry", allowedOrigins: r.origins, allowedOperations: ["s3_get", "s3_head", "s3_put", "s3_post", "s3_delete"], allowedHeaders: r.allowedHeaders, exposeHeaders: ["ETag", "Content-Length", "Content-Range"], maxAgeSeconds: r.maxAge }]);
  return {
    s3: { json: s3, command: "aws s3api put-bucket-cors --bucket BUCKET --cors-configuration file://cors.json" },
    r2: { json: r2, wranglerJson: r2Wrangler, command: "npx wrangler r2 bucket cors set BUCKET --file cors.json" },
    b2: { json: b2, command: `b2 bucket update --cors-rules '${b2}' BUCKET allPrivate` },
  };
}

export interface CorsReport {
  ok: boolean;
  checks: Check[];
  snippets: ReturnType<typeof corsSnippets>;
}

const PUT_HEADERS = ["authorization", "cache-control", "content-type", "if-match", "if-none-match", "x-amz-content-sha256", "x-amz-date", "x-amz-meta-sha256", "x-amz-security-token"];

/**
 * What a browser needs from the bucket: repo.json readable with CORS, ETag exposed, Range, and a preflight that allows the PUT, POST and DELETE a publisher sends.
 * `publicBaseUrl` is where the repo is served; the preflight goes to `opts.writeUrl` (the S3 API endpoint the browser uploads to) when that differs.
 * Run from a browser to see exactly what the browser sees; run from Node, `origin` is sent as the Origin header.
 */
export async function checkCors(publicBaseUrl: string, origin = "https://example.com", opts: { writeUrl?: string; fetch?: typeof fetch } = {}): Promise<CorsReport> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const checks: Check[] = [];
  const add = (name: string, status: Check["status"], message: string) => checks.push({ name, status, message });
  const repoUrl = publicBaseUrl.endsWith(".json") ? publicBaseUrl : publicBaseUrl.replace(/\/?$/, "/") + "repo.json";
  const allowsOrigin = (h: Headers) => { const v = h.get("access-control-allow-origin"); return v === "*" || v === origin; };

  try {
    const res = await f(repoUrl, { headers: { Origin: origin } });
    await res.body?.cancel();
    add("repo.json read", res.ok ? "pass" : res.status === 404 ? "warn" : "fail", res.status === 404 ? "no repo.json yet (fine before the first publish)" : `HTTP ${res.status}`);
    add("allow-origin", allowsOrigin(res.headers) ? "pass" : "fail", `Access-Control-Allow-Origin: ${res.headers.get("access-control-allow-origin") ?? "missing"}`);
    const expose = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    add("expose ETag", /(^|[\s,])(etag|\*)($|[\s,])/.test(expose) ? "pass" : "fail", `Access-Control-Expose-Headers: ${expose || "missing"}; ETag is needed to upload large files and to guard repo.json writes`);
  } catch (e) {
    add("repo.json read", "fail", `fetch failed (CORS missing or unreachable): ${(e as Error).message}`);
  }
  try {
    const res = await f(repoUrl, { headers: { Origin: origin, Range: "bytes=0-0" } });
    await res.body?.cancel();
    if (res.status !== 404) add("range", res.status === 206 ? "pass" : "warn", res.status === 206 ? "206 Partial Content" : `Range ignored (HTTP ${res.status}); optional`);
  } catch (e) {
    add("range", "fail", `fetch failed: ${(e as Error).message}`);
  }
  const writeUrl = opts.writeUrl ?? repoUrl;
  for (const method of ["PUT", "POST", "DELETE"]) {
    try {
      const res = await f(writeUrl, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": PUT_HEADERS.join(",") } });
      await res.body?.cancel();
      const list = (h: string) => (res.headers.get(h) ?? "").toLowerCase().split(/[\s,]+/);
      const has = (l: string[], x: string) => l.includes("*") || l.includes(x.toLowerCase());
      const missing = res.ok ? [...(has(list("access-control-allow-methods"), method) ? [] : [method]), ...PUT_HEADERS.filter((h) => !has(list("access-control-allow-headers"), h))] : [];
      const ok = res.ok && allowsOrigin(res.headers) && missing.length === 0;
      add(`preflight ${method}`, ok ? "pass" : "fail", ok ? "allowed" : `HTTP ${res.status}${res.ok || allowsOrigin(res.headers) ? "" : `, refused: the origin, ${method} or a header is not in the bucket's CORS rule`}${missing.length ? `, not allowed: ${missing.join(", ")}` : ""}`);
    } catch (e) {
      add(`preflight ${method}`, "fail", `fetch failed: ${(e as Error).message}`);
    }
  }
  return { ok: !checks.some((c) => c.status === "fail"), checks, snippets: corsSnippets(origin === "https://example.com" ? "*" : origin) };
}

// A small in-process S3 for tests: SigV4 verified for real, path and virtual-host style, multipart with the real 5 MiB rule,
// ETags, conditional writes, CORS preflight, and the 403/404 answers a publisher has to tell apart.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface Obj { body: Buffer; headers: Record<string, string>; etag: string }
export interface Options {
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  /** false: If-Match / If-None-Match answer 501, like a service without conditional writes. */
  conditional?: boolean;
  /** true: an If-Match write always answers 412, like a service that cannot match the ETag it handed out. */
  brokenIfMatch?: boolean;
  /** CORS rule; without it, no CORS header is ever sent and preflights answer 403. */
  cors?: { origins: string[]; methods: string[]; headers: string[]; expose: string[] };
  /** Operations answered with 403 AccessDenied. */
  deny?: Set<"list" | "put" | "delete">;
}

const md5 = (b: Buffer) => createHash("md5").update(b).digest();
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export async function startFakeS3(o: Options = {}) {
  const opt = { bucket: "bkt", accessKeyId: "AKID", secretAccessKey: "SECRET", region: "us-east-1", conditional: true, deny: new Set<string>(), ...o };
  const objects = new Map<string, Obj>();
  const uploads = new Map<string, { key: string; headers: Record<string, string>; parts: Map<number, { body: Buffer; etag: string }> }>();
  const log: string[] = [];
  const state = { styles: new Set<string>(), failNextPart: false, corsPut: false };

  const verify = (req: IncomingMessage, url: URL, rawPath: string): string | undefined => {
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
    if (!m) return "SignatureDoesNotMatch";
    const [, id, day, region, signed, signature] = m;
    if (id !== opt.accessKeyId) return "InvalidAccessKeyId";
    if (region !== opt.region) return "AuthorizationHeaderMalformed";
    const query = [...url.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map((p) => p.join("=")).join("&");
    const headers = signed.split(";").map((h) => `${h}:${String(req.headers[h]).trim()}\n`).join("");
    const canonical = [req.method, rawPath, query, headers, signed, req.headers["x-amz-content-sha256"]].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const sts = ["AWS4-HMAC-SHA256", req.headers["x-amz-date"], scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const key = hmac(hmac(hmac(hmac("AWS4" + opt.secretAccessKey, day), region), "s3"), "aws4_request");
    return createHmac("sha256", key).update(sts).digest("hex") === signature ? undefined : "SignatureDoesNotMatch";
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url!, "http://x");
    const host = (req.headers.host ?? "").split(":")[0];
    let key: string;
    if (host.startsWith(opt.bucket + ".")) { state.styles.add("virtual"); key = decodeURIComponent(url.pathname.slice(1)); }
    else if (url.pathname.startsWith(`/${opt.bucket}`)) { state.styles.add("path"); key = decodeURIComponent(url.pathname.slice(opt.bucket.length + 2)); }
    else return send(res, 404, "NoSuchBucket", "no such bucket");

    const origin = req.headers.origin;
    const rule = opt.cors && origin && (opt.cors.origins.includes("*") || opt.cors.origins.includes(origin)) ? opt.cors : undefined;
    const corsHeaders: Record<string, string> = rule ? { "access-control-allow-origin": origin!, "access-control-expose-headers": rule.expose.join(",") } : {};
    if (req.method === "OPTIONS") {
      const wanted = (req.headers["access-control-request-headers"] as string ?? "").split(",").filter(Boolean);
      const ok = rule && rule.methods.includes(req.headers["access-control-request-method"] as string) && wanted.every((h) => rule.headers.includes("*") || rule.headers.includes(h));
      res.writeHead(ok ? 200 : 403, ok ? { ...corsHeaders, "access-control-allow-methods": rule!.methods.join(","), "access-control-allow-headers": wanted.join(",") } : {});
      return void res.end();
    }
    const out = (status: number, headers: Record<string, string> = {}, payload: string | Buffer = "") => {
      res.writeHead(status, { ...corsHeaders, ...headers });
      res.end(payload);
    };
    const fail = (status: number, code: string, message = code) => send(res, status, code, message, corsHeaders);

    const q = url.searchParams;
    const authed = req.headers.authorization !== undefined;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (authed || !isRead || key === "") {
      const bad = authed ? verify(req, url, url.pathname) : "AccessDenied";
      if (bad) return fail(bad === "AccessDenied" ? 403 : 403, bad);
    }
    const op = `${req.method} ${key}${[...q.keys()].map((k) => (k === "uploadId" || k === "partNumber" || k === "prefix" || k === "list-type" || k === "max-keys" || k === "part-number-marker" ? "" : "?" + k)).join("")}`;
    log.push(op);
    const conditionalHeader = req.headers["if-match"] ?? req.headers["if-none-match"];
    const headersOf = () => {
      const h: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (k === "content-type" || k === "cache-control" || k.startsWith("x-amz-meta-")) h[k] = String(v);
      return h;
    };

    if (key === "") {
      if (req.method === "GET") {
        if (opt.deny.has("list")) return fail(403, "AccessDenied");
        const prefix = q.get("prefix") ?? "";
        if (q.has("uploads")) {
          return out(200, {}, `<ListMultipartUploadsResult>${[...uploads].filter(([, u]) => u.key.startsWith(prefix)).map(([id, u]) => `<Upload><Key>${esc(u.key)}</Key><UploadId>${id}</UploadId></Upload>`).join("")}</ListMultipartUploadsResult>`);
        }
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, Number(q.get("max-keys") ?? 1000));
        return out(200, {}, `<ListBucketResult>${keys.map((k) => `<Contents><Key>${esc(k)}</Key></Contents>`).join("")}</ListBucketResult>`);
      }
      if (req.method === "PUT" && q.has("cors")) { state.corsPut = true; return out(200); }
      return fail(405, "MethodNotAllowed");
    }

    switch (req.method) {
      case "PUT": {
        if (opt.deny.has("put")) return fail(403, "AccessDenied");
        if (q.has("partNumber")) {
          const u = uploads.get(q.get("uploadId")!);
          if (!u) return fail(404, "NoSuchUpload");
          if (state.failNextPart) { state.failNextPart = false; return fail(503, "SlowDown"); }
          const etag = `"${md5(body).toString("hex")}"`;
          u.parts.set(Number(q.get("partNumber")), { body, etag });
          return out(200, { etag });
        }
        const old = objects.get(key);
        if (conditionalHeader !== undefined && !opt.conditional) return fail(501, "NotImplemented", "conditional writes");
        if (req.headers["if-match"] !== undefined && opt.brokenIfMatch) return fail(412, "PreconditionFailed", "At least one of the pre-conditions you specified did not hold");
        if (req.headers["if-match"] !== undefined && old?.etag !== req.headers["if-match"]) return fail(412, "PreconditionFailed");
        if (req.headers["if-none-match"] === "*" && old) return fail(412, "PreconditionFailed");
        const etag = `"${md5(body).toString("hex")}"`;
        objects.set(key, { body, headers: headersOf(), etag });
        return out(200, { etag });
      }
      case "POST": {
        if (q.has("uploads")) {
          const id = randomUUID();
          uploads.set(id, { key, headers: headersOf(), parts: new Map() });
          return out(200, {}, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        }
        const u = uploads.get(q.get("uploadId") ?? "");
        if (!u) return fail(404, "NoSuchUpload");
        const wanted = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag>/g)].map((m) => [Number(m[1]), m[2].replace(/&quot;/g, '"')] as const);
        const parts = wanted.map(([n, etag]) => ({ n, p: u.parts.get(n), etag }));
        if (parts.some((x) => !x.p || x.p.etag !== x.etag)) return fail(400, "InvalidPart");
        if (parts.slice(0, -1).some((x) => x.p!.body.length < 5 * 1024 * 1024)) return fail(400, "EntityTooSmall");
        const all = Buffer.concat(parts.map((x) => x.p!.body));
        const etag = `"${createHash("md5").update(Buffer.concat(parts.map((x) => md5(x.p!.body)))).digest("hex")}-${parts.length}"`;
        objects.set(key, { body: all, headers: u.headers, etag });
        uploads.delete(q.get("uploadId")!);
        return out(200, {}, `<CompleteMultipartUploadResult><ETag>${esc(etag)}</ETag></CompleteMultipartUploadResult>`);
      }
      case "DELETE": {
        if (q.has("uploadId")) return uploads.delete(q.get("uploadId")!) ? out(204) : fail(404, "NoSuchUpload");
        if (opt.deny.has("delete")) return fail(403, "AccessDenied");
        objects.delete(key);
        return out(204);
      }
      case "GET": case "HEAD": {
        if (q.has("uploadId")) {
          const u = uploads.get(q.get("uploadId")!);
          if (!u) return fail(404, "NoSuchUpload");
          return out(200, {}, `<ListPartsResult><IsTruncated>false</IsTruncated>${[...u.parts].sort((a, b) => a[0] - b[0]).map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${esc(p.etag)}</ETag></Part>`).join("")}</ListPartsResult>`);
        }
        const o2 = objects.get(key);
        if (!o2) return req.method === "HEAD" ? out(404) : fail(404, "NoSuchKey");
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
        const slice = range ? o2.body.subarray(Number(range[1]), range[2] ? Number(range[2]) + 1 : undefined) : o2.body;
        const h = { ...o2.headers, etag: o2.etag, "content-length": String(slice.length) };
        res.writeHead(range ? 206 : 200, { ...corsHeaders, ...h });
        return void res.end(req.method === "HEAD" ? undefined : slice);
      }
    }
    return fail(405, "MethodNotAllowed");
  });

  function send(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/xml", ...headers });
    res.end(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`);
  }

  await new Promise<void>((r) => server.listen(0, "::", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    endpoint: `http://127.0.0.1:${port}`,
    /** The same server addressed as bucket.localhost, for virtual-host style. */
    virtualEndpoint: `http://localhost:${port}`,
    config: { region: opt.region, bucket: opt.bucket, accessKeyId: opt.accessKeyId, secretAccessKey: opt.secretAccessKey },
    objects, uploads, log, state,
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

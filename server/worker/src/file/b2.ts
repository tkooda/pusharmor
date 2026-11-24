// Backblaze B2 file store over its S3 API, signed with AWS SigV4. Uploads stream the body with
// UNSIGNED-PAYLOAD plus x-amz-checksum-sha256 (the client-declared SHA-256), so B2 checks the
// hash and stores nothing on a mismatch. Error codes seen on B2: BadDigest and IncompleteBody
// (body does not match the hash or length); a daily cap is a 403 whose message says the cap
// was exceeded. Credentials and signatures are never logged.
import { signV4 } from "../auth/sigv4";
import type { FileStore, GetResult, PutResult, RemoveResult, Version } from "./store";

export interface B2Config {
  keyId: string;
  appKey: string;
  bucket: string;
  endpoint: string; // https://s3.<region>.backblazeb2.com
  region: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const UNSIGNED = "UNSIGNED-PAYLOAD";
const PAGE = 1000; // DeleteObjects batch size and list page size

// Thrown for any B2 reply the store does not map (the route answers 502 or 503).
export class B2Error extends Error {
  constructor(readonly status: number, readonly code: string) {
    super("b2 " + status + " " + code);
  }
}

function b64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function unxml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp);/g, (_m, e: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e]!);
}

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

// Inner text of every <name>...</name> element (no nesting of the same name in S3 replies).
function tags(text: string, name: string): string[] {
  return [...text.matchAll(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">", "g"))].map((m) => m[1]);
}

function tag(text: string, name: string): string | undefined {
  const t = tags(text, name)[0];
  return t === undefined ? undefined : unxml(t);
}

// "cap": a B2 daily cap (storage, download bandwidth, or a transaction class).
async function failure(res: Response): Promise<{ code: string; cap: boolean }> {
  const text = await res.text().catch(() => "");
  const code = tag(text, "Code") ?? "";
  const msg = tag(text, "Message") ?? "";
  return { code, cap: res.status === 403 && /cap exceeded/i.test(msg) };
}

export class B2Store implements FileStore {
  constructor(
    private readonly cfg: B2Config,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async call(method: string, key: string | null, query: string, headers: Record<string, string>, body?: BodyInit): Promise<Response> {
    const url = this.cfg.endpoint + "/" + this.cfg.bucket + (key === null ? "" : "/" + key) + (query ? "?" + query : "");
    const signed = await signV4({
      method,
      url,
      headers: { ...headers, "x-amz-content-sha256": UNSIGNED },
      body: new Uint8Array(0),
      payloadHash: UNSIGNED,
      accessKeyId: this.cfg.keyId,
      secretAccessKey: this.cfg.appKey,
      region: this.cfg.region,
      service: "s3",
      now: new Date(),
    });
    return this.fetchFn(url, { method, headers: signed, body, redirect: "manual" });
  }

  async put(key: string, body: ReadableStream<Uint8Array>, length: number, sha256: Uint8Array): Promise<PutResult> {
    // A fixed-length stream sends Content-Length and fails if the body is shorter or longer.
    const { readable, writable } = new FixedLengthStream(length);
    body.pipeTo(writable).catch(() => {});
    const res = await this.call("PUT", key, "", { "content-type": "application/octet-stream", "x-amz-checksum-sha256": b64(sha256) }, readable);
    if (res.ok) {
      await res.body?.cancel();
      return "ok";
    }
    const f = await failure(res);
    if (f.cap) return "cap";
    if (res.status === 400 && (f.code === "BadDigest" || f.code === "IncompleteBody")) return "mismatch";
    throw new B2Error(res.status, f.code);
  }

  async get(key: string, range: string | null): Promise<GetResult> {
    const res = await this.call("GET", key, "", range === null ? {} : { range });
    if (res.status === 200 || res.status === 206) {
      return {
        status: res.status,
        body: res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
        length: Number(res.headers.get("Content-Length") ?? 0),
        contentRange: res.headers.get("Content-Range"),
        etag: res.headers.get("ETag"),
      };
    }
    const f = await failure(res);
    if (f.cap) return "cap";
    if (res.status === 404) return "missing";
    if (res.status === 416) return "range";
    throw new B2Error(res.status, f.code);
  }

  // Every version (and delete marker) of the keys under prefix, all pages.
  async listVersions(prefix: string): Promise<Version[] | "cap"> {
    const out: Version[] = [];
    let marker: { key: string; version: string } | null = null;
    for (;;) {
      let q = "versions&max-keys=" + PAGE + "&prefix=" + encodeURIComponent(prefix);
      if (marker) q += "&key-marker=" + encodeURIComponent(marker.key) + "&version-id-marker=" + encodeURIComponent(marker.version);
      const res = await this.call("GET", null, q, {});
      if (!res.ok) {
        const f = await failure(res);
        if (f.cap) return "cap";
        throw new B2Error(res.status, f.code);
      }
      const text = await res.text();
      for (const el of [...tags(text, "Version"), ...tags(text, "DeleteMarker")]) {
        const key = tag(el, "Key");
        const versionId = tag(el, "VersionId");
        if (key !== undefined && versionId !== undefined) out.push({ key, versionId });
      }
      if (tag(text, "IsTruncated") !== "true") return out;
      const key = tag(text, "NextKeyMarker");
      const version = tag(text, "NextVersionIdMarker");
      if (key === undefined || version === undefined) throw new B2Error(res.status, "BadPage");
      marker = { key, version };
    }
  }

  // The common prefixes directly under prefix (delimiter "/"), all pages.
  async listPrefixes(prefix: string): Promise<string[] | "cap"> {
    const out: string[] = [];
    let token: string | undefined;
    for (;;) {
      let q = "list-type=2&delimiter=%2F&max-keys=" + PAGE + "&prefix=" + encodeURIComponent(prefix);
      if (token !== undefined) q += "&continuation-token=" + encodeURIComponent(token);
      const res = await this.call("GET", null, q, {});
      if (!res.ok) {
        const f = await failure(res);
        if (f.cap) return "cap";
        throw new B2Error(res.status, f.code);
      }
      const text = await res.text();
      for (const cp of tags(text, "CommonPrefixes")) {
        const p = tag(cp, "Prefix");
        if (p !== undefined) out.push(p);
      }
      if (tag(text, "IsTruncated") !== "true") return out;
      token = tag(text, "NextContinuationToken");
      if (token === undefined) throw new B2Error(res.status, "BadPage");
    }
  }

  // DeleteObjects by key and version id, in batches of 1000. Any per-object error throws.
  async deleteVersions(versions: Version[]): Promise<"ok" | "cap"> {
    for (let i = 0; i < versions.length; i += PAGE) {
      const objs = versions.slice(i, i + PAGE).map((v) => "<Object><Key>" + xml(v.key) + "</Key><VersionId>" + xml(v.versionId) + "</VersionId></Object>");
      const body = new TextEncoder().encode("<Delete><Quiet>true</Quiet>" + objs.join("") + "</Delete>");
      const md5 = new Uint8Array(await crypto.subtle.digest("MD5", body));
      const res = await this.call("POST", null, "delete", { "content-type": "application/xml", "content-md5": b64(md5) }, body);
      if (!res.ok) {
        const f = await failure(res);
        if (f.cap) return "cap";
        throw new B2Error(res.status, f.code);
      }
      const text = await res.text();
      const err = tags(text, "Error")[0];
      if (err !== undefined) throw new B2Error(res.status, tag(err, "Code") ?? "DeleteError");
    }
    return "ok";
  }

  // Deletes every version of one key: one ListObjectVersions (key as prefix), then DeleteObjects.
  async remove(key: string): Promise<RemoveResult> {
    const all = await this.listVersions(key);
    if (all === "cap") return "cap";
    const mine = all.filter((v) => v.key === key);
    if (mine.length === 0) return "missing";
    return this.deleteVersions(mine);
  }
}

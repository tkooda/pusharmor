// AWS Signature Version 4 (header auth), WebCrypto only.

const enc = new TextEncoder();

function hex(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of u) s += x.toString(16).padStart(2, "0");
  return s;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(enc.encode("AWS4" + secret), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(search: string): string {
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (q === "") return "";
  const pairs: [string, string][] = q.split("&").map((p) => {
    const i = p.indexOf("=");
    const n = i < 0 ? p : p.slice(0, i);
    const v = i < 0 ? "" : p.slice(i + 1);
    const dec = (x: string) => decodeURIComponent(x.replace(/\+/g, " "));
    return [uriEncode(dec(n)), uriEncode(dec(v))];
  });
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([n, v]) => n + "=" + v).join("&");
}

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: never;
  region: string;
  service: string;
  now: Date;
}

export function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
): { canonical: string; signedHeaders: string } {
  const h = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) h.set(k.toLowerCase(), v.trim().replace(/ +/g, " "));
  const names = [...h.keys()].sort();
  const canonHeaders = names.map((n) => n + ":" + h.get(n) + "\n").join("");
  const signedHeaders = names.join(";");
  const canonical = [
    method,
    url.pathname,
    canonicalQuery(url.search),
    canonHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  return { canonical, signedHeaders };
}

export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const out: Record<string, string> = { ...input.headers };
  if (!Object.keys(out).some((k) => k.toLowerCase() === "host")) out["host"] = url.host;
  out["x-amz-date"] = amzDate;
  const payloadHash = await sha256Hex(input.body);
  const { canonical, signedHeaders } = canonicalRequest(input.method, url, out, payloadHash);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const sts = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(enc.encode(canonical))].join("\n");
  const key = await deriveSigningKey(input.secretAccessKey, date, input.region, input.service);
  const sig = hex(await hmac(key, sts));
  out["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return out;
}

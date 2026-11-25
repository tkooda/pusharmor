// Capped body read (raw bytes kept for PA-Sig) and strict JSON parse.
import { ApiError } from "../errors";

// Largest valid body: PATCH /peers/$id with 24 name entries (1024 chars) and 24 messages
// (3800 chars), 118000 bytes as JSON, plus a 3740-byte margin. One cap for every route.
export const BODY_CAP = 121740;

export async function readBody(req: Request): Promise<Uint8Array> {
  const cl = req.headers.get("Content-Length");
  if (cl !== null && /^[0-9]+$/.test(cl) && Number(cl) > BODY_CAP) throw new ApiError(413, "too large");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > BODY_CAP) {
      await reader.cancel().catch(() => {});
      throw new ApiError(413, "too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

// Invalid UTF-8 or JSON, or a non-object top level -> 400 "bad request".
export function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new ApiError(400, "bad request");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ApiError(400, "bad request");
  return v as Record<string, unknown>;
}

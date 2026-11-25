// PA-Sig request signing (catalog General).
import { b64urlEncode } from "./b64url.ts";
import { ascii, concat } from "./bytes.ts";
import { sign } from "./keys.ts";

/** "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + raw body bytes */
export function reqSignedBytes(method: string, path: string, paTime: string, body: Uint8Array): Uint8Array {
  if (!path.startsWith("/v1/") || path.includes("?")) throw new Error("bad path");
  if (!/^[0-9]{13}$/.test(paTime)) throw new Error("bad PA-Time");
  return concat(ascii("PA-REQ1\n" + method + "\n" + path + "\n" + paTime + "\n"), body);
}

export async function paSig(signKey: CryptoKey, method: string, path: string, paTime: string, body: Uint8Array): Promise<string> {
  return b64urlEncode(await sign(signKey, reqSignedBytes(method, path, paTime, body)));
}

/** PA-FILE1 signed bytes. POST /v1/file: plus Content-Length, PA-File-SHA256 and PA-Send-ID lines. DELETE /v1/file/<id>: no more lines. */
export function fileSignedBytes(
  method: "POST" | "DELETE",
  path: string,
  paTime: string,
  post?: { length: number; sha256: string; sendId: string },
): Uint8Array {
  if (!/^[0-9]{13}$/.test(paTime)) throw new Error("bad PA-Time");
  let s = "PA-FILE1\n" + method + "\n" + path + "\n" + paTime;
  if (method === "POST") {
    if (path !== "/v1/file" || !post) throw new Error("bad file POST");
    s += "\n" + String(post.length) + "\n" + post.sha256 + "\n" + post.sendId;
  } else if (!/^\/v1\/file\/[0-9]{12}-[0-9a-f]{32}$/.test(path)) throw new Error("bad file path");
  return ascii(s);
}

/** PA-DL1 signed bytes of a file host GET: "PA-DL1\nGET\n" + path + "\n" + PA-Time. Range is not signed. */
export function downloadSignedBytes(path: string, paTime: string): Uint8Array {
  if (!path.startsWith("/v1/") || path.includes("?")) throw new Error("bad path");
  if (!/^[0-9]{13}$/.test(paTime)) throw new Error("bad PA-Time");
  return ascii("PA-DL1\nGET\n" + path + "\n" + paTime);
}

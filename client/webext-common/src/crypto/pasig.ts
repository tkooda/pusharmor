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

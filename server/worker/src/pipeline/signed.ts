// PA-ID / PA-Time / PA-Sig checks (pipeline step 5).
import { b64urlDecode } from "../codec/b64url";
import { importVerifyKey, rawPoint, verifyRaw } from "../crypto/ecdsa";
import { concat, ctEqual, utf8 } from "../crypto/hash";
import { checkPeerIdMac, idKeyhash, keyhash } from "../crypto/ids";
import { ApiError } from "../errors";

export const SKEW_MS = 300_000;

// Step a. Returns the PA-Time header string as received.
export function checkTime(headers: Headers, nowMs: number): string {
  const t = headers.get("PA-Time");
  if (t === null || !/^[1-9][0-9]{12}$/.test(t)) throw new ApiError(400, "bad request");
  if (Math.abs(nowMs - Number(t)) > SKEW_MS) throw new ApiError(401, "clock skew");
  return t;
}

// Step b. Returns PA-ID (MAC verified, no D1).
export async function checkPaId(idSecret: string, headers: Headers): Promise<string> {
  const id = headers.get("PA-ID");
  if (id === null || !(await checkPeerIdMac(idSecret, id))) throw new ApiError(401, "unknown peer");
  return id;
}

// "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + raw body bytes
export function signedBytes(method: string, path: string, paTime: string, body: Uint8Array): Uint8Array {
  return concat(utf8("PA-REQ1\n" + method + "\n" + path + "\n" + paTime + "\n"), body);
}

// Step e. Verifies PA-Sig with sign_pub (stored b64url text).
export async function checkSig(signPub: string, headers: Headers, method: string, path: string, paTime: string, body: Uint8Array): Promise<void> {
  const fail = () => new ApiError(401, "invalid client signature");
  const sigHdr = headers.get("PA-Sig");
  const sig = sigHdr === null || sigHdr.length !== 86 ? null : b64urlDecode(sigHdr);
  const raw = rawPoint(signPub);
  if (!sig || sig.length !== 64 || !raw) throw fail();
  const key = await importVerifyKey(raw);
  if (!key || !(await verifyRaw(key, sig, signedBytes(method, path, paTime, body)))) throw fail();
}

// Step e, second half: keyhash of the stored keys equals the PA-ID keyhash bytes.
export async function checkKeyhash(id: string, signPub: string, encPub: string): Promise<void> {
  const s = rawPoint(signPub);
  const e = rawPoint(encPub);
  if (!s || !e || !ctEqual(await keyhash(s, e), idKeyhash(id))) throw new ApiError(401, "invalid client signature");
}

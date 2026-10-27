// POST /pair/$X: relay of commit, reply and open pair messages. Nothing stored.
import type { Ctx } from "../context";
import { b64urlDecode, b64urlEncode } from "../codec/b64url";
import { bad, keysExactly, PAIR_MESSAGE_LEN } from "../codec/validate";
import { isB64url } from "../codec/b64url";
import { concat, sha256, utf8 } from "../crypto/hash";
import { parseJsonObject } from "../pipeline/body";
import { enforce } from "../pipeline/limits";
import { callerCheck, signedStart, withPushMissing } from "./common";
import { readCtxX, relayOne, targetX } from "./approve";
import { json } from "../http";

const KINDS = ["commit", "reply", "open"];

// pk = b64url(first 16 bytes of sha256("PA-PAIRKEY1\n" || N id || X id)), over the raw 30-byte ids.
export async function pairKey(nId: string, xId: string): Promise<string> {
  return b64urlEncode((await sha256(concat(utf8("PA-PAIRKEY1\n"), b64urlDecode(nId)!, b64urlDecode(xId)!))).slice(0, 16));
}

export async function pair(c: Ctx): Promise<Response> {
  const b = parseJsonObject(c.body);
  keysExactly(b, ["k", "c"]);
  if (typeof b.k !== "string" || !KINDS.includes(b.k)) throw bad();
  if (typeof b.c !== "string" || b.c.length !== PAIR_MESSAGE_LEN || !isB64url(b.c)) throw bad();
  const kind = b.k;
  const msg = b.c;
  const s = await signedStart(c);
  const x = targetX(c, s);
  const { caller, xr } = await readCtxX(c, s, x);
  await callerCheck(c, s, caller);
  const pm = caller!.push === null;
  if (!xr) return json(200, withPushMissing({ r: "unknown" }, pm));
  await enforce(c.env, "RL_PAIR", "pair:" + kind + ":" + s.me + x, c.log);
  if (xr.denies_me === 1) return json(200, withPushMissing({ r: "denied" }, pm));
  let pk: string | undefined;
  if (xr.push_type === 2 || xr.push_type === 5) pk = kind === "reply" ? await pairKey(x, s.me) : await pairKey(s.me, x);
  const r = await relayOne(c, s, xr, msg, "pair", pk);
  return json(200, withPushMissing({ r }, pm));
}

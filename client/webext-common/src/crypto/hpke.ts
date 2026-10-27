// HPKE RFC 9180 base mode: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM,
// single shot. Wire form: enc(65) || ct+tag.
import { Aes128Gcm, Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { buf, concat } from "./bytes.ts";
import { importEcdhPub } from "./keys.ts";

export const ENC_LEN = 65;
export const TAG_LEN = 16;

let suite: CipherSuite | null = null;

function getSuite(): CipherSuite {
  if (!suite) suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
  return suite;
}

/** Suite with AES-128-GCM; only for the RFC 9180 A.3 known-answer test. */
export function rfc9180A3Suite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
}

export async function hpkeSeal(
  recipientPub: Uint8Array,
  info: Uint8Array,
  aad: Uint8Array,
  pt: Uint8Array,
  ikmE?: Uint8Array,
): Promise<Uint8Array> {
  const recipientPublicKey = await importEcdhPub(recipientPub);
  const params: { recipientPublicKey: CryptoKey; info: ArrayBuffer; ekm?: ArrayBuffer } = {
    recipientPublicKey,
    info: buf(info).buffer,
  };
  if (ikmE) params.ekm = buf(ikmE).buffer;
  const r = await getSuite().seal(params, buf(pt).buffer, buf(aad).buffer);
  return concat(new Uint8Array(r.enc), new Uint8Array(r.ct));
}

/** Returns the plaintext, or null on any failure. */
export async function hpkeOpen(
  recipient: CryptoKeyPair,
  info: Uint8Array,
  aad: Uint8Array,
  wire: Uint8Array,
): Promise<Uint8Array | null> {
  if (wire.length < ENC_LEN + TAG_LEN) return null;
  try {
    const pt = await getSuite().open(
      { recipientKey: recipient, enc: buf(wire.subarray(0, ENC_LEN)).buffer, info: buf(info).buffer },
      buf(wire.subarray(ENC_LEN)).buffer,
      buf(aad).buffer,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

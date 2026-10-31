#!/usr/bin/env python3
# PushArmor command-line client, version 0.0.20
"""PushArmor command-line client.

The top part is the core layer: encodings, keys, signed requests, HPKE,
inner messages, name entries, pairing, replay window, RFC 8291 push decrypt
and send-type detection. Pure functions only: no network, no files.
"""

import sys


def check_python(version_info=None):
    """Exit before any import that needs Python 3.9 (this file's syntax parses on 3.6 and later)."""
    if tuple(version_info or sys.version_info)[:2] < (3, 9):
        sys.stderr.write("PushArmor needs Python 3.9 or later.\n")
        sys.exit(2)


check_python()

import hashlib
import hmac
import ipaddress
import json
import re
import unicodedata
import zlib

CRYPTO_MISSING = ("PushArmor needs the Python cryptography package. Install it with: "
                  "python3 -m pip install --user cryptography (or: pipx install PushArmor).")

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except (KeyboardInterrupt, SystemExit):
    raise
except BaseException:  # missing, or broken: no _cffi_backend is ImportError, a Rust panic is BaseException
    sys.stderr.write(CRYPTO_MISSING + "\n")
    sys.exit(1)

VERSION = "0.0.20"

# ---- encodings ----

_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
_B64_INDEX = {c: i for i, c in enumerate(_B64)}


def b64e(b):
    """b64url without padding."""
    out = []
    for i in range(0, len(b), 3):
        chunk = bytes(b[i:i + 3])
        v = int.from_bytes(chunk + bytes(3 - len(chunk)), "big")
        out.append("".join(_B64[(v >> s) & 63] for s in (18, 12, 6, 0))[:len(chunk) + 1])
    return "".join(out)


def b64d(s):
    """Strict canonical b64url decode: URL alphabet, no "=", zero spare bits. Raises ValueError."""
    if not isinstance(s, str) or len(s) % 4 == 1 or any(c not in _B64_INDEX for c in s):
        raise ValueError("b64url: bad input")
    rem = len(s) % 4
    if (rem == 2 and _B64_INDEX[s[-1]] & 0x0F) or (rem == 3 and _B64_INDEX[s[-1]] & 0x03):
        raise ValueError("b64url: spare bits")
    out = bytearray()
    for i in range(0, len(s), 4):
        chunk = s[i:i + 4]
        v = 0
        for c in chunk:
            v = (v << 6) | _B64_INDEX[c]
        v <<= 6 * (4 - len(chunk))
        out += v.to_bytes(3, "big")[:len(chunk) - 1]
    return bytes(out)


def b64ok(s):
    try:
        b64d(s)
        return True
    except ValueError:
        return False


def sha256(*parts):
    return hashlib.sha256(b"".join(p.encode() if isinstance(p, str) else bytes(p) for p in parts)).digest()


def _hmac(key, *parts):
    return hmac.new(key, b"".join(parts), hashlib.sha256).digest()


# ---- keys (P-256: ECDSA sign keys, ECDH enc keys, 65-byte SEC1 public keys) ----

_CURVE = ec.SECP256R1()
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551


def _priv(raw):
    return ec.derive_private_key(int.from_bytes(raw, "big"), _CURVE)


def _pub(raw):
    if len(raw) != 65 or raw[0] != 4:
        raise ValueError("bad public key")
    return ec.EllipticCurvePublicKey.from_encoded_point(_CURVE, bytes(raw))


def _pub_bytes(key):
    n = key.public_numbers()
    return b"\x04" + n.x.to_bytes(32, "big") + n.y.to_bytes(32, "big")


def new_key():
    """-> (private 32-byte scalar, public 65-byte SEC1 point)."""
    k = ec.generate_private_key(_CURVE)
    return k.private_numbers().private_value.to_bytes(32, "big"), _pub_bytes(k.public_key())


def pub_from_priv(priv):
    return _pub_bytes(_priv(priv).public_key())


def is_valid_pub(raw):
    try:
        _pub(raw)
        return True
    except ValueError:
        return False


def sign(priv, data):
    """ECDSA P-256 / SHA-256, raw r||s (64 bytes)."""
    r, s = decode_dss_signature(_priv(priv).sign(bytes(data), ec.ECDSA(hashes.SHA256())))
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def verify(pub, data, sig):
    if len(sig) != 64:
        return False
    try:
        der = encode_dss_signature(int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big"))
        _pub(pub).verify(der, bytes(data), ec.ECDSA(hashes.SHA256()))
        return True
    except (ValueError, InvalidSignature):
        return False


def ecdh(priv, pub):
    return _priv(priv).exchange(ec.ECDH(), _pub(pub))


# ---- peer ids: account(9) || keyhash(12) || mac(9), 40 b64url chars ----

def keyhash(sign_pub, enc_pub):
    return sha256("PA-ID1\n", sign_pub, enc_pub)[:12]


def peer_id(id_secret, account, kh):
    """Server-side construction; the client only parses and checks ids."""
    return account + kh + _hmac(id_secret, account, kh)[:9]


def id_matches(id_raw, account, sign_pub=None, enc_pub=None):
    """Same account prefix and, when keys are given, the keys hash to the keyhash part."""
    return (len(id_raw) == 30 and id_raw[:9] == account
            and (sign_pub is None or id_raw[9:21] == keyhash(sign_pub, enc_pub)))


def peer_keys_ok(id_b64, account, sign_pub, enc_pub):
    """Check a listed peer (GET /v1/peers): valid distinct keys that hash to its id."""
    try:
        id_raw = b64d(id_b64)
    except ValueError:
        return False
    return (is_valid_pub(sign_pub) and is_valid_pub(enc_pub) and sign_pub != enc_pub
            and id_matches(id_raw, account, sign_pub, enc_pub))


def compare_ids(a, b):
    """Unsigned compare of the raw 30 id bytes: -1, 0 or 1."""
    x, y = b64d(a), b64d(b)
    return (x > y) - (x < y)


def id_hex(id_b64):
    """Display form: hex of keyhash || mac (the account part is the same on every device)."""
    return b64d(id_b64)[9:].hex()


def resolve_id(text, ids):
    """Id for a full b64url id or a unique id_hex prefix of >= 6 chars, else None."""
    if text in ids:
        return text
    t = text.lower()
    if len(t) < 6 or not re.fullmatch(r"[0-9a-f]+", t):
        return None
    hits = [i for i in ids if id_hex(i).startswith(t)]
    return hits[0] if len(hits) == 1 else None


# ---- signed requests ----

def request_bytes(method, path, pa_time, body):
    return ("PA-REQ1\n" + method + "\n" + path + "\n" + pa_time + "\n").encode() + body


def sign_request(priv, method, path, pa_time, body):
    """PA-Sig value. path starts with /v1/ and has no query; pa_time is 13-digit unix ms."""
    return b64e(sign(priv, request_bytes(method, path, pa_time, body)))


def verify_request(pub, method, path, pa_time, body, sig):
    if not re.fullmatch(r"[1-9][0-9]{12}", pa_time):
        return False
    return verify(pub, request_bytes(method, path, pa_time, body), sig)


# ---- HPKE (RFC 9180 base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM) ----

_KEM_SUITE = b"KEM\x00\x10"
_HPKE_SUITE = b"HPKE\x00\x10\x00\x01\x00\x02"


def _extract(salt, ikm):
    return _hmac(salt or bytes(32), ikm)


def _expand(prk, info, length):
    t, out, i = b"", b"", 1
    while len(out) < length:
        t = _hmac(prk, t, info, bytes([i]))
        out += t
        i += 1
    return out[:length]


def _lextract(suite, salt, label, ikm):
    return _extract(salt, b"HPKE-v1" + suite + label + ikm)


def _lexpand(suite, prk, label, info, length):
    return _expand(prk, length.to_bytes(2, "big") + b"HPKE-v1" + suite + label + info, length)


def hpke_derive_key_pair(ikm):
    prk = _lextract(_KEM_SUITE, b"", b"dkp_prk", ikm)
    for counter in range(256):
        sk = _lexpand(_KEM_SUITE, prk, b"candidate", bytes([counter]), 32)
        if 0 < int.from_bytes(sk, "big") < _N:
            return sk, pub_from_priv(sk)
    raise ValueError("hpke: DeriveKeyPairError")


def hpke_schedule(dh, enc, pk_r, info):
    """Shared secret and key schedule values for one base-mode context."""
    prk = _lextract(_KEM_SUITE, b"", b"eae_prk", dh)
    shared = _lexpand(_KEM_SUITE, prk, b"shared_secret", enc + pk_r, 32)
    ctx = b"\x00" + _lextract(_HPKE_SUITE, b"", b"psk_id_hash", b"") + _lextract(_HPKE_SUITE, b"", b"info_hash", info)
    secret = _lextract(_HPKE_SUITE, shared, b"secret", b"")
    return {
        "shared_secret": shared,
        "key_schedule_context": ctx,
        "secret": secret,
        "key": _lexpand(_HPKE_SUITE, secret, b"key", ctx, 32),
        "base_nonce": _lexpand(_HPKE_SUITE, secret, b"base_nonce", ctx, 12),
        "exporter_secret": _lexpand(_HPKE_SUITE, secret, b"exp", ctx, 32),
    }


def hpke_seal(pk_r, info, aad, pt, sk_e=None):
    """-> enc(65) || ciphertext+tag. sk_e is for test vectors only; default is a random key."""
    if sk_e is None:
        sk_e, pk_e = new_key()
    else:
        pk_e = pub_from_priv(sk_e)
    ks = hpke_schedule(ecdh(sk_e, pk_r), pk_e, pk_r, info)
    return pk_e + AESGCM(ks["key"]).encrypt(ks["base_nonce"], bytes(pt), aad)


def hpke_open(sk_r, info, aad, wire):
    """Raises ValueError (or InvalidTag) on any failure."""
    if len(wire) < 65 + 16:
        raise ValueError("hpke: short")
    enc = wire[:65]
    ks = hpke_schedule(ecdh(sk_r, enc), enc, pub_from_priv(sk_r), info)
    return AESGCM(ks["key"]).decrypt(ks["base_nonce"], wire[65:], aad)


def _hpke_open_or_none(sk_r, info, aad, wire):
    try:
        return hpke_open(sk_r, info, aad, wire)
    except Exception:
        return None


# ---- strict JSON (duplicate keys, trailing data and invalid UTF-8 reject) ----

class _Num(str):
    """A JSON number kept as its raw token."""


def _pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise ValueError("json: duplicate key")
        d[k] = v
    return d


def _bad_constant(_):
    raise ValueError("json: bad constant")


def parse_strict(b):
    """Raises ValueError on invalid UTF-8, bad JSON, a duplicate key or trailing data."""
    return json.loads(bytes(b).decode("utf-8"), object_pairs_hook=_pairs,
                      parse_int=_Num, parse_float=_Num, parse_constant=_bad_constant)


def counter_n(v):
    """The n counter from its raw token (^[1-9][0-9]*$, <= 2^53 - 1), else None."""
    if not isinstance(v, _Num) or not re.fullmatch(r"[1-9][0-9]*", v):
        return None
    n = int(v)
    return n if n <= 2 ** 53 - 1 else None


# ---- inner messages ----

TYPES = ("url", "text", "tel", "approve", "deny", "remove", "rename", "delete", "logout", "login")
CONTROL_TYPES = ("approve", "rename", "remove", "delete", "logout", "login", "deny")
BUCKETS = (512, 1024, 2048, 3800)
MAX_WIRE = 3800
HPKE_OVERHEAD = 65 + 16
INFLATE_CAP = 16384
CONTENT_CAP = 2048


def wire_chars(n):
    """Unpadded b64url length of n bytes."""
    return -(-n * 4 // 3)


def bucket_for(chars, approve=False):
    """Smallest bucket that holds chars (approve never below 1024), or None."""
    for b in BUCKETS:
        if chars <= b and not (approve and b < 1024):
            return b
    return None


def plaintext_len_for(bucket):
    """HPKE plaintext length (sig included) that fills the bucket exactly."""
    return bucket * 3 // 4 - HPKE_OVERHEAD


def truncate_utf8(s, cap=CONTENT_CAP):
    """The first cap UTF-8 bytes of s, cut on a code point boundary."""
    return s.encode("utf-8")[:cap].decode("utf-8", "ignore")


def deflate(data):
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def inflate_capped(data):
    """Raw inflate; None when invalid, truncated, followed by extra bytes, or over 16384 bytes."""
    d = zlib.decompressobj(-15)
    try:
        out = d.decompress(data, INFLATE_CAP + 1)
    except zlib.error:
        return None
    if len(out) > INFLATE_CAP or not d.eof or d.unused_data:
        return None
    return out


def name_entry_json(e):
    return '{"name":' + json.dumps(e["name"]) + ',"n":' + str(e["n"]) + ',"s":' + json.dumps(e["s"]) + "}"


def msg_json(n, type_, value):
    """Exact inner JSON {"n":N,"<type>":value}, n first. value: str for url/text/tel/remove,
    a name entry (make_name_entry, same n) for approve/rename, 1 for deny/delete/logout/login."""
    v = name_entry_json(value) if type_ in ("approve", "rename") else json.dumps(value)
    return '{"n":' + str(n) + ',"' + type_ + '":' + v + "}"


def msg_signed_bytes(recipient_id, padded_body):
    return ("PA-MSG1\n" + recipient_id + "\n").encode() + padded_body


def build_message(sign_priv, from_id, recipient_id, recipient_enc_pub, pairing_id, json_text, keys=None):
    """Seal one inner message to recipient_id. keys = (sign_pub, enc_pub), for approve only.
    -> b64url wire message; raises ValueError when it cannot fit in 3800 chars."""
    deflated = deflate(json_text.encode("utf-8"))
    flag = b"\x01" + keys[0] + keys[1] if keys else b"\x00"
    body = b64d(from_id) + pairing_id + flag + len(deflated).to_bytes(2, "big") + deflated
    bucket = bucket_for(wire_chars(HPKE_OVERHEAD + 64 + len(body)), approve=bool(keys))
    if bucket is None:
        raise ValueError("message too large")
    padded = body + bytes(plaintext_len_for(bucket) - 64 - len(body))
    sig = sign(sign_priv, msg_signed_bytes(recipient_id, padded))
    return b64e(hpke_seal(recipient_enc_pub, b"PA-MSG1", recipient_id.encode(), sig + padded))


def _content_ok(v):
    return type(v) is str and len(v.encode("utf-8", "surrogatepass")) <= CONTENT_CAP


def open_message(message, own_id, own_enc_priv, own_account, pins):
    """Receive pipeline for one inner message.
    pins: {sender id: {sign_pub, enc_pub, pairing_id (raw 8 bytes), ruling (approved | denied | other),
           window {h, seen} (default empty), history [n of shown content] (default empty)}}.
    -> {outcome: accept | invalid | represent | noop | unreadable, from, type, n, value}.
    On accept the caller stores window_accept(window, n) for the sender."""
    def bad(why):
        return {"outcome": "unreadable", "why": why}

    if len(message) > MAX_WIRE or not b64ok(message):
        return bad("encoding")
    pt = _hpke_open_or_none(own_enc_priv, b"PA-MSG1", own_id.encode(), b64d(message))
    if pt is None:
        return bad("hpke")
    if len(pt) < 64 + 30 + 8 + 1 + 2:
        return bad("short")
    sig, from_raw, pid, flag = pt[:64], pt[64:94], pt[94:102], pt[102]
    off = 103
    if not id_matches(from_raw, own_account):
        return bad("account prefix")
    from_id = b64e(from_raw)
    pin = pins.get(from_id)
    if not pin:
        return bad("unknown sender")
    if flag == 1:
        if len(pt) < off + 130 + 2:
            return bad("short")
        sp, ep = pt[off:off + 65], pt[off + 65:off + 130]
        off += 130
        if not is_valid_pub(sp) or not is_valid_pub(ep) or sp == ep:
            return bad("embedded keys")
        if not id_matches(from_raw, own_account, sp, ep):
            return bad("embedded keyhash")
        if sp != pin["sign_pub"] or ep != pin["enc_pub"]:
            return bad("keys not pinned")
    elif flag != 0:
        return bad("keys flag")
    length = int.from_bytes(pt[off:off + 2], "big")
    off += 2
    if off + length > len(pt):
        return bad("length")
    deflated = pt[off:off + length]
    if any(pt[off + length:]):
        return bad("padding")
    if not verify(pin["sign_pub"], msg_signed_bytes(own_id, pt[64:]), sig):
        return bad("signature")
    if pid != pin["pairing_id"]:
        return bad("pairing id")
    raw = inflate_capped(deflated)
    try:
        obj = parse_strict(raw) if raw is not None else None
    except ValueError:
        obj = None
    if not isinstance(obj, dict) or "n" not in obj:
        return bad("inflate, json or shape")
    n = counter_n(obj["n"])
    if n is None:
        return bad("n")
    type_ = next((t for t in TYPES if t in obj), None)
    if type_ is None:
        return bad("type")
    value = obj[type_]
    if (flag == 1) != (type_ == "approve"):
        return bad("keys flag and type")
    if type_ in ("url", "text", "tel"):
        if not _content_ok(value):
            return bad("content")
    elif type_ in ("approve", "rename"):
        value = check_name_object(value, from_id, own_id, b64e(pid), pin["sign_pub"])
        if not value or value["n"] != n:
            return bad("name entry")
    elif type_ == "remove":
        if type(value) is not str or len(value) != 40 or not b64ok(value):
            return bad("remove id")
    else:
        if not isinstance(value, _Num) or value != "1":
            return bad("flag value")
        value = 1
    window = pin.get("window") or {"h": 0, "seen": []}
    outcome = replay_outcome(window, n, type_, n in pin.get("history", ()))
    if outcome != "accept":
        return {"outcome": outcome, "from": from_id, "type": type_, "n": n}
    if type_ == "approve":
        if pin["ruling"] == "denied":
            return bad("approve from denied")
    elif pin["ruling"] != "approved":
        return bad("sender not approved")
    return {"outcome": "accept", "from": from_id, "type": type_, "n": n, "value": value}


# ---- name entries ----

NAME_RE = re.compile(r"[\x20\x21\x23-\x7e]{1,32}")


def name_signed_bytes(owner_id, recipient_id, pairing_id_b64, n, name_b64):
    return ("PA-NAME1\n" + owner_id + "\n" + recipient_id + "\n" + pairing_id_b64 + "\n" + str(n) + "\n"
            + name_b64).encode()


def make_name_entry(sign_priv, owner_id, recipient_id, pairing_id, n, name):
    """-> {"name", "n", "s"}. name: 1-32 printable ASCII, no double quote."""
    if not NAME_RE.fullmatch(name):
        raise ValueError("bad name")
    name_b64 = b64e(name.encode("ascii"))
    s = sign(sign_priv, name_signed_bytes(owner_id, recipient_id, b64e(pairing_id), n, name_b64))
    return {"name": name_b64, "n": n, "s": b64e(s)}


def check_name_object(o, owner_id, recipient_id, pairing_id_b64, sign_pub):
    """Parsed {name, n, s} (extra keys ignored) -> {"name", "n"} when it verifies, else None."""
    if not isinstance(o, dict) or not all(k in o for k in ("name", "n", "s")):
        return None
    name_b64, s, n = o["name"], o["s"], counter_n(o["n"])
    if type(name_b64) is not str or type(s) is not str or n is None or not b64ok(name_b64) or not b64ok(s):
        return None
    name = b64d(name_b64).decode("latin-1")
    if not NAME_RE.fullmatch(name):
        return None
    if not verify(sign_pub, name_signed_bytes(owner_id, recipient_id, pairing_id_b64, n, name_b64), b64d(s)):
        return None
    return {"name": name, "n": n}


def seal_name_entry(recipient_id, recipient_enc_pub, entry):
    return b64e(hpke_seal(recipient_enc_pub, b"PA-NAME1", recipient_id.encode(), name_entry_json(entry).encode()))


def open_name_entry(ciphertext, own_id, own_enc_priv, owner_id, pin):
    """name_for_me from GET /v1/peers -> {"ok": True, "name", "n"} or {"ok": False}.
    pin: {sign_pub, pairing_id (raw)} of the owner."""
    if len(ciphertext) > 1024 or not b64ok(ciphertext):
        return {"ok": False}
    pt = _hpke_open_or_none(own_enc_priv, b"PA-NAME1", own_id.encode(), b64d(ciphertext))
    try:
        obj = parse_strict(pt) if pt is not None else None
    except ValueError:
        obj = None
    r = check_name_object(obj, owner_id, own_id, b64e(pin["pairing_id"]), pin["sign_pub"])
    return dict(ok=True, **r) if r else {"ok": False}


# ---- pairing (N = initiator, X = other side) ----

CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PAIR_KINDS = {"commit": 1, "reply": 2, "open": 3}
PAIR_WIRE_LEN = 366
PAIR_PLAINTEXT_LEN = 193
PAIR_TIMEOUT_S = 14 * 86400
PAIR_CAP_WINDOW_S = 86400
PAIR_CAP_MAX = 10
PAIR_MAX_OPEN = 9


def commit_hash(sign_pub_n, enc_pub_n, r_n):
    return sha256("PA-SAS1C\n", sign_pub_n, enc_pub_n, r_n)


def fingerprint_hash(sign_n, enc_n, sign_x, enc_x, r_n, r_x):
    return sha256("PA-SAS1\n", sign_n, enc_n, sign_x, enc_x, r_n, r_x)


def crockford20(h):
    """First 20 bits of h as 4 Crockford base32 chars."""
    v = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4)
    return "".join(CROCKFORD[(v >> (i * 5)) & 31] for i in (3, 2, 1, 0))


def sas(sign_n, enc_n, sign_x, enc_x, r_n, r_x):
    """Pairing fingerprint, e.g. "YSWH"."""
    return crockford20(fingerprint_hash(sign_n, enc_n, sign_x, enc_x, r_n, r_x))


def pairing_id(r_n, r_x):
    return sha256("PA-PAIRID1\n", r_n, r_x)[:8]


def commit_body(c_n):
    return c_n + bytes(130)


def keys_body(sign_pub, enc_pub, r):
    return sign_pub + enc_pub + r


def seal_pair(kind, from_id, body, recipient_id, recipient_enc_pub):
    """kind commit | reply | open; body 162 bytes (commit_body or keys_body). -> 366-char "c"."""
    if len(body) != 162:
        raise ValueError("pair body must be 162 bytes")
    pt = bytes([PAIR_KINDS[kind]]) + b64d(from_id) + body
    return b64e(hpke_seal(recipient_enc_pub, b"PA-PAIR1", recipient_id.encode(), pt))


def open_pair(message, own_id, own_enc_priv, own_account):
    """-> {ok, kind, from, c_N} for commit, {ok, kind, from, sign_pub, enc_pub, r} for reply / open,
    or {ok: False}."""
    if len(message) != PAIR_WIRE_LEN or not b64ok(message):
        return {"ok": False}
    pt = _hpke_open_or_none(own_enc_priv, b"PA-PAIR1", own_id.encode(), b64d(message))
    if pt is None or len(pt) != PAIR_PLAINTEXT_LEN:
        return {"ok": False}
    kind = {1: "commit", 2: "reply", 3: "open"}.get(pt[0])
    from_raw, body = pt[1:31], pt[31:]
    if kind is None or not id_matches(from_raw, own_account):
        return {"ok": False}
    if kind == "commit":
        return {"ok": True, "kind": kind, "from": b64e(from_raw), "c_N": body[:32]}
    sp, ep, r = body[:65], body[65:130], body[130:]
    if not is_valid_pub(sp) or not is_valid_pub(ep) or sp == ep or not id_matches(from_raw, own_account, sp, ep):
        return {"ok": False}
    return {"ok": True, "kind": kind, "from": b64e(from_raw), "sign_pub": sp, "enc_pub": ep, "r": r}


def open_matches_commit(opened, stored_c_n):
    """X on open: the open keys and r_N must hash to the stored c_N."""
    return hmac.compare_digest(commit_hash(opened["sign_pub"], opened["enc_pub"], opened["r"]), stored_c_n)


def pair_decide(i):
    """X's decision for a commit push (rules a-e, first match wins).
    i: own_id, from_id, commit_c_N, entry (None or {role N|X, state, c_N, reply_authorized}),
       pinned, approved, approve_verified, approves_me, get_after_verify,
       listed (yes | after_fetch | no), open_entries, cap (list of unix s), now.
    -> {action, notice, entry, cap_counted}."""
    def out(action, notice, entry, counted=False):
        return {"action": action, "notice": notice, "entry": entry, "cap_counted": counted}

    e = i["entry"]
    if e and e["role"] == "X" and e["c_N"] == i["commit_c_N"]:
        if e["state"] != "shown" and e["reply_authorized"]:
            return out("reply", "represent", "unchanged")
        return out("notice", "represent", "unchanged")
    if e and e["role"] == "X" and not i["approved"]:
        return out("abort", "could_not_read", "aborted")
    if e and e["role"] == "N":
        if e["state"] == "committed":
            if compare_ids(i["own_id"], i["from_id"]) < 0:
                return out("drop", "crossing", "unchanged")
            return out("reply", "commit", "n_wiped_x_replied")
        if i["approved"] and not i["approve_verified"]:
            return out("drop", "half_state", "unchanged")
        return out("drop", "could_not_read", "unchanged")
    if i["pinned"] or i["approved"]:
        half = i["pinned"] and (bool(e) or (i["approve_verified"] and i["get_after_verify"]
                                             and i["approves_me"] is False))
        return out("drop", "half_state" if half else "could_not_read", "unchanged")
    if i["listed"] == "no" or i["open_entries"] >= PAIR_MAX_OPEN:
        return out("drop", "could_not_read", "none")
    if sum(1 for t in i["cap"] if i["now"] - t < PAIR_CAP_WINDOW_S) >= PAIR_CAP_MAX:
        return out("prompt", "commit", "created_prompted")
    return out("reply", "commit", "created_replied", True)


def pair_timeout(i):
    """Pairing row at 14 days. i: approve_verified, approved, resend (None | offline | logged out |
    429 | 5xx | 200_c_verified | 200_other). -> keep_pin | drop_pin | resend | keep_waiting | complete."""
    if i["approve_verified"]:
        return "keep_pin"
    if not i["approved"]:
        return "drop_pin"
    if i["resend"] is None:
        return "resend"
    return {"200_c_verified": "complete", "200_other": "drop_pin"}.get(i["resend"], "keep_waiting")


# ---- replay window: h = highest accepted n, seen = accepted n values in (h - 100, h] ----

REPLAY_WINDOW = 100


def window_accept(w, n):
    """New window after accepting a fresh n."""
    if n > w["h"]:
        return {"h": n, "seen": sorted([n] + [m for m in w["seen"] if m > n - REPLAY_WINDOW], reverse=True)}
    return {"h": w["h"], "seen": sorted(w["seen"] + [n], reverse=True)}


def replay_outcome(w, n, type_, in_history):
    """-> accept | invalid | represent | noop."""
    if n <= w["h"] - REPLAY_WINDOW:
        return "invalid"
    if n > w["h"] or n not in w["seen"]:
        return "accept"
    if type_ in CONTROL_TYPES:
        return "noop"
    return "represent" if in_history else "invalid"


# ---- RFC 8291 web push decrypt (aes128gcm, one record, keyid = 65-byte as_public) ----

def webpush_derive(ecdh_secret, auth_secret, ua_public, as_public, salt):
    prk_key = _hmac(auth_secret, ecdh_secret)
    key_info = b"WebPush: info\x00" + ua_public + as_public
    ikm = _hmac(prk_key, key_info, b"\x01")
    prk = _hmac(salt, ikm)
    return {
        "prk_key": prk_key, "key_info": key_info, "ikm": ikm, "prk": prk,
        "cek": _hmac(prk, b"Content-Encoding: aes128gcm\x00\x01")[:16],
        "nonce": _hmac(prk, b"Content-Encoding: nonce\x00\x01")[:12],
    }


def webpush_decrypt(body, ua_priv, auth_secret):
    """Push body -> plaintext. Raises ValueError (or InvalidTag) on any failure."""
    if len(body) < 86 + 17 or body[20] != 65:
        raise ValueError("webpush: bad header")
    salt, as_public = body[:16], body[21:86]
    d = webpush_derive(ecdh(ua_priv, as_public), auth_secret, pub_from_priv(ua_priv), as_public, salt)
    padded = AESGCM(d["cek"]).decrypt(d["nonce"], body[86:], b"")
    end = len(padded.rstrip(b"\x00"))
    if end == 0 or padded[end - 1] != 2:
        raise ValueError("webpush: bad padding delimiter")
    return padded[:end - 1]


# ---- send-type detection: tel: URI > one http(s) URL > phone pattern > text ----

_PHONE = re.compile(r"\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*")
_IPV4 = re.compile(r"[0-9]{1,3}(\.[0-9]{1,3}){3}")
_DATE = re.compile(r"([0-9]{4}([-. ])[0-9]{2}\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\3[0-9]{4})")
_QUAD = re.compile(r"(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}")
_TRIM = "\t\n\f\r \u00a0"
_HOST_FORBIDDEN = set(" #%/:<>?@[\\]^|")
_PATH_ENC = set(b" \"#<>?`{}^")
_QUERY_ENC = set(b" \"#<>'")
_FRAGMENT_ENC = set(b" \"<>`")
_IGNORABLE = ((0xAD, 0xAD), (0x34F, 0x34F), (0x61C, 0x61C), (0x115F, 0x1160), (0x17B4, 0x17B5), (0x180B, 0x180F),
              (0x200B, 0x200F), (0x202A, 0x202E), (0x2060, 0x206F), (0x3002, 0x3002), (0x3164, 0x3164),
              (0xFE00, 0xFE0F), (0xFEFF, 0xFEFF), (0xFFA0, 0xFFA0), (0xFFF0, 0xFFF8), (0x1BCA0, 0x1BCA3),
              (0x1D173, 0x1D17A), (0xE0000, 0xE0FFF))


def is_phone(s):
    t = s.strip(_TRIM)
    if t.startswith("tel:"):
        t = t[4:]
    return bool(_PHONE.fullmatch(t)) and not _IPV4.fullmatch(t) and not _DATE.fullmatch(t)


def _idn_ok(host):
    """A host that UTS 46 would leave as it is (the guard shared by every platform)."""
    if unicodedata.normalize("NFKC", host) != host:
        return False
    for ch in host:
        c = ord(ch)
        if c >= 0x80 and (ch.lower() != ch or any(a <= c <= b for a, b in _IGNORABLE)):
            return False
    return not any(lab and unicodedata.category(lab[0]) in ("Mn", "Mc", "Me") for lab in host.split("."))


def _ascii_host(h):
    """ASCII lowercase, IDN labels to punycode; None when forbidden, mapped, or numeric but not a quad."""
    if any(c in _HOST_FORBIDDEN for c in h) or not _idn_ok(h):
        return None
    labels = []
    for lab in "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in h).split("."):
        labels.append(lab if lab.isascii() else "xn--" + lab.encode("punycode").decode("ascii"))
    out = ".".join(labels)
    if not out:
        return None
    if len(labels) > 1 and labels[-1] == "":
        labels.pop()
    if re.fullmatch(r"[0-9]+|0x[0-9a-f]*", labels[-1]) and not _QUAD.fullmatch(out):
        return None
    return out


def _pct(s, enc):
    return "".join("%%%02X" % b if b >= 0x80 or b in enc else chr(b) for b in s.encode("utf-8", "surrogatepass"))


def _dot_segments(path):
    parts = path.split("/")
    out = []
    for i, seg in enumerate(parts):
        last = i == len(parts) - 1
        low = seg.lower()
        if low in (".", "%2e"):
            if last:
                out.append("")
        elif low in ("..", ".%2e", "%2e.", "%2e%2e"):
            if len(out) > 1:
                out.pop()
            if last:
                out.append("")
        else:
            out.append(seg)
    return "/".join(out)


def _auto_open(scheme, host, port_text):
    if scheme != "https" or port_text or host.startswith("["):
        return False
    h = host[:-1] if host.endswith(".") else host
    if _IPV4.fullmatch(h):
        return False
    labels = h.split(".")
    if len(labels) < 2 or "" in labels:
        return False
    return h != "localhost" and labels[-1] not in ("localhost", "local")


def parse_url(s):
    """One http(s) URL -> {"url": True, href, host, auto_open} (WHATWG-style href, IDN host as
    punycode), else {"url": False}. Hand parse of the shapes the shared rules accept."""
    no = {"url": False}
    if not s or s[0] == " " or s[-1] == " " or any(ord(c) < 0x20 or ord(c) == 0x7F for c in s):
        return no
    colon = s.find(":")
    scheme = s[:colon].lower()
    if colon < 0 or scheme not in ("http", "https") or s[colon + 1:colon + 3] != "//":
        return no
    start = colon + 3
    if s[start:start + 1] in ("/", "\\"):
        return no
    m = re.compile(r"[/?#\\]").search(s, start)
    auth_end = m.start() if m else len(s)
    auth = s[start:auth_end]
    if "@" in auth or "%" in auth:
        return no
    port = None
    if auth.startswith("["):
        close = auth.find("]")
        if close < 0:
            return no
        after = auth[close + 1:]
        if after:
            if after[0] != ":":
                return no
            port = after[1:]
        try:
            host = "[" + ipaddress.IPv6Address(auth[1:close]).compressed + "]"
        except ValueError:
            return no
    else:
        c = auth.rfind(":")
        if c >= 0:
            auth, port = auth[:c], auth[c + 1:]
        host = _ascii_host(auth) if auth else None
        if host is None:
            return no
    port_text = ""
    if port:
        if not re.fullmatch(r"[0-9]+", port) or int(port) > 65535:
            return no
        if int(port) != {"https": 443, "http": 80}[scheme]:
            port_text = ":" + str(int(port))
    rest, query, fragment = s[auth_end:], None, None
    if "#" in rest:
        rest, fragment = rest.split("#", 1)
    if "?" in rest:
        rest, query = rest.split("?", 1)
    href = scheme + "://" + host + port_text + (_dot_segments(_pct(rest.replace("\\", "/"), _PATH_ENC)) or "/")
    if query is not None:
        href += "?" + _pct(query, _QUERY_ENC)
    if fragment is not None:
        href += "#" + _pct(fragment, _FRAGMENT_ENC)
    return {"url": True, "href": href, "host": host, "auto_open": _auto_open(scheme, host, port_text)}


def detect(text):
    """-> (type, value): ("tel", text) | ("url", href) | ("text", text)."""
    s = text.strip(_TRIM)
    if s.startswith("tel:") and is_phone(s):
        return "tel", text
    u = parse_url(s)
    if u["url"]:
        return "url", u["href"]
    if is_phone(s):
        return "tel", text
    return "text", text


# ---- commands ----
#
# Files in the config dir: settings.toml (user: server, ntfy), devices.toml (this client:
# paired devices, pairing state, counters, ntfy topic), keys/private.toml (0600, in keys/ 0700).

import argparse
import base64
import contextlib
import datetime
import email.utils
import http.client
import os
import secrets
import socket
import stat
import string
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import tomllib
except ImportError:  # Python 3.9 and 3.10
    try:
        import tomli as tomllib
    except ImportError:
        tomllib = None

SITE = "https://pusharmor.com"
DEFAULT_SERVER = "https://api.pusharmor.com"
DEFAULT_NTFY = "https://ntfy.sh"
STATE_VERSION = 1
EXIT_OK, EXIT_ERR, EXIT_USAGE, EXIT_LOGIN, EXIT_SEND, EXIT_TEMP = 0, 1, 2, 3, 4, 75
EXIT_CODES = (
    (EXIT_OK, "success"),
    (EXIT_ERR, "error: a failed request, or a damaged or unreadable file on this device"),
    (EXIT_USAGE, "wrong command line, or the command needs a terminal"),
    (EXIT_LOGIN, "not logged in, logged out, or this device was removed"),
    (EXIT_SEND, "send failed for at least one device, or there is no device to send to"),
    (EXIT_TEMP, "the relay server is busy or unreachable; try again later"),
    (130, "stopped with Ctrl-C"),
)
UPDATE_REQUIRED = "Update PushArmor to continue."
CODE_TRIES = 3
LINK_LIFE_S = 600
PROBE_WAIT_S = 30
PAIR_WAIT_S = 600
LISTEN_TIMEOUT_S = 120  # ntfy sends a keepalive every 45 s
WAIT_TIMEOUT_S = 15  # login and pair: short reads, so a wait ends on time
LISTEN_REPORT_S = 86400
FETCH_GAP_S = 60
PLATFORMS = {"android": "Android", "ios": "iPhone", "chrome": "Chrome", "firefox": "Firefox", "cli": "Command line"}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
REC_KEYS = ("from", "name", "platform", "type", "body", "date")
NOT_LOGGED_IN = "Not logged in. Run: pusharmor login"
LOGGED_OUT = "This device is logged out. Run: pusharmor login"
REMOVED = "This device was removed. Log in again."
UNREADABLE = "PushArmor received a message it could not read"
KEY_HEADER = ("# PushArmor private keys of this device. Keep this file secret: with it, anyone can\n"
              "# read the messages sent to this device and send as this device. Do not copy or share it.\n")


class Fail(Exception):
    """A message for stderr and an exit code."""

    def __init__(self, msg, code=EXIT_ERR):
        super().__init__(msg)
        self.code = code


class TempFail(Fail):
    def __init__(self, msg, status):
        super().__init__(msg, EXIT_TEMP)
        self.status = status


class ApiError(Exception):
    def __init__(self, status, error, body):
        super().__init__("%d %s" % (status, error))
        self.status, self.error, self.body = status, error, body


def check_os():
    """The one OS check: Linux and macOS only."""
    if os.name == "nt" or sys.platform.startswith("win"):
        raise Fail("PushArmor command line is not supported on Windows yet.")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def ask_yes(question, default=False):
    try:
        a = input(question).strip().lower()
    except EOFError:
        return False
    return default if a == "" else a in ("y", "yes")


# ---- TOML writer (tables, strings, ints, bools, lists); tomllib, tomli, or _toml_loads reads ----

_BARE = re.compile(r"[A-Za-z0-9_-]+")


def _tstr(s):
    out = []
    for ch in s:
        o = ord(ch)
        if ch in "\"\\":
            out.append("\\" + ch)
        elif 0x20 <= o < 0x7F:
            out.append(ch)
        elif 0xD800 <= o < 0xE000:
            raise ValueError("toml: surrogate")
        else:
            out.append("\\u%04x" % o if o < 0x10000 else "\\U%08x" % o)
    return '"' + "".join(out) + '"'


def _tval(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, str):
        return _tstr(v)
    if isinstance(v, list):
        return "[" + ", ".join(_tval(x) for x in v) + "]"
    raise ValueError("toml: unsupported value")


def toml_dumps(d, prefix=""):
    key = lambda k: k if _BARE.fullmatch(k) else _tstr(k)  # noqa: E731
    out = "".join(key(k) + " = " + _tval(v) + "\n" for k, v in d.items() if not isinstance(v, dict))
    for k, v in d.items():
        if isinstance(v, dict):
            name = prefix + key(k)
            out += "\n[" + name + "]\n" + toml_dumps(v, name + ".")
    return out


class TomlError(ValueError):
    pass


_TESC = {'"': '"', "\\": "\\", "b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r"}
_TINT = re.compile(r"[+-]?(?:0|[1-9][0-9]*)(?![0-9A-Za-z_.:+-])")


def _toml_loads(text):
    """Reads what toml_dumps writes, plus comments and blank lines. Used when tomllib and tomli are missing."""
    root, seen = {}, set()
    cur, i, n = root, 0, len(text)

    def err(msg):
        raise TomlError("%s (line %d)" % (msg, text.count("\n", 0, i) + 1))

    def ws():
        nonlocal i
        while i < n and text[i] in " \t":
            i += 1

    def eol():
        nonlocal i
        ws()
        if i < n and text[i] == "#":
            while i < n and text[i] != "\n":
                if text[i] < " " and text[i] != "\t":
                    err("control character in comment")
                i += 1
        if i < n and text[i] != "\n":
            err("expected end of line")
        i += 1

    def sval():
        nonlocal i
        i += 1
        out = []
        while True:
            if i >= n or text[i] == "\n":
                err("unterminated string")
            ch = text[i]
            i += 1
            if ch == '"':
                return "".join(out)
            if ch == "\\":
                e = text[i:i + 1]
                if e in _TESC:
                    out.append(_TESC[e])
                    i += 1
                elif e in ("u", "U"):
                    w = 4 if e == "u" else 8
                    h = text[i + 1:i + 1 + w]
                    if len(h) != w or not all(c in "0123456789abcdefABCDEF" for c in h):
                        err("bad escape")
                    o = int(h, 16)
                    if 0xD800 <= o < 0xE000 or o > 0x10FFFF:
                        err("bad escape")
                    out.append(chr(o))
                    i += 1 + w
                else:
                    err("bad escape")
            elif (ch < " " and ch != "\t") or ch == "\x7f":
                err("control character in string")
            else:
                out.append(ch)

    def key():
        nonlocal i
        if i < n and text[i] == '"':
            return sval()
        m = _BARE.match(text, i)
        if not m:
            err("expected a key")
        i = m.end()
        return m.group()

    def value():
        nonlocal i
        if i < n and text[i] == '"':
            return sval()
        if i < n and text[i] == "[":
            i += 1
            out = []
            while True:
                ws()
                if i < n and text[i] == "]":
                    i += 1
                    return out
                out.append(value())
                ws()
                if i < n and text[i] == ",":
                    i += 1
                elif not (i < n and text[i] == "]"):
                    err("expected , or ]")
        for word, v in (("true", True), ("false", False)):
            if text.startswith(word, i) and not _BARE.match(text, i + len(word)):
                i += len(word)
                return v
        m = _TINT.match(text, i)
        if not m:
            err("unsupported value")
        i = m.end()
        return int(m.group())

    while i < n:
        ws()
        if i >= n or text[i] in "#\n":
            eol()
            continue
        if text[i] == "[":
            i += 1
            ws()
            path = [key()]
            ws()
            while i < n and text[i] == ".":
                i += 1
                ws()
                path.append(key())
                ws()
            if i >= n or text[i] != "]":
                err("expected ]")
            i += 1
            if tuple(path) in seen:
                err("table defined twice")
            seen.add(tuple(path))
            cur = root
            for k in path:
                cur = cur.setdefault(k, {})
                if not isinstance(cur, dict):
                    err("key is not a table")
            eol()
            continue
        k = key()
        ws()
        if i >= n or text[i] != "=":
            err("expected =")
        i += 1
        ws()
        if k in cur:
            err("duplicate key")
        cur[k] = value()
        eol()
    return root


def toml_loads(text):
    if tomllib is None:
        return _toml_loads(text)
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise TomlError(str(e))


# ---- files ----

def config_dir(arg=None):
    for v in (arg, os.environ.get("PUSHARMOR_CONFIG")):
        if v:
            return os.path.abspath(os.path.expanduser(v))
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = xdg if xdg and os.path.isabs(xdg) else os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "pusharmor")


def write_file(path, text):
    """Temp file in the same dir + os.replace; mode 0600."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def check_private(path, want):
    """Owner must be this user, no group or other bits (Q293 A)."""
    st = os.stat(path)
    mode = stat.S_IMODE(st.st_mode)
    if st.st_uid == os.getuid() and not mode & 0o077:
        return
    fix = "chmod %o %s" % (want, path)
    if st.st_uid != os.getuid():
        fix = "chown $(id -un) %s && %s" % (path, fix)
    raise Fail("Refusing to use %s: found mode %04o, owner uid %d. It must be mode %04o and owned by you (uid %d). "
               "Fix: %s" % (path, mode, st.st_uid, want, os.getuid(), fix))


def read_toml(path):
    try:
        with open(path, "rb") as f:
            return toml_loads(f.read().decode("utf-8"))
    except TomlError as e:
        raise Fail("%s is not valid TOML: %s" % (path, e))
    except UnicodeDecodeError:
        raise Fail("%s is not valid UTF-8 text. It is damaged." % path)


def check_version(d, path):
    v = d.get("version")
    if v is None:
        raise Fail("%s is damaged (no version). Delete it and log in again." % path)
    if type(v) is not int or v != STATE_VERSION:
        raise Fail("%s has version %r, which this PushArmor does not know. %s" % (path, v, UPDATE_REQUIRED))


class Store:
    def __init__(self, root):
        self.root = root
        self.keys_dir = os.path.join(root, "keys")
        self.key_path = os.path.join(self.keys_dir, "private.toml")
        self.dev_path = os.path.join(root, "devices.toml")
        self.lock_path = os.path.join(root, "devices.toml.lock")

    def settings(self):
        p = os.path.join(self.root, "settings.toml")
        s = read_toml(p) if os.path.exists(p) else {}
        for k in ("server", "ntfy"):
            if k in s and not (isinstance(s[k], str) and re.match(r"https?://[^/?#]+/?$", s[k])):
                raise Fail("%s: %s must be a URL like https://host" % (p, k))
        return s

    def has_keys(self):
        return os.path.exists(self.key_path)

    def load_keys(self):
        if not self.has_keys():
            raise Fail(NOT_LOGGED_IN, EXIT_LOGIN)
        check_private(self.keys_dir, 0o700)
        check_private(self.key_path, 0o600)
        d = read_toml(self.key_path)
        check_version(d, self.key_path)
        try:
            k = {"id": d["id"], "auth": b64d(d["push_auth"])}
            for name in ("sign", "enc", "push"):
                k[name] = b64d(d[name + "_key"])
                if len(k[name]) != 32:
                    raise ValueError("bad key")
                k[name + "_pub"] = pub_from_priv(k[name])
            if len(b64d(k["id"])) != 30 or len(k["auth"]) != 16:
                raise ValueError("bad id")
        except (KeyError, ValueError, TypeError):
            raise Fail("%s is damaged. Delete it and log in again." % self.key_path)
        return k

    def save_keys(self, k):
        os.makedirs(self.keys_dir, 0o700, exist_ok=True)
        check_private(self.keys_dir, 0o700)
        write_file(self.key_path, KEY_HEADER + toml_dumps({
            "version": STATE_VERSION, "id": k["id"], "sign_key": b64e(k["sign"]), "enc_key": b64e(k["enc"]),
            "push_key": b64e(k["push"]), "push_auth": b64e(k["auth"])}))

    @contextlib.contextmanager
    def state(self, write=True):
        """devices.toml under an exclusive flock (listen and send may run at the same time)."""
        import fcntl
        os.makedirs(self.root, 0o700, exist_ok=True)
        with open(self.lock_path, "a") as lf:
            fcntl.flock(lf, fcntl.LOCK_EX)
            d = {"version": STATE_VERSION}
            if os.path.exists(self.dev_path):
                d = read_toml(self.dev_path)
                check_version(d, self.dev_path)
            for k, v in (("peers", {}), ("pairs", {}), ("my_allow", []), ("listed", []), ("pair_auto", [])):
                d.setdefault(k, v)
            yield d
            if write:
                write_file(self.dev_path, toml_dumps(d))

    def wipe(self):
        for p in (self.key_path, self.dev_path, self.lock_path):
            with contextlib.suppress(FileNotFoundError):
                os.unlink(p)
        with contextlib.suppress(OSError):
            os.rmdir(self.keys_dir)


# ---- HTTP (urllib only) ----

def http_request(method, url, headers, body):
    """One HTTP exchange -> (status, lower-case headers, body). Raises OSError when the network fails."""
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()
    except http.client.HTTPException as e:
        raise OSError(str(e)) from e


def ntfy_open(url, timeout):
    """Opens an ntfy JSON stream (one event per readline()). Raises OSError."""
    try:
        return urllib.request.urlopen(url, timeout=timeout)
    except http.client.HTTPException as e:
        raise OSError(str(e)) from e


class Api:
    def __init__(self, server, keys=None):
        self.base = server.rstrip("/")
        self.keys = keys
        self.skew_ms = 0
        self.push_missing = False

    def call(self, method, path, body=None, with_id=True, signed=True, tries=3):
        """Signed JSON call -> reply object. 426 and network/5xx/429 (after tries) raise Fail;
        other non-2xx raise ApiError. One retry after a clock skew 401, PA-Time resynced from PA-Epoch."""
        raw = json.dumps(body, separators=(",", ":")).encode() if body is not None else b""
        skewed, attempt = False, 0
        while True:
            h = {"PA-Client": "cli/" + VERSION}
            if raw:
                h["Content-Type"] = "application/json"
            if signed:
                t = str(int(time.time() * 1000) + self.skew_ms)
                h["PA-Time"] = t
                h["PA-Sig"] = sign_request(self.keys["sign"], method, path, t, raw)
                if with_id:
                    h["PA-ID"] = self.keys["id"]
            try:
                status, hdrs, data = http_request(method, self.base + path, h, raw or None)
            except OSError:
                status, hdrs, data = 0, {}, b""
            try:
                j = json.loads(data) if data else {}
            except ValueError:
                j = {}
            j = j if isinstance(j, dict) else {}
            if status == 426:
                raise Fail(UPDATE_REQUIRED)
            epoch = hdrs.get("pa-epoch", "")
            if status == 401 and j.get("error") == "clock skew" and not skewed and re.fullmatch(r"[0-9]{1,12}", epoch):
                skewed = True
                self.skew_ms = int(epoch) * 1000 - int(time.time() * 1000)
                continue
            if status == 0 or status == 429 or status >= 500:
                attempt += 1
                if attempt < tries:
                    ra = j.get("retry_after")
                    time.sleep(min(ra if type(ra) is int and ra > 0 else 2 ** attempt, 60))
                    continue
                if status == 0:
                    raise TempFail("Could not reach the relay server. Check the network and try again.", 0)
                if status == 429:
                    raise TempFail("The relay server is busy. Wait a minute and try again.", 429)
                raise TempFail("The relay server is not working right now (HTTP %d). Try again later." % status, status)
            if j.get("push_missing") is True:
                self.push_missing = True
            if 200 <= status < 300:
                return j
            raise ApiError(status, j.get("error") if isinstance(j.get("error"), str) else "", j)


# ---- ntfy stream (UnifiedPush endpoint https://<ntfy>/<topic>?up=1) ----

class Stream:
    def __init__(self, ntfy, topic, keys, since, timeout, poll=False):
        self.url = ntfy.rstrip("/") + "/" + topic + "/json"
        self.keys, self.since, self.timeout, self.poll = keys, since, timeout, poll
        self.resp, self.backoff, self.delay = None, 1, False

    def connect(self):
        q = {"poll": "1"} if self.poll else {}
        if self.since:
            q["since"] = self.since
        self.resp = ntfy_open(self.url + ("?" + urllib.parse.urlencode(q) if q else ""), self.timeout)

    def close(self, delay):
        if self.resp is not None:
            with contextlib.suppress(Exception):
                self.resp.close()
        self.resp, self.delay = None, delay

    def next(self, deadline=None):
        """Next push plaintext, or None at the deadline (poll: at the end of the cache).
        Reconnects from the last message id with backoff 1..60 s."""
        while deadline is None or time.time() < deadline:
            if self.resp is None:
                if self.delay:
                    left = 60 if deadline is None else max(0, deadline - time.time())
                    time.sleep(min(self.backoff, left))
                    self.backoff = min(self.backoff * 2, 60)
                try:
                    self.connect()
                except OSError:
                    if self.poll:
                        return None
                    self.delay = True
                    continue
            try:
                line = self.resp.readline()
            except TimeoutError:
                self.close(False)
                continue
            except (OSError, http.client.HTTPException):
                self.close(True)
                continue
            if not line:
                self.close(True)
                if self.poll:
                    return None
                continue
            self.backoff = 1
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict) or ev.get("event") != "message":
                continue
            if isinstance(ev.get("id"), str):
                self.since = ev["id"]
            try:
                msg = ev.get("message", "")
                body = base64.b64decode(msg, validate=True) if ev.get("encoding") == "base64" else msg.encode()
                return webpush_decrypt(body, self.keys["push"], self.keys["auth"]).decode("ascii")
            except Exception:
                log(UNREADABLE)
        return None


# ---- local device rows ----

def new_peer(it):
    return {"sign_pub": it["sign_pub"], "enc_pub": it["enc_pub"], "platform": "", "created": 0, "pinned": False,
            "pairing_id": "", "ruling": "none", "approves_me": False, "approve_verified": False,
            "get_after_verify": False, "pending_approve_n": 0, "name": "", "name_n": 0, "n": 0, "logout_n": 0,
            "logged_out": False, "listening": True, "denies_me": False, "missing": False, "h": 0, "seen": []}


def pin_peer(p, sp, ep, pid):
    p.update(sign_pub=b64e(sp), enc_pub=b64e(ep), pairing_id=b64e(pid), pinned=True, ruling="none",
             approves_me=False, approve_verified=False, get_after_verify=False, pending_approve_n=0,
             name_n=0, n=0, logout_n=0, h=0, seen=[])


def unpin(p):
    p.update(pinned=False, pairing_id="", ruling="none", approve_verified=False, pending_approve_n=0)


def new_entry(role, state, r, c_n):
    return {"role": role, "state": state, "r": b64e(r), "c_N": b64e(c_n), "started": int(time.time()),
            "authorized": False, "msg": "", "fingerprint": "", "sign_pub": "", "enc_pub": "",
            "approved": False, "approve_body": ""}


def reserve(p):
    """Next own counter n for this pairing; written to devices.toml before the POST."""
    p["n"] += 1
    return p["n"]


def sendable(p):
    return (p["pinned"] and p["ruling"] == "approved" and p["approves_me"] and not p["logged_out"]
            and p["listening"] and not p["missing"])


def platform_label(platform):
    return PLATFORMS.get(platform) or re.sub(r"[^\x20-\x7e]", "", platform).capitalize() or "Unknown"


def peer_label(p):
    if not p:
        return "A device"
    if p["name"]:
        return p["name"]
    t = time.gmtime(p["created"])
    return "%s device added %s %d" % (platform_label(p["platform"]), MONTHS[t.tm_mon - 1], t.tm_mday)


def short_id(i, ids):
    """6 hex chars, longer only when another id shares the prefix."""
    h = id_hex(i)
    others = [id_hex(x) for x in ids if x != i]
    for n in range(6, len(h)):
        if not any(o.startswith(h[:n]) for o in others):
            return h[:n]
    return h


def default_name():
    n = "".join(c for c in socket.gethostname() if NAME_RE.fullmatch(c))[:32].strip()
    return n or "Command line"


def seal_msg(k, x, p, n, type_, value, approve=False):
    pid = b64d(p["pairing_id"]) if p["pairing_id"] else bytes(8)
    return build_message(k["sign"], k["id"], x, b64d(p["enc_pub"]), pid, msg_json(n, type_, value),
                         keys=(k["sign_pub"], k["enc_pub"]) if approve else None)


def push_value(d, k):
    return {"type": "unifiedpush", "endpoint": "%s/%s?up=1" % (d["ntfy"].rstrip("/"), d["topic"]),
            "p256dh": b64e(k["push_pub"]), "auth": b64e(k["auth"])}


def new_topic():
    """"up" + 12 chars: the cli topic the relay server accepts (allowlist.ts cliTopicOk, Q307)."""
    return "up" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(12))


# ---- one run ----

class Ctx:
    def __init__(self, root):
        self.store = Store(root)
        self.settings, self.keys, self.api = {}, None, None
        self.mode, self.target, self.emit, self.last_fetch, self.skipped = "", None, None, 0, False

    @property
    def me(self):
        return self.keys["id"]

    def setup(self, need_keys=True):
        self.settings = self.store.settings()
        if need_keys:
            self.keys = self.store.load_keys()
        self.api = Api(self.settings.get("server", DEFAULT_SERVER), self.keys)

    def need(self):
        """A logged-in device."""
        self.setup()
        with self.store.state(write=False) as d:
            reg = d.get("reg")
        if reg != "registered":
            raise Fail(LOGGED_OUT if reg == "logged_out" else NOT_LOGGED_IN, EXIT_LOGIN)

    def refresh(self):
        """GET /v1/peers merge, then the allow reconcile."""
        j = self.api.call("GET", "/v1/peers")
        self.last_fetch = time.time()
        with self.store.state() as d:
            merge_peers(d, j, self.keys)
        reconcile_allow(self)

    def refresh_soon(self):
        if time.time() - self.last_fetch >= FETCH_GAP_S:
            with contextlib.suppress(ApiError, TempFail):
                self.refresh()


def merge_peers(d, j, k):
    me, acct, peers = k["id"], b64d(k["id"])[:9], d["peers"]
    d["my_allow"] = [x for x in j.get("my_allow", []) if isinstance(x, str)]
    seen = []
    for it in j.get("peers", []) if isinstance(j.get("peers"), list) else []:
        if not isinstance(it, dict) or it.get("id") == me:
            continue
        pid = it.get("id")
        try:
            ok = peer_keys_ok(pid, acct, b64d(it["sign_pub"]), b64d(it["enc_pub"]))
        except (KeyError, ValueError, TypeError):
            ok = False
        if not ok:
            continue
        p = peers.get(pid)
        if p is None:
            p = peers[pid] = new_peer(it)
        elif not p["pinned"]:
            p["sign_pub"], p["enc_pub"] = it["sign_pub"], it["enc_pub"]
        seen.append(pid)
        p.update(platform=it["platform"] if isinstance(it.get("platform"), str) else "",
                 created=it["created"] if type(it.get("created")) is int else 0,
                 logged_out=it.get("logged_out") is True, listening=it.get("listening") is not False,
                 denies_me=it.get("denies_me") is True, missing=False)
        if p["pinned"] and p["approve_verified"]:
            p["approves_me"], p["get_after_verify"] = it.get("approves_me") is True, True
        elif not p["pinned"]:
            p["approves_me"] = it.get("approves_me") is True
        nm = it.get("name_for_me")
        if p["pinned"] and p["ruling"] == "approved" and isinstance(nm, str):
            r = open_name_entry(nm, me, k["enc"], pid, {"sign_pub": b64d(p["sign_pub"]),
                                                        "pairing_id": b64d(p["pairing_id"])})
            if r["ok"] and r["n"] > p["name_n"]:
                p["name"], p["name_n"] = r["name"], r["n"]
    for pid in list(peers):
        if pid not in seen:
            if peers[pid]["ruling"] == "approved":
                peers[pid]["missing"] = True
            elif pid not in d["pairs"]:
                del peers[pid]
    d["listed"] = seen


def reconcile_allow(cx):
    """Withdraw every id in the relay server's allow set that has no pin here."""
    with cx.store.state(write=False) as d:
        ids = [i for i in d["my_allow"] if not d["peers"].get(i, {}).get("pinned")]
    for i in ids:
        try:
            cx.api.call("POST", "/v1/deny/" + i, {"withdraw": 1})
        except ApiError as e:
            if e.status == 401:
                raise
            if e.status != 400:
                continue
        with cx.store.state() as d:
            d["my_allow"] = [x for x in d["my_allow"] if x != i]


def allow_list_call(cx, method, path, body_of, content, with_id=True):
    """Signed call whose m covers the allow list; 400 "messages missing" -> reconcile + one retry.
    content(id, row, n, names) -> (type, value)."""
    extra = []
    for attempt in (0, 1):
        names = {}
        with cx.store.state() as d:
            m = {}
            for pid, p in d["peers"].items():
                if p["pinned"] and p["pairing_id"] and (p["ruling"] == "approved" or pid in extra):
                    n = reserve(p)
                    type_, value = content(pid, p, n, names)
                    m[pid] = seal_msg(cx.keys, pid, p, n, type_, value)
        try:
            return cx.api.call(method, path, body_of(m, names), with_id=with_id)
        except ApiError as e:
            if attempt or e.status != 400 or e.error != "messages missing":
                raise
            extra = [i for i in e.body.get("ids", []) if isinstance(i, str)]
            with cx.store.state() as d:
                d["my_allow"] = sorted(set(d["my_allow"]) | set(extra))
            reconcile_allow(cx)


# ---- receive ----

def receive(cx, pt, src="push"):
    """One push plaintext: probe JSON, pair message (366 chars), or inner message."""
    if pt.startswith("{"):
        return on_probe(cx, pt)
    if len(pt) == PAIR_WIRE_LEN:
        return receive_pair(cx, pt)
    return receive_inner(cx, pt, src)


def on_probe(cx, pt):
    try:
        code = parse_strict(pt.encode()).get("probe")
    except (ValueError, AttributeError):
        return
    with cx.store.state(write=False) as d:
        done = d.get("push_ok")
    if not isinstance(code, str) or done:  # a probe replayed from the ntfy cache
        return
    try:
        cx.api.call("POST", "/v1/peers/%s/confirm" % cx.me, {"code": code})
    except ApiError as e:
        if e.status == 401 and e.error != "wrong code":
            raise
        return
    with cx.store.state() as d:
        d["push_ok"] = True


def receive_inner(cx, pt, src):
    k, notes, wipe, rec, fetch = cx.keys, [], None, None, False
    with cx.store.state() as d:
        pins = {pid: {"sign_pub": b64d(p["sign_pub"]), "enc_pub": b64d(p["enc_pub"]),
                      "pairing_id": b64d(p["pairing_id"]), "ruling": p["ruling"],
                      "window": {"h": p["h"], "seen": p["seen"]}}
                for pid, p in d["peers"].items() if p["pinned"] and p["pairing_id"]}
        r = open_message(pt, k["id"], k["enc"], b64d(k["id"])[:9], pins)
        out = r["outcome"]
        if out == "unreadable":
            if src != "returned":
                notes.append(UNREADABLE)
                fetch = r.get("why") == "unknown sender"
        elif out == "invalid" and r["n"] not in pins[r["from"]]["window"]["seen"]:
            notes.append("Invalid message received")
        elif out == "accept" and cx.mode != "listen" and r["type"] in ("url", "text", "tel"):
            cx.skipped = True  # content waits for listen
        elif out == "accept" and (src != "returned" or r["type"] == "approve"):
            p = d["peers"][r["from"]]
            w = window_accept({"h": p["h"], "seen": p["seen"]}, r["n"])
            p["h"], p["seen"] = w["h"], w["seen"]
            wipe, rec = act(cx, d, r, p, notes)
    for n in notes:
        log(n)
    if fetch:
        cx.refresh_soon()
    if wipe:
        cx.store.wipe()
        raise Fail(wipe, EXIT_LOGIN)
    if rec and cx.emit:
        cx.emit(rec)


def act(cx, d, r, p, notes):
    """Applies one accepted message to devices.toml. -> (wipe message or None, content record or None)."""
    t, v, n, frm, name = r["type"], r["value"], r["n"], r["from"], peer_label(p)
    if t in ("url", "text", "tel"):
        if t == "url":
            u = parse_url(v)
            t, v = ("url", u["href"]) if u["url"] else ("text", v)
        elif t == "tel" and not is_phone(v):
            t = "text"
        return None, {"from": id_hex(frm), "name": name, "platform": p["platform"], "type": t, "body": v,
                      "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    if t == "approve":
        if v["n"] > p["name_n"]:
            p["name"], p["name_n"] = v["name"], v["n"]
        if p["ruling"] == "approved":
            p.update(approves_me=True, approve_verified=True, get_after_verify=False, pending_approve_n=0)
            d["pairs"].pop(frm, None)
            notes.append(peer_label(p) + " approved this device")
        else:
            p["pending_approve_n"] = n
    elif t == "rename":
        if n > p["name_n"]:
            p["name"], p["name_n"] = v["name"], n
            notes.append("%s is now named %s" % (name, v["name"]))
    elif t == "remove":
        if v == cx.me:
            return REMOVED, None
        q = d["peers"].pop(v, None)
        d["pairs"].pop(v, None)
        if q:
            notes.append(peer_label(q) + " was removed from your account")
    elif t == "delete":
        return "Your PushArmor account was deleted.", None
    elif t in ("logout", "login"):
        if n > p["logout_n"]:
            p["logged_out"], p["logout_n"] = t == "logout", n
        notes.append(name + (" logged out" if t == "logout" else " logged in"))
    elif t == "deny":
        p["denies_me"], p["approves_me"] = True, False
        d["pairs"].pop(frm, None)
        notes.append(name + " denied this device")
    return None, None


def receive_pair(cx, pt):
    k = cx.keys
    o = open_pair(pt, k["id"], k["enc"], b64d(k["id"])[:9])
    if not o["ok"] or o["from"] == k["id"]:
        return log(UNREADABLE)
    frm = o["from"]
    if o["kind"] == "commit":
        with cx.store.state(write=False) as d:
            listed = "yes" if frm in d["listed"] else None
        if not listed:
            with contextlib.suppress(ApiError, TempFail):
                cx.refresh()
            with cx.store.state(write=False) as d:
                listed = "after_fetch" if frm in d["listed"] else "no"
        return on_commit(cx, frm, o["c_N"], listed)
    notes, send = [], None
    with cx.store.state() as d:
        e, p = d["pairs"].get(frm), d["peers"].get(frm)
        want = {"N": "reply", "X": "open"}.get(e["role"]) if e else None
        if o["kind"] != want or p is None:
            notes.append(UNREADABLE)
        elif want == "reply":
            send = on_reply(cx, e, p, o, notes)
        else:
            on_open(cx, d, e, p, o, notes)
    for n in notes:
        if n:
            log(n)
    if send:
        post_pair(cx, frm, "open", send)


def pair_note(cx, d, x, text):
    """A pairing line for stderr, unless `pair` already runs for this device."""
    return None if cx.target == x else text % (peer_label(d["peers"].get(x)), short_id(x, d["peers"]))


def on_commit(cx, frm, c_n, listed):
    k, notes, now = cx.keys, [], int(time.time())
    with cx.store.state() as d:
        e, p = d["pairs"].get(frm), d["peers"].get(frm) or {}
        dec = pair_decide({
            "own_id": k["id"], "from_id": frm, "commit_c_N": c_n,
            "entry": e and {"role": e["role"], "state": e["state"], "c_N": b64d(e["c_N"]),
                            "reply_authorized": e["authorized"]},
            "pinned": p.get("pinned", False), "approved": p.get("ruling") == "approved",
            "approve_verified": p.get("approve_verified", False), "approves_me": p.get("approves_me", False),
            "get_after_verify": p.get("get_after_verify", False), "listed": listed,
            "open_entries": len(d["pairs"]), "cap": d["pair_auto"], "now": now})
        if dec["entry"] == "aborted":
            d["pairs"].pop(frm, None)
            notes.append(pair_note(cx, d, frm, "Pairing with %s failed. Start again on the new device. (%s)"))
        elif dec["entry"].startswith("created") or dec["entry"] == "n_wiped_x_replied":
            e = d["pairs"][frm] = new_entry("X", "prompted", secrets.token_bytes(32), c_n)
            e["authorized"] = dec["action"] == "reply"
            if dec["cap_counted"]:
                d["pair_auto"] = [t for t in d["pair_auto"] if now - t < PAIR_CAP_WINDOW_S] + [now]
        notice = dec["notice"]
        if notice in ("commit", "represent"):
            notes.append(pair_note(cx, d, frm, "%s wants to pair. Run: pusharmor pair %s"))
        elif notice == "crossing":
            notes.append(pair_note(cx, d, frm, "Pairing with %s in progress. (%s)"))
        elif notice == "half_state":
            notes.append(pair_note(cx, d, frm, "%s wants to pair again. Run: pusharmor pair %s"))
        else:
            notes.append(UNREADABLE)
    for n in notes:
        if n:
            log(n)
    if dec["action"] == "reply":
        send_reply(cx, frm)


def on_reply(cx, e, p, o, notes):
    """N got X's reply: pin, fingerprint, and the open to send."""
    k = cx.keys
    r_n = b64d(e["r"])
    pid = pairing_id(r_n, o["r"])
    if e["state"] != "committed":
        if not (e["state"] == "shown" and p["pinned"] and p["pairing_id"] == b64e(pid)):
            notes.append(UNREADABLE)
        return None
    pin_peer(p, o["sign_pub"], o["enc_pub"], pid)
    msg = seal_pair("open", k["id"], keys_body(k["sign_pub"], k["enc_pub"], r_n), o["from"], o["enc_pub"])
    e.update(state="shown", fingerprint=sas(k["sign_pub"], k["enc_pub"], o["sign_pub"], o["enc_pub"], r_n, o["r"]),
             sign_pub=b64e(o["sign_pub"]), enc_pub=b64e(o["enc_pub"]), msg=msg)
    return msg


def on_open(cx, d, e, p, o, notes):
    """X got N's open: check it against the commit, pin, fingerprint."""
    k, frm = cx.keys, o["from"]
    if e["state"] == "shown":
        if e["sign_pub"] != b64e(o["sign_pub"]) or e["enc_pub"] != b64e(o["enc_pub"]):
            notes.append(UNREADABLE)
        return
    if e["state"] != "replied":
        return notes.append(UNREADABLE)
    if not open_matches_commit(o, b64d(e["c_N"])):
        d["pairs"].pop(frm, None)
        return notes.append(pair_note(cx, d, frm, "Pairing with %s failed. Start again on the new device. (%s)"))
    r_x = b64d(e["r"])
    pin_peer(p, o["sign_pub"], o["enc_pub"], pairing_id(o["r"], r_x))
    e.update(state="shown", fingerprint=sas(o["sign_pub"], o["enc_pub"], k["sign_pub"], k["enc_pub"], o["r"], r_x),
             sign_pub=b64e(o["sign_pub"]), enc_pub=b64e(o["enc_pub"]))
    notes.append(pair_note(cx, d, frm, "%s wants to pair. Compare the fingerprint: pusharmor pair %s"))


def post_pair(cx, x, kind, c):
    """POST /v1/pair/X once -> result word (sent, denied, not listening, ...)."""
    try:
        j = cx.api.call("POST", "/v1/pair/" + x, {"k": kind, "c": c}, tries=1)
    except TempFail as e:
        return "network" if e.status == 0 else str(e.status)
    except ApiError as e:
        if e.status == 401:
            raise
        return ("%d %s" % (e.status, e.error)).strip()
    return j["r"] if isinstance(j.get("r"), str) else "failed"


def send_reply(cx, x):
    k = cx.keys
    with cx.store.state() as d:
        e, p = d["pairs"].get(x), d["peers"].get(x)
        if not e or e["role"] != "X" or not e["authorized"] or not p:
            return None
        if not e["msg"]:
            e["msg"] = seal_pair("reply", k["id"], keys_body(k["sign_pub"], k["enc_pub"], b64d(e["r"])), x,
                                 b64d(p["enc_pub"]))
        msg = e["msg"]
    r = post_pair(cx, x, "reply", msg)
    if r == "sent":
        with cx.store.state() as d:
            e = d["pairs"].get(x)
            if e and e["state"] == "prompted":
                e["state"] = "replied"
    return r


def pair_start(cx, x):
    """N: new commit to X (a half-paired row is unpinned first)."""
    k = cx.keys
    with cx.store.state() as d:
        p = d["peers"][x]
        if p["pinned"]:
            unpin(p)
        r_n = secrets.token_bytes(32)
        c_n = commit_hash(k["sign_pub"], k["enc_pub"], r_n)
        e = d["pairs"][x] = new_entry("N", "committed", r_n, c_n)
        e["msg"] = seal_pair("commit", k["id"], commit_body(c_n), x, b64d(p["enc_pub"]))
    reconcile_allow(cx)
    return post_pair(cx, x, "commit", e["msg"])


def approve(cx, x):
    k = cx.keys
    with cx.store.state() as d:
        p, e = d["peers"][x], d["pairs"].get(x)
        p["ruling"], p["denies_me"] = "approved", False
        if p["pending_approve_n"] > 0:
            p.update(approves_me=True, approve_verified=True, get_after_verify=False, pending_approve_n=0)
        n = reserve(p)
        entry = make_name_entry(k["sign"], k["id"], x, b64d(p["pairing_id"]), n, d.get("name") or default_name())
        body = {"c": seal_msg(k, x, p, n, "approve", entry, approve=True),
                "name": seal_name_entry(x, b64d(p["enc_pub"]), entry)}
        if e:
            e["approved"], e["approve_body"] = True, json.dumps(body)
        if p["approve_verified"]:
            d["pairs"].pop(x, None)
        if x not in d["my_allow"]:
            d["my_allow"].append(x)
    return post_approve(cx, x, body)


def post_approve(cx, x, body):
    j = cx.api.call("POST", "/v1/approve/" + x, body)
    if isinstance(j.get("c"), str):
        receive(cx, j["c"], "returned")
    r = j["r"] if isinstance(j.get("r"), str) else "failed"
    if r == "denied":
        with cx.store.state() as d:
            d["peers"][x]["denies_me"] = True
            d["pairs"].pop(x, None)
    return r


def deny(cx, x):
    with cx.store.state() as d:
        p = d["peers"][x]
        c = seal_msg(cx.keys, x, p, reserve(p), "deny", 1)
        d["pairs"].pop(x, None)
        unpin(p)
        p["ruling"] = "denied"
    cx.api.call("POST", "/v1/deny/" + x, {"c": c})


def sweep(cx):
    """Pairings older than 14 days (pair_timeout)."""
    now, dropped = int(time.time()), False
    with cx.store.state(write=False) as d:
        old = [x for x, e in d["pairs"].items() if now - e["started"] > PAIR_TIMEOUT_S]
    for x in old:
        with cx.store.state(write=False) as d:
            e, p = d["pairs"][x], d["peers"].get(x) or {}
            i = {"approve_verified": p.get("approve_verified", False), "approved": e["approved"], "resend": None}
        a = pair_timeout(i)
        if a == "resend":
            try:
                post_approve(cx, x, json.loads(e["approve_body"]))
                with cx.store.state(write=False) as d:
                    ok = d["peers"].get(x, {}).get("approve_verified")
                i["resend"] = "200_c_verified" if ok else "200_other"
            except (TempFail, ApiError, ValueError):
                i["resend"] = "offline"
            a = pair_timeout(i)
        if a in ("keep_waiting", "resend"):
            continue
        with cx.store.state() as d:
            d["pairs"].pop(x, None)
            p = d["peers"].get(x)
            if a == "drop_pin" and p and not p["approve_verified"]:
                unpin(p)
                dropped = True
                log("Pairing with %s timed out." % peer_label(p))
    if dropped:
        reconcile_allow(cx)


def report_listening(cx):
    cx.api.call("PATCH", "/v1/peers/" + cx.me, {"listening": True})
    with cx.store.state() as d:
        d["listen_at"] = int(time.time())


def send_push(cx):
    with cx.store.state() as d:
        body = {"push": push_value(d, cx.keys)}
        d["push_ok"] = False
    cx.api.push_missing = False
    cx.api.call("PATCH", "/v1/peers/" + cx.me, body)


def start_receive(cx, since, timeout):
    """listen and pair: subscribe first, report listening (Q309), re-send push when it is not confirmed."""
    with cx.store.state(write=False) as d:
        s = Stream(d["ntfy"], d["topic"], cx.keys, since, timeout)
        ok = d.get("push_ok")
    try:
        s.connect()
    except OSError:
        raise TempFail("Could not reach the push service at %s. Check the network and try again." % s.url, 0)
    report_listening(cx)
    if not ok or cx.api.push_missing:
        send_push(cx)
    return s


# ---- output ----

def _clean(s):
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]", "?", s)


def format_record(rec, fmt):
    if fmt == "json":
        return json.dumps({k: rec[k] for k in REC_KEYS}, ensure_ascii=False)
    if fmt == "tsv":
        esc = lambda s: s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r")  # noqa: E731
        return "\t".join(esc(rec[k]) for k in REC_KEYS)
    t = datetime.datetime.strptime(rec["date"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    body = _clean(rec["body"].replace("\r\n", "\n").replace("\r", "\n")).replace("\n", "\n ")
    return "From: %s %s\nPlatform: %s\nType: %s\nDate: %s\nBody: %s\n" % (
        rec["from"][:6], rec["name"], platform_label(rec["platform"]), rec["type"],
        email.utils.format_datetime(t.astimezone()), body)


def run_exec(prog, rec):
    try:
        r = subprocess.run([prog] + [rec[k] for k in ("from", "name", "platform", "type", "body")])
        if r.returncode:
            log("%s exited with status %d" % (prog, r.returncode))
    except (OSError, ValueError) as e:
        log("Could not run %s: %s" % (prog, e))


# ---- command functions ----

def cmd_login(cx, args):
    if not sys.stdin.isatty():
        raise Fail("pusharmor login needs a terminal.", EXIT_USAGE)
    cx.setup(need_keys=False)
    purpose = "r"
    if cx.store.has_keys():
        cx.keys = cx.api.keys = cx.store.load_keys()
        with cx.store.state(write=False) as d:
            reg = d.get("reg")
        if reg == "registered":
            print("This device is already logged in.")
            return EXIT_OK
        purpose = "l" if reg == "logged_out" else "r"
    else:
        k = {"auth": secrets.token_bytes(16)}
        for name in ("sign", "enc", "push"):
            k[name], k[name + "_pub"] = new_key()
        cx.keys = cx.api.keys = k
    link = "%s/auth/cli#%s.%s" % (SITE, purpose, b64e(sha256(cx.keys["sign_pub"])[:16]))
    print("Open this link in a browser and log in:\n\n  %s\n\nThen paste the code from the page here." % link)
    shown, tries, code = time.time(), 0, None
    while True:
        if code is None:
            try:
                raw = input("Code: ")
            except EOFError:
                raise Fail("No code entered.")
            code = re.sub(r"[\s\"'`]", "", raw)
            if not re.fullmatch(r"[A-Za-z0-9_-]{34}", code):
                code, tries = None, tries + 1
                if tries >= CODE_TRIES:
                    raise Fail("No valid code after %d tries. Run pusharmor login again." % CODE_TRIES)
                print("That is not a PushArmor code. Copy the whole code from the page and paste it again.")
                continue
        if time.time() - shown > LINK_LIFE_S:
            print("The link expired. Open it again to get a new code:\n\n  %s\n" % link)
            shown, code = time.time(), None
            continue
        try:
            (register if purpose == "r" else relogin)(cx, code)
            break
        except ApiError as e:
            if e.status == 401 and e.error == "ticket expired":
                print("That code expired. Open the link again to get a new code:\n\n  %s\n" % link)
                shown, code = time.time(), None
                continue
            if e.status == 401 and e.error in ("bad ticket", "invalid ticket"):
                code, tries = None, tries + 1
                if tries >= CODE_TRIES:
                    raise Fail("The code did not work after %d tries. Run pusharmor login again." % CODE_TRIES)
                print("That code did not work. Check it and paste it again.")
                continue
            if e.status == 403:
                raise Fail("This account cannot log in.")
            raise Fail("Could not log in: %s" % (e.error or e.status))
        except TempFail as e:
            if e.status == 429:
                raise Fail("Too many tries. Wait a minute and run pusharmor login again.")
            if not ask_yes("%s Retry? [Y/n] " % e, default=True):
                raise Fail("Not logged in.")
    with cx.store.state(write=False) as d:
        name = d["name"]
    print("Logged in. This device is named %s. Next: run pusharmor pair to see your devices." % name)
    return EXIT_OK


def register(cx, code):
    """POST /v1/peers with push (Q305 A), then the probe confirm. Nothing is written before it succeeds."""
    k = cx.keys
    if not getattr(cx, "topic", None):
        cx.topic = new_topic()
    ntfy = cx.settings.get("ntfy", DEFAULT_NTFY)
    d0 = {"ntfy": ntfy, "topic": cx.topic}
    stream = Stream(ntfy, cx.topic, k, "", WAIT_TIMEOUT_S)
    try:
        stream.connect()
    except OSError:
        raise TempFail("Could not reach the push service at %s." % ntfy, 0)
    try:
        register_with(cx, code, stream, push_value(d0, k), ntfy)
    finally:
        stream.close(False)


def register_with(cx, code, stream, push, ntfy):
    k = cx.keys
    body = {"ticket": code, "sign_pub": b64e(k["sign_pub"]), "enc_pub": b64e(k["enc_pub"]), "platform": "cli",
            "push": push}
    while True:
        try:
            j = cx.api.call("POST", "/v1/peers", body, with_id=False, tries=1)
            break
        except ApiError as e:
            if e.status != 409 or e.error != "peer limit" or not isinstance(e.body.get("ticket"), str):
                raise
            body["evict"], body["ticket"] = choose_evict(e.body.get("peers")), e.body["ticket"]
    pid = j.get("id")
    if not isinstance(pid, str) or not peer_keys_ok(pid, b64d(pid)[:9], k["sign_pub"], k["enc_pub"]):
        raise Fail("The relay server sent a reply this device cannot use.")
    k["id"] = pid
    cx.store.save_keys(k)
    with cx.store.state() as d:
        d.clear()
        d.update(version=STATE_VERSION, name=default_name(), reg="registered", ntfy=ntfy, topic=cx.topic,
                 push_ok=False, since=str(int(time.time())), peers={}, pairs={}, my_allow=[], listed=[],
                 pair_auto=[])
        merge_peers(d, j, k)
    for attempt in (0, 1):
        deadline = time.time() + PROBE_WAIT_S
        while True:
            pt = stream.next(deadline)
            if pt is None:
                break
            if pt.startswith("{"):
                on_probe(cx, pt)
                with cx.store.state(write=False) as d:
                    if d["push_ok"]:
                        return
        if attempt == 0:
            with contextlib.suppress(ApiError, TempFail):
                send_push(cx)
    log("Could not confirm that this device can receive messages. pusharmor listen tries again.")


def choose_evict(peers):
    rows = [p for p in (peers if isinstance(peers, list) else [])
            if isinstance(p, dict) and isinstance(p.get("id"), str) and len(p["id"]) == 40 and b64ok(p["id"])]
    print("This account already has %d devices, the most it can have. To add this device, remove one or more."
          " A removed device must log in again and pair with every device again." % len(rows))
    for i, p in enumerate(rows, 1):
        added = time.strftime("%Y-%m-%d", time.gmtime(p["created"] if type(p.get("created")) is int else 0))
        print("  %d  %s  %s  added %s" % (i, id_hex(p["id"])[:6], platform_label(str(p.get("platform", ""))), added))
    try:
        a = input("Numbers to remove (for example: 1 3), or Enter to stop: ")
    except EOFError:
        a = ""
    picks = sorted({int(w) for w in a.split() if w.isdigit() and 1 <= int(w) <= len(rows)})
    if not picks or len(picks) > 9:
        raise Fail("Not logged in.")
    return [rows[i - 1]["id"] for i in picks]


def relogin(cx, code):
    """Logged out -> logged in: POST /v1/peers/ME/login with a login message to every paired device."""
    reconcile_allow(cx)
    allow_list_call(cx, "POST", "/v1/peers/%s/login" % cx.me, lambda m, _: {"ticket": code, "m": m},
                    lambda *a: ("login", 1))
    with cx.store.state() as d:
        d["reg"] = "registered"
        d.pop("logout_pending", None)
    with contextlib.suppress(ApiError, TempFail):
        cx.refresh()


def send_logout(cx):
    """The relay server logout. True when it is settled (done, or the server answered with a refusal
    that a retry cannot fix, such as the device already being gone); False when it should be retried."""
    try:
        reconcile_allow(cx)
        allow_list_call(cx, "POST", "/v1/peers/%s/logout" % cx.me, lambda m, _: {"m": m}, lambda *a: ("logout", 1))
    except ApiError as e:
        return not (e.status == 401 and e.error == "clock skew")
    except Fail:
        return False
    return True


def retry_pending_logout(cx):
    """Run start: a logout saved by cmd_logout is sent again until the relay server settles it."""
    with contextlib.suppress(Fail, OSError):
        with cx.store.state(write=False) as d:
            pending, reg = d.get("logout_pending") is True, d.get("reg")
        if not pending:
            return
        cx.setup()
        if reg == "logged_out" and not send_logout(cx):
            return
        with cx.store.state() as d:
            d.pop("logout_pending", None)


def cmd_logout(cx, args):
    with cx.store.state(write=False) as d:
        reg = d.get("reg")
    if reg != "registered":
        if reg == "logged_out":
            retry_pending_logout(cx)
        print("This device is already logged out." if reg == "logged_out" else "This device is not logged in.")
        return EXIT_OK
    cx.setup()
    with cx.store.state() as d:
        d["reg"], d["logout_pending"] = "logged_out", True
    print("Logged out. Run pusharmor login to log in again.")
    retry_pending_logout(cx)
    with cx.store.state(write=False) as d:
        if d.get("logout_pending"):
            log("The relay server could not be told yet. PushArmor will try again the next time it runs.")
    return EXIT_OK


def resolve_peer(cx, text, with_self=False):
    with cx.store.state(write=False) as d:
        ids = list(d["peers"]) + ([cx.me] if with_self else [])
    x = resolve_id(text, ids)
    if x is None:
        raise Fail("No device matches %s. Run pusharmor pair to see your devices." % text)
    return x


def peer_status(p, e):
    if p["pinned"] and p["ruling"] == "approved" and p["approves_me"]:
        return "paired" + (", logged out" if p["logged_out"] else ", send only" if not p["listening"] else "")
    if e and e["state"] == "shown" and not e["approved"]:
        return "compare fingerprint " + e["fingerprint"]
    if p["pinned"] and p["ruling"] == "approved":
        return "waiting for it to approve"
    if e:
        return "wants to pair" if e["role"] == "X" and e["state"] == "prompted" else "pairing"
    return "denied" if p["ruling"] == "denied" else "not paired"


def pair_list(cx):
    cx.refresh()
    with cx.store.state(write=False) as d:
        ids = list(d["peers"]) + [cx.me]
        rows = [("ID", "NAME", "DEVICE", "STATUS"), (short_id(cx.me, ids), d["name"], "Command line", "this device")]
        for pid, p in sorted(d["peers"].items(), key=lambda kv: kv[1]["created"]):
            rows.append((short_id(pid, ids), peer_label(p), platform_label(p["platform"]),
                         peer_status(p, d["pairs"].get(pid))))
    w = [max(len(r[i]) for r in rows) for i in range(3)]
    for r in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r[:3])) + "  " + r[3])
    if len(rows) > 2:
        print("\nTo pair with a device: pusharmor pair ID")
    return EXIT_OK


def cmd_pair(cx, args):
    cx.need()
    if not args.id:
        return pair_list(cx)
    if not sys.stdin.isatty():
        raise Fail("pusharmor pair ID needs a terminal to compare the pairing fingerprint.", EXIT_USAGE)
    cx.mode = "pair"
    cx.refresh()
    x = cx.target = resolve_peer(cx, args.id, with_self=True)
    if x == cx.me:
        raise Fail("That is this device.")
    with cx.store.state(write=False) as d:
        drain = Stream(d["ntfy"], d["topic"], cx.keys, d.get("since", ""), WAIT_TIMEOUT_S, poll=True)
    while True:  # pairing messages the relay server sent while nothing listened
        pt = drain.next(time.time() + WAIT_TIMEOUT_S)
        if pt is None:
            break
        pair_receive(cx, pt, drain)
    stream = start_receive(cx, drain.since, WAIT_TIMEOUT_S)
    sweep(cx)
    deadline, told, first = time.time() + PAIR_WAIT_S, None, True
    while True:
        with cx.store.state(write=False) as d:
            p, e = d["peers"].get(x), d["pairs"].get(x)
            sid = short_id(x, d["peers"])
        name = peer_label(p)
        if p is None:
            raise Fail("%s is no longer on this account." % name)
        if p["pinned"] and p["ruling"] == "approved" and p["approves_me"]:
            print("Paired with %s." % name)
            return EXIT_OK
        r, wait = "sent", "Waiting for %s. Open PushArmor on it to continue pairing." % name
        if e and e["state"] == "shown" and not e["approved"]:
            if first and e["role"] == "N":
                post_pair(cx, x, "open", e["msg"])
            first = False
            print("Pairing fingerprint %s" % e["fingerprint"])
            if not ask_yes("Check that %s shows the same fingerprint. Approve %s? [y/N] " % (name, name)):
                deny(cx, x)
                print("Did not pair with %s." % name)
                return EXIT_OK
            r = approve(cx, x)
            if r not in ("sent", "stored"):
                raise Fail("Could not reach %s (%s). Run pusharmor pair %s again later." % (name, r, sid))
            continue
        if p["pinned"] and p["ruling"] == "approved":
            wait = "Waiting for %s to approve this device." % name
            if first and e and e["approve_body"]:
                r = post_approve(cx, x, json.loads(e["approve_body"]))
                r = "sent" if r == "stored" else r
        elif e and e["role"] == "X" and e["state"] == "prompted":
            with cx.store.state() as d:
                d["pairs"][x]["authorized"] = True
            r = send_reply(cx, x) or "failed"
        elif e and first and e["role"] == "N":
            r = post_pair(cx, x, "commit", e["msg"])
        elif not e:
            r = pair_start(cx, x)
        first = False
        if r not in ("sent", "429"):
            raise Fail("Could not reach %s (%s). Run pusharmor pair %s again later." % (name, r, sid))
        if wait != told:
            log(wait)
            told = wait
        pt = stream.next(deadline)
        if pt is None:
            raise Fail("No answer from %s yet. Run pusharmor pair %s again to continue." % (name, sid))
        pair_receive(cx, pt, stream)


def pair_receive(cx, pt, stream):
    """pair: receive, and move the listen position on while no content message waits for listen."""
    receive(cx, pt)
    if not cx.skipped:
        with cx.store.state() as d:
            d["since"] = stream.since


def cmd_listen(cx, args):
    cx.need()
    cx.mode = "listen"
    fmt = "json" if args.json else "tsv" if args.tsv else "blocks"
    with contextlib.suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(line_buffering=True)

    def emit(rec):
        if args.exec:
            return run_exec(args.exec, rec)
        print(format_record(rec, fmt), flush=True)

    cx.emit = emit
    with cx.store.state(write=False) as d:
        since = d.get("since", "")
    stream = start_receive(cx, since, LISTEN_TIMEOUT_S)
    cx.refresh()
    sweep(cx)
    log("Listening. Press Ctrl+C to stop.")
    while True:
        with cx.store.state(write=False) as d:
            due = d.get("listen_at", 0) + LISTEN_REPORT_S
        pt = stream.next(due)
        if pt is None:
            try:
                report_listening(cx)
            except TempFail as e:
                log(str(e))
                with cx.store.state() as d:
                    d["listen_at"] = int(time.time()) - LISTEN_REPORT_S + 3600
            continue
        try:
            receive(cx, pt)
        except TempFail as e:
            log(str(e))
        except ApiError as e:
            if e.status == 401:
                raise
            log("The relay server refused a request: %s" % (e.error or e.status))
        with cx.store.state() as d:
            d["since"] = stream.since


def cmd_send(cx, args):
    cx.need()
    if args.message and args.message != ["-"]:
        text = " ".join(args.message)
    elif args.message == ["-"] or not sys.stdin.isatty():
        try:
            text = sys.stdin.buffer.read().decode("utf-8").rstrip("\r\n")
        except UnicodeDecodeError:
            raise Fail("The input is not UTF-8 text.")
    else:
        raise Fail("Nothing to send. Give a message, or pipe text into pusharmor send.", EXIT_USAGE)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise Fail("The message is not UTF-8 text.")
    if not text.strip():
        raise Fail("Nothing to send.", EXIT_USAGE)
    type_, value = ("text", text) if args.text else detect(text)
    size = len(value.encode("utf-8"))
    if size > CONTENT_CAP:
        raise Fail("Too long (%d / %d bytes)." % (size, CONTENT_CAP), EXIT_USAGE)
    cx.refresh()
    with cx.store.state() as d:
        ready = [pid for pid, p in d["peers"].items() if sendable(p)]
        targets = ready
        if args.to:
            targets = []
            for t in args.to:
                pid = resolve_id(t, list(d["peers"]))
                if pid is None:
                    raise Fail("No device matches %s. Run pusharmor pair to see your devices." % t)
                if pid not in ready:
                    p = d["peers"][pid]
                    raise Fail("Cannot send to %s: %s" % (peer_label(p), peer_status(p, d["pairs"].get(pid))), EXIT_SEND)
                targets.append(pid)
        if not targets:
            raise Fail("No paired devices to send to. Run pusharmor pair to pair one.", EXIT_SEND)
        m, names = {}, {}
        for pid in dict.fromkeys(targets):
            p = d["peers"][pid]
            names[pid] = peer_label(p)
            m[pid] = seal_msg(cx.keys, pid, p, reserve(p), type_, value)
    j = cx.api.call("POST", "/v1/send", {"v": 1, "m": m})
    res = j.get("r") if isinstance(j.get("r"), dict) else {}
    why = {"gone": "not delivered, open PushArmor on it", "not listening": "send only, it is not listening",
           "unapproved": "not paired", "denied": "denied this device", "unknown": "no longer on this account",
           "failed": "delivery failed"}
    failed = [pid for pid in m if res.get(pid) != "sent"]
    with cx.store.state() as d:
        for pid in failed:
            r = res.get(pid, "failed")
            log("%s: %s" % (names[pid], why.get(r, r)))
            p = d["peers"].get(pid)
            if p and r == "logged out":
                p["logged_out"] = True
            if p and r == "not listening":
                p["listening"] = False
    log("Sent to %d of %d device%s." % (len(m) - len(failed), len(m), "" if len(m) == 1 else "s"))
    return EXIT_SEND if failed else EXIT_OK


def cmd_rename(cx, args):
    if not NAME_RE.fullmatch(args.name):
        raise Fail("Use 1 to 32 plain ASCII characters, no double quote.", EXIT_USAGE)
    cx.need()
    k = cx.keys

    def content(pid, p, n, names):
        e = make_name_entry(k["sign"], k["id"], pid, b64d(p["pairing_id"]), n, args.name)
        names[pid] = seal_name_entry(pid, b64d(p["enc_pub"]), e)
        return "rename", e

    allow_list_call(cx, "PATCH", "/v1/peers/" + cx.me, lambda m, names: {"name": names, "m": m}, content)
    with cx.store.state() as d:
        d["name"] = args.name
    print("This device is now named %s." % args.name)
    return EXIT_OK


def cmd_delete(cx, args):
    cx.setup()
    x = resolve_peer(cx, args.id, with_self=True)
    with cx.store.state(write=False) as d:
        reg, name = d.get("reg"), peer_label(d["peers"].get(x))
    if reg != "registered" and (x != cx.me or reg != "logged_out"):
        raise Fail(LOGGED_OUT if reg == "logged_out" else NOT_LOGGED_IN, EXIT_LOGIN)
    if x == cx.me:
        q = "Remove this device from your account? It must log in again and pair with every device again. [y/N] "
    else:
        q = "Remove %s from your account? %s must log in again and pair with every device again. [y/N] " % (name, name)
    if not args.yes:
        if not sys.stdin.isatty():
            raise Fail("Refusing to delete without a terminal. Use --yes.", EXIT_USAGE)
        if not ask_yes(q):
            print("Nothing removed.")
            return EXIT_ERR
    allow_list_call(cx, "DELETE", "/v1/peers/" + x, lambda m, _: {"m": m}, lambda *a: ("remove", x))
    if x == cx.me:
        cx.store.wipe()
        print("This device was removed from your account, and its local files were deleted.")
        return EXIT_OK
    with cx.store.state() as d:
        d["peers"].pop(x, None)
        d["pairs"].pop(x, None)
        d["my_allow"] = [i for i in d["my_allow"] if i != x]
    print("Removed %s." % name)
    return EXIT_OK


# The one command table: name -> (function, help, arguments). Names are frozen (Q341 A).
COMMANDS = {
    "login": (cmd_login, "Log in this device to your PushArmor account.", []),
    "logout": (cmd_logout, "Log out this device. Keys and paired devices stay on it.", []),
    "pair": (cmd_pair, "List your devices, or pair with one (compare the fingerprint, then approve).",
             [(("id",), {"nargs": "?", "metavar": "ID", "help": "device ID from the list (6 or more hex characters)"})]),
    "listen": (cmd_listen, "Receive messages and print them as they arrive.",
               [(("--json",), {"action": "store_true", "help": "one JSON object per line"}),
                (("--tsv",), {"action": "store_true", "help": "tab-separated lines"}),
                (("--exec",), {"metavar": "PROG", "help": "run PROG ID NAME PLATFORM TYPE BODY per message"})]),
    "send": (cmd_send, "Send a link or text to your paired devices (all, or --to ID).",
             [(("message",), {"nargs": "*", "metavar": "MESSAGE", "help": "text to send; - or none reads stdin"}),
              (("--to",), {"action": "append", "metavar": "ID", "help": "send to this device only (repeatable)"}),
              (("--text",), {"action": "store_true", "help": "send as plain text, not as a link or phone number"})]),
    "rename": (cmd_rename, "Change the name your other devices show for this device.",
               [(("name",), {"metavar": "NAME", "help": "1 to 32 plain ASCII characters, no double quote"})]),
    "delete": (cmd_delete, "Remove a device from your account (this device too).",
               [(("id",), {"metavar": "ID", "help": "device ID from pusharmor pair"}),
                (("--yes",), {"action": "store_true", "help": "do not ask for confirmation (needed without a terminal)"})]),
}


def build_parser():
    p = argparse.ArgumentParser(prog="pusharmor", description="PushArmor: send links and text to your own "
                                "devices, end-to-end encrypted. See https://pusharmor.com",
                                epilog="exit codes:\n" + "\n".join("  %-3d %s" % c for c in EXIT_CODES),
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", metavar="DIR", help="config dir (default: $PUSHARMOR_CONFIG, else "
                   "$XDG_CONFIG_HOME/pusharmor, else ~/.config/pusharmor)")
    p.add_argument("--version", action="version", version="pusharmor " + VERSION)
    sub = p.add_subparsers(dest="command", metavar="COMMAND", required=True)
    for name, (fn, text, arguments) in COMMANDS.items():
        sp = sub.add_parser(name, help=text, description=text)
        for flags, kw in arguments:
            sp.add_argument(*flags, **kw)
        if name == "listen":
            sp.set_defaults(_check=lambda a: sum([a.json, a.tsv, bool(a.exec)]) <= 1)
    return p


def main(argv=None):
    try:
        check_os()
    except Fail as e:
        log(str(e))
        return e.code
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "_check", lambda a: True)(args):
        parser.error("use only one of --json, --tsv, and --exec")
    cx = Ctx(config_dir(args.config))
    if args.config and os.path.exists(cx.store.root) and not os.path.isdir(cx.store.root):
        log("The --config path %s is a file, not a folder." % cx.store.root)
        return EXIT_USAGE
    if args.config and args.command not in ("login", "logout") and not os.path.isdir(cx.store.root):
        log("Not logged in. The --config folder %s does not exist." % cx.store.root)
        return EXIT_LOGIN
    try:
        if args.command not in ("login", "logout"):
            retry_pending_logout(cx)
        return COMMANDS[args.command][0](cx, args)
    except KeyboardInterrupt:
        log("Stopped.")
        return 130
    except Fail as e:
        log(str(e))
        return e.code
    except ApiError as e:
        if e.status == 401 and e.error == "unknown peer":
            cx.store.wipe()
            log(REMOVED)
            return EXIT_LOGIN
        if e.status == 401 and e.error == "logged out":
            with contextlib.suppress(Fail, OSError), cx.store.state() as d:
                d["reg"] = "logged_out"
            log(LOGGED_OUT)
            return EXIT_LOGIN
        if e.status == 401 and e.error == "clock skew":
            log("This device's clock is off by more than 5 minutes. Fix the clock and try again.")
            return EXIT_ERR
        log("The relay server refused the request (%s)." % (("%d %s" % (e.status, e.error)).strip()))
        return EXIT_ERR


if __name__ == "__main__":
    sys.exit(main())

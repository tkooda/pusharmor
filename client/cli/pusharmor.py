#!/usr/bin/env python3
# PushArmor command-line client, version 0.0.0
"""PushArmor command-line client.

The top part is the core layer: encodings, keys, signed requests, HPKE,
inner messages, name entries, pairing, replay window, RFC 8291 push decrypt
and send-type detection. Pure functions only: no network, no files.
"""

import sys


def check_python(version_info=None):
    """Exit before any import that needs Python 3.9 (this file's syntax parses on 3.6 and later)."""
    if tuple(version_info or sys.version_info)[:2] < (3, 9):
        sys.stderr.write("error: PushArmor needs Python 3.9 or later. Install a newer Python and try again.\n")
        sys.exit(2)


check_python()

import hashlib
import hmac
import ipaddress
import json
import re
import unicodedata
import zlib

CRYPTO_MISSING = ('The Python "cryptography" package is missing. Install it with: '
                  + ("py" if sys.platform == "win32" else "python3") + " -m pip install --user cryptography")

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except (KeyboardInterrupt, SystemExit):
    raise
except BaseException:  # missing, or broken: no _cffi_backend is ImportError, a Rust panic is BaseException
    sys.stderr.write("error: " + CRYPTO_MISSING + "\n")
    sys.exit(1)

VERSION = "0.0.0"
USER_AGENT = "PushArmor-CLI/" + VERSION

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
    """Raises ValueError on invalid UTF-8, bad JSON, a duplicate key, trailing data, or too deep nesting."""
    try:
        return json.loads(bytes(b).decode("utf-8"), object_pairs_hook=_pairs,
                          parse_int=_Num, parse_float=_Num, parse_constant=_bad_constant)
    except RecursionError:
        raise ValueError("json: nested too deeply")


def counter_n(v):
    """The n counter from its raw token (^[1-9][0-9]*$, <= 2^53 - 1), else None."""
    if not isinstance(v, _Num) or len(v) > 16 or not re.fullmatch(r"[1-9][0-9]*", v):
        return None
    n = int(v)
    return n if n <= 2 ** 53 - 1 else None


# ---- inner messages ----

TYPES = ("url", "text", "tel", "approve", "deny", "remove", "rename", "delete", "logout", "login", "del")
CONTROL_TYPES = ("approve", "rename", "remove", "delete", "logout", "login", "deny", "del")
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


def new_msg_id():
    return base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode()


def msg_json(n, type_, value, mid=None):
    """Exact inner JSON {"n":N,"<type>":value}, n first. value: str for url/text/tel/remove,
    a name entry (make_name_entry, same n) for approve/rename, 1 for deny/delete/logout/login."""
    v = name_entry_json(value) if type_ in ("approve", "rename") else json.dumps(value)
    return '{"n":' + str(n) + ',"' + type_ + '":' + v + ("" if mid is None else ',"id":' + json.dumps(mid)) + "}"


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
    if type_ is None:  # signed by a pinned peer: the caller may consume n and ignore it (a type from a newer client)
        window = pin.get("window") or {"h": 0, "seen": []}
        return {"outcome": "unreadable", "why": "type", "from": from_id, "n": n, "flag": flag,
                "ignorable": pin["ruling"] == "approved" and flag == 0 and replay_outcome(window, n, "", False) == "accept"}
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
    elif type_ == "del":
        if type(value) is not list or not all(type(i) is str for i in value):
            return bad("del ids")
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
PAIR_TIMEOUT_DAYS = 14
PAIR_TIMEOUT_S = PAIR_TIMEOUT_DAYS * 86400
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
    if sum(1 for t in i["cap"] if 0 <= i["now"] - t < PAIR_CAP_WINDOW_S) >= PAIR_CAP_MAX:
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


def _ipv6_text(text):
    """The URL standard form of an IPv6 literal: lowercase hex pieces, the first longest run of
    two or more zero pieces as "::", embedded IPv4 as hex (Python's own text differs by version)."""
    if "%" in text:
        raise ValueError(text)
    b = ipaddress.IPv6Address(text).packed
    w = [b[i] << 8 | b[i + 1] for i in range(0, 16, 2)]
    best, blen, i = -1, 1, 0
    while i < 8:
        j = i
        while j < 8 and w[j] == 0:
            j += 1
        if j - i > blen:
            best, blen = i, j - i
        i = j + 1 if j > i else i + 1
    if best < 0:
        return ":".join("%x" % x for x in w)
    return ":".join("%x" % x for x in w[:best]) + "::" + ":".join("%x" % x for x in w[best + blen:])


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
            host = "[" + _ipv6_text(auth[1:close]) + "]"
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
import errno
import glob
import http.client
import os
import secrets
import shlex
import shutil
import socket
import ssl
import stat
import string
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

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
EXIT_OK, EXIT_ERR, EXIT_USAGE, EXIT_LOGIN, EXIT_SEND, EXIT_BUG, EXIT_TEMP = 0, 1, 2, 3, 4, 70, 75
EXIT_CODES = (
    (EXIT_OK, "success"),
    (EXIT_ERR, "error: a failed request, a damaged or unreadable file, or a failed write on this device"),
    (EXIT_USAGE, "wrong command line, or the command needs a terminal"),
    (EXIT_LOGIN, "not logged in, logged out, or this device was removed"),
    (EXIT_SEND, "send failed for at least one device, or there is no device to send to"),
    (EXIT_BUG, "an unexpected error in PushArmor; please report it"),
    (EXIT_TEMP, "the relay server is busy or unreachable; try again later"),
    (130, "stopped with Ctrl-C"),
)
UPDATE_REQUIRED = "Update PushArmor to continue."
CODE_TRIES = 3
LINK_LIFE_S = 600
PROBE_WAIT_S = 30
PAIR_WAIT_S = 600
LISTEN_TIMEOUT_S = 120  # ntfy sends a keepalive every 45 s
WAIT_TIMEOUT_S = 60  # login and pair: above the 45 s keepalive, so an idle read is not cut short
LISTEN_REPORT_S = 86400
FETCH_GAP_S = 60
PLATFORMS = {"android": "Android", "ios": "iPhone", "chrome": "Chrome", "firefox": "Firefox", "cli": "Command line"}
MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
REC_KEYS = ("from", "name", "platform", "type", "body", "date")
NOT_LOGGED_IN = "This device is not logged in. Run: `pusharmor login`"
LOGGED_OUT = "This device is logged out. Log in to resume."
REMOVED = "This device was removed from the account. Log in again."
CERT_BAD = "The relay server's certificate could not be verified. Check this device's date and time, proxy, and CA certificates."
UNREACHABLE = "The relay server could not be reached. Check your internet connection and try again."
SERVER_DOWN = "The relay server is not working right now. Try again later."
TOO_OLD = ("This version of PushArmor is too old. " + UPDATE_REQUIRED + " "
    "Update: pipx upgrade pusharmor (or download it from https://pusharmor.com/download)")
CLOCK_OFF = "This device's clock is off by more than 5 minutes. Fix the clock and try again."
REFUSED = "The relay server refused the request (HTTP %d)."
BAD_LINK = "The login link is not valid. Request a new code and try again."
TOO_LONG = "The message is longer than 2048 characters."
STORAGE_FULL = "Storage is full. Free some space and try again."
DAMAGED = "The file %s is damaged. Delete it and log in again."
UNREADABLE = "PushArmor could not read a message. It is not valid or was damaged."
PUSH_DOWN = "The push service at %s could not be reached. Check your internet connection and try again."
KEY_HEADER = ("# PushArmor private keys of this device. Keep this file secret: with it, anyone can\n"
              "# read the messages sent to this device and send as this device. Do not copy or share it.\n")


class Fail(Exception):
    """A one-line reason for stderr and an exit code."""

    def __init__(self, msg, code=EXIT_ERR):
        super().__init__(msg)
        self.code = code


class TempFail(Fail):
    def __init__(self, msg, status):
        super().__init__(msg, EXIT_TEMP)
        self.status = status


class ApiError(Exception):
    def __init__(self, status, error, body):
        error = _clean(error)[:80]
        super().__init__("%d %s" % (status, error))
        self.status, self.error, self.body = status, error, body

    def reason(self):
        """The sentence for the user; the relay server word itself is never shown."""
        if self.status == 401 and self.error == "clock skew":
            return CLOCK_OFF
        if self.status == 401 and self.error in ("bad ticket", "invalid ticket"):
            return BAD_LINK
        if self.status == 401 and self.error == "account mismatch":
            return "This login is for another account. Log in with the email address of this device's account."
        if self.status == 403 and self.error == "banned":
            return "This account is blocked."
        if self.status == 413 and self.error == "too large":
            return TOO_LONG
        if self.status == 426:
            return TOO_OLD
        return REFUSED % self.status


def wait_text(s):
    """Seconds -> "30 seconds" or, over 60 seconds, whole minutes rounded up."""
    if s > 60:
        m = (s + 59) // 60
        return "1 minute" if m == 1 else "%d minutes" % m
    return "1 second" if s == 1 else "%d seconds" % s


def windows():
    """Windows: files in the APPDATA folder, msvcrt locks, and no POSIX owner or mode bits to check."""
    return sys.platform == "win32"


def log(level, msg):
    """One line on stderr. level: error (the command fails), warning (a problem; the command goes on),
    or info (an event)."""
    if sys.stderr is None:
        return
    print(level + ": " + msg, file=sys.stderr, flush=True)


def stdin_tty():
    """False also when stdin is closed (<&-)."""
    return sys.stdin is not None and sys.stdin.isatty()


def ask(prompt):
    """input(); typed text that is not UTF-8 reads as one character that matches no answer."""
    try:
        return input(prompt)
    except UnicodeDecodeError:
        return "\ufffd"


def ask_yes(question, default=False, strict=False):
    """strict: end of input (Ctrl-D) raises EOFError instead of answering no."""
    try:
        a = ask(question).strip().lower()
    except EOFError:
        if strict:
            raise
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
    try:
        if tomllib is None:
            return _toml_loads(text)
        return tomllib.loads(text)
    except RecursionError:
        raise TomlError("nested too deeply")
    except ValueError as e:  # tomllib.TOMLDecodeError
        raise TomlError(str(e))


# ---- files ----

def config_dir(arg=None):
    for v in (arg, os.environ.get("PUSHARMOR_CONFIG")):
        if v:
            return os.path.abspath(os.path.expanduser(v))
    if windows():
        return os.path.join(os.environ.get("APPDATA") or os.path.join(str(Path.home()), "AppData", "Roaming"),
                            "PushArmor")
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg and os.path.isabs(xdg):
        return os.path.join(xdg, "pusharmor")
    home = os.path.expanduser("~")
    if not os.path.isabs(home) or home == "/":
        with contextlib.suppress(KeyError, ImportError):
            import pwd  # not on Windows, which returned above
            home = pwd.getpwuid(os.getuid()).pw_dir
    base = os.path.join(home, ".config")
    return os.path.join(base, "pusharmor")


def write_file(path, text):
    """Temp file in the same dir + os.replace; mode 0600. A symlink is written through, so it stays a link."""
    path = os.path.realpath(path)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
    with contextlib.suppress(OSError):
        dfd = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)


def check_private(path, want):
    """Owner must be this user, no group or other bits. Windows: the private profile folder protects it."""
    if windows():
        return
    st = os.stat(path)
    mode = stat.S_IMODE(st.st_mode)
    if st.st_uid == os.getuid() and not mode & 0o077:
        return
    q = quoted_path(path)
    if st.st_uid != os.getuid():
        raise Fail("%s belongs to another user. Run: `chown $(id -un) %s`" % (q, q))
    raise Fail("%s must not be readable by other users. Run: `chmod %o %s`" % (q, want, q))


def check_unshared(path, folder):
    """A folder or regular file owned by this user that no group and no other user can change.
    A symlink, at any level, is followed and its target checked. Windows: only the kind is checked."""
    st = os.stat(path)
    if not (stat.S_ISDIR if folder else stat.S_ISREG)(st.st_mode) or not windows() and st.st_uid != os.getuid():
        raise Fail("%s must be a %s that you own." % (quoted_path(path), "folder" if folder else "file"))
    if windows():
        return
    mode = stat.S_IMODE(st.st_mode)
    if mode & 0o022:
        raise Fail("%s can be changed by other users. Run: `chmod go-w %s`" % (quoted_path(path), quoted_path(path)))


def quoted_path(path):
    """A path in single quotes the shell takes as is (shlex.quote leaves a plain path bare)."""
    q = shlex.quote(path)
    return q if q.startswith("'") else "'%s'" % q


def read_toml(path):
    try:
        with open(path, "rb") as f:
            return toml_loads(f.read().decode("utf-8"))
    except TomlError as e:
        raise Fail("The file %s has a mistake (%s). Fix it or delete it." % (quoted_path(path), e))
    except UnicodeDecodeError:
        raise Fail(DAMAGED % quoted_path(path))


def check_version(d, path):
    v = d.get("version")
    if v is None:
        raise Fail(DAMAGED % quoted_path(path))
    if type(v) is not int or v != STATE_VERSION:
        raise Fail("The file %s was made by a newer PushArmor. %s" % (quoted_path(path), UPDATE_REQUIRED))


def _host_ok(url):
    """A host and port that urllib can use: no empty or over-long label, a port up to 65535."""
    try:
        u = urllib.parse.urlsplit(url)
        u.port
        return bool(u.hostname) and bool(u.hostname.encode("idna"))
    except ValueError:  # UnicodeError too
        return False


def _loopback(url):
    """localhost or a loopback IP address: plain http is allowed only for a server on this machine."""
    host = urllib.parse.urlsplit(url).hostname
    try:
        return host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


STATE_LISTS = (("my_allow", str), ("listed", str), ("pair_auto", int))
STATE_OPTIONAL = (("reg", str), ("name", str), ("ntfy", str), ("topic", str), ("since", str), ("listen_at", int),
                  ("push_ok", bool), ("logout_pending", bool))


def check_shape(d, path):
    """devices.toml holds every field this PushArmor reads, each of the type it writes."""
    def rows_ok(rows, tmpl):
        return type(rows) is dict and all(
            type(r) is dict and all(type(r.get(k)) is type(v) for k, v in tmpl.items()) for r in rows.values())

    ok = (rows_ok(d["peers"], new_peer({"sign_pub": "", "enc_pub": ""}))
          and all(type(n) is int for p in d["peers"].values() for n in p["seen"])
          and rows_ok(d["pairs"], new_entry("N", "", b"", b""))
          and all(type(d[k]) is list and all(type(x) is t for x in d[k]) for k, t in STATE_LISTS)
          and all(type(d.get(k, t())) is t for k, t in STATE_OPTIONAL)
          and ("reg" not in d or all(k in d for k in ("name", "ntfy", "topic"))))
    if not ok:
        raise Fail(DAMAGED % quoted_path(path))


class Store:
    def __init__(self, root):
        self.root = root
        self.keys_dir = os.path.join(root, "keys")
        self.key_path = os.path.join(self.keys_dir, "private.toml")
        self.dev_path = os.path.join(root, "devices.toml")
        self.lock_path = os.path.join(root, "devices.toml.lock")

    def settings(self):
        p = os.path.join(self.root, "settings.toml")
        s = {}
        if os.path.lexists(p):
            check_unshared(p, False)
            s = read_toml(p)
        for k in ("server", "ntfy"):
            if k in s and not (isinstance(s[k], str) and re.match(r"https?://[^/?#]+/?$", s[k]) and _host_ok(s[k])
                               and (s[k].startswith("https://") or _loopback(s[k]))):
                raise Fail('The setting "%s" in %s must be a web address that starts with https://, such as '
                           "https://example.com." % (k, quoted_path(p)))
        return s

    def has_keys(self):
        return os.path.exists(self.key_path)

    def load_keys(self):
        if not self.has_keys():
            raise Fail(NOT_LOGGED_IN, EXIT_LOGIN)
        check_private(self.keys_dir, 0o700)
        check_private(self.key_path, 0o600)

        def unusable():  # never deleted automatically: the user decides
            return Fail("This device's keys have become unusable. Delete %s, then log in again. "
                        "You will then pair with all your devices again." % quoted_path(self.keys_dir))

        try:
            d = read_toml(self.key_path)
        except Fail:
            raise unusable()
        if d.get("version") is None:
            raise unusable()
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
            raise unusable()
        return k

    def save_keys(self, k):
        os.makedirs(self.root, 0o700, exist_ok=True)
        check_unshared(self.root, True)
        os.makedirs(self.keys_dir, 0o700, exist_ok=True)
        check_private(self.keys_dir, 0o700)
        write_file(self.key_path, KEY_HEADER + toml_dumps({
            "version": STATE_VERSION, "id": k["id"], "sign_key": b64e(k["sign"]), "enc_key": b64e(k["enc"]),
            "push_key": b64e(k["push"]), "push_auth": b64e(k["auth"])}))

    @contextlib.contextmanager
    def locked(self):
        """An exclusive lock on devices.toml.lock: flock, or on Windows msvcrt on its first byte."""
        with open(self.lock_path, "a") as lf:
            if not windows():
                import fcntl
                fcntl.flock(lf, fcntl.LOCK_EX)
                yield
                return
            import msvcrt
            lf.seek(0)
            while True:
                try:
                    msvcrt.locking(lf.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError as e:  # LK_LOCK gives up after 10 seconds: wait on, as flock does
                    if e.errno != errno.EDEADLOCK:
                        raise
            try:
                yield
            finally:
                lf.seek(0)
                msvcrt.locking(lf.fileno(), msvcrt.LK_UNLCK, 1)

    @contextlib.contextmanager
    def state(self, write=True, fresh=False):
        """devices.toml under an exclusive flock (listen and send may run at the same time).
        fresh: a new login replaces the old file without reading it, so a damaged one never stops it."""
        os.makedirs(self.root, 0o700, exist_ok=True)
        check_unshared(self.root, True)
        with self.locked():
            if write and not self.has_keys():  # deleted by another PushArmor run: nothing to write back
                raise Fail(NOT_LOGGED_IN, EXIT_LOGIN)
            d = {"version": STATE_VERSION}
            if os.path.lexists(self.dev_path):
                check_unshared(self.dev_path, False)
                if not fresh:
                    d = read_toml(self.dev_path)
                    check_version(d, self.dev_path)
            for k, v in (("peers", {}), ("pairs", {}), ("my_allow", []), ("listed", []), ("pair_auto", [])):
                d.setdefault(k, v)
            check_shape(d, self.dev_path)
            try:
                toml_dumps(d)
            except ValueError:  # a value this PushArmor cannot write back, such as a float
                raise Fail(DAMAGED % quoted_path(self.dev_path))
            yield d
            if write:
                write_file(self.dev_path, toml_dumps(d))

    def wipe(self):
        """Under the devices.toml lock, so a run writing state at the same time is never cut off."""
        with self.locked():
            tmps = glob.glob(os.path.join(self.keys_dir, ".tmp-*")) + glob.glob(os.path.join(self.root, ".tmp-*"))
            paths = [self.key_path, self.dev_path]
            if os.path.islink(self.dev_path):
                # a symlinked devices.toml: reset the target to no devices (the link and the target stay), clean beside it
                real = os.path.realpath(self.dev_path)
                if os.path.isfile(real):
                    write_file(self.dev_path, toml_dumps({"version": STATE_VERSION}))
                paths.remove(self.dev_path)
                tmps += glob.glob(os.path.join(os.path.dirname(real), ".tmp-*"))
            for p in paths + tmps:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(p)
            with contextlib.suppress(OSError):
                os.rmdir(self.keys_dir)


# ---- HTTP (urllib only) ----

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 3xx reply comes back as an HTTPError; signed headers never go to another URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http_request(method, url, headers, body):
    """One HTTP exchange -> (status, lower-case headers, body). Raises OSError when the network fails."""
    try:
        req = urllib.request.Request(url, data=body, headers=dict(headers, **{"User-Agent": USER_AGENT}), method=method)
        with _OPENER.open(req, timeout=30) as r:
            data = r.read(MAX_REPLY + 1)
            if len(data) > MAX_REPLY:
                raise OSError("reply too large")
            data += r.read()  # at the end now: b"", or IncompleteRead for a cut-off reply
            return r.status, {k.lower(): v for k, v in r.headers.items()}, data
    except urllib.error.HTTPError as e:
        with e:
            try:
                data = e.read(MAX_REPLY + 1)
                if len(data) <= MAX_REPLY:
                    data += e.read()
            except (OSError, http.client.HTTPException):  # a cut-off error body: the status still counts
                data = b""
            if len(data) > MAX_REPLY:
                raise OSError("reply too large")
            return e.code, {k.lower(): v for k, v in e.headers.items()}, data
    except (http.client.HTTPException, ValueError) as e:  # ValueError: a bad host or redirect URL
        raise OSError(str(e)) from e


def ntfy_open(url, timeout):
    """Opens an ntfy JSON stream (one event per readline()). Raises OSError."""
    try:
        return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout)
    except (http.client.HTTPException, ValueError) as e:
        raise OSError(str(e)) from e


def is_cert_error(e):
    """True for a TLS certificate failure, bare or wrapped in URLError.reason."""
    return isinstance(e, ssl.SSLCertVerificationError) or isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError)


def _why(e):
    return e.reason() if isinstance(e, ApiError) else str(e)


RETRY_WAITS = (1, 3)  # seconds slept before the 2nd and 3rd try of a 5xx or network failure


class Api:
    def __init__(self, server, keys=None):
        self.base = server.rstrip("/")
        self.keys = keys
        self.skew_ms = 0
        self.push_missing = False
        self.sleep = lambda s: time.sleep(s)  # injectable; tests replace it

    def call(self, method, path, body=None, with_id=True, signed=True, tries=3):
        """Pass tries=1 for a call that is not safe to repeat. Signed JSON call -> reply object. 426 and network/5xx/429 (after tries) raise Fail;
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
            except OSError as e:
                if is_cert_error(e):
                    raise TempFail(CERT_BAD, 0)  # a retry cannot fix it
                status, hdrs, data = 0, {}, b""
            try:
                j = json.loads(data) if data else {}
            except (ValueError, RecursionError):
                j = {}
            j = j if isinstance(j, dict) else {}
            if status == 426:
                raise Fail(TOO_OLD)
            epoch = hdrs.get("pa-epoch", "")
            if status == 401 and j.get("error") == "clock skew" and not skewed and re.fullmatch(r"[0-9]{1,12}", epoch):
                skewed = True
                self.skew_ms = int(epoch) * 1000 - int(time.time() * 1000)
                continue
            if status == 0 or status == 429 or status >= 500:
                attempt += 1
                if attempt < tries:
                    ra = j.get("retry_after")
                    self.sleep(min(ra if type(ra) is int and ra > 0 else RETRY_WAITS[attempt - 1], 60))
                    continue
                if status == 0:
                    raise TempFail(UNREACHABLE, 0)
                if status == 429:
                    ra = j.get("retry_after")
                    ra = min(max(ra, 1), 3600) if type(ra) is int else 60
                    raise TempFail("Too many tries. Try again in %s." % wait_text(ra), 429)
                raise TempFail(SERVER_DOWN, status)
            if j.get("push_missing") is True:
                self.push_missing = True
            if 200 <= status < 300:
                return j
            raise ApiError(status, j.get("error") if isinstance(j.get("error"), str) else "", j)


# ---- ntfy stream (UnifiedPush endpoint https://<ntfy>/<topic>?up=1) ----

NTFY_LINE_CAP = 65536  # far above the largest push; a longer line is skipped, not held in memory
MAX_REPLY = 1 << 20  # a longer relay server reply counts as a network failure


def read_line(resp, cap):
    """resp.readline(cap). On Windows a blocked read ignores Ctrl+C until its timeout, so the read runs in a
    daemon thread and the main thread waits in short slices, where Ctrl+C is seen at once."""
    if os.name != "nt":
        return resp.readline(cap)
    box = []

    def run():
        try:
            box.append((True, resp.readline(cap)))
        except BaseException as e:
            box.append((False, e))

    t = threading.Thread(target=run, daemon=True)
    t.start()
    while t.is_alive():
        t.join(0.2)
    ok, v = box[0]
    if not ok:
        raise v
    return v


class Stream:
    def __init__(self, ntfy, topic, keys, since, timeout, poll=False):
        self.url = ntfy.rstrip("/") + "/" + topic + "/json"
        self.keys, self.since, self.timeout, self.poll = keys, since, timeout, poll
        self.resp, self.backoff, self.delay, self.in_long_line = None, 1, False, False

    def connect(self):
        self.in_long_line = False
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
                line = read_line(self.resp, NTFY_LINE_CAP)
            except (TimeoutError, socket.timeout):
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
            was_long, self.in_long_line = self.in_long_line, not line.endswith(b"\n")
            if was_long or self.in_long_line:
                continue
            try:
                ev = json.loads(line)
            except (ValueError, RecursionError):
                continue
            if not isinstance(ev, dict) or ev.get("event") != "message":
                continue
            self.backoff = 1
            if isinstance(ev.get("id"), str):
                self.since = ev["id"]
            try:
                msg = ev.get("message", "")
                body = base64.b64decode(msg, validate=True) if ev.get("encoding") == "base64" else msg.encode()
                return webpush_decrypt(body, self.keys["push"], self.keys["auth"]).decode("ascii")
            except Exception:
                log("warning", UNREADABLE)
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


def gmtime(t):
    """time.gmtime; a time out of range (from the relay server) reads as 1970."""
    try:
        return time.gmtime(t)
    except (OverflowError, OSError, ValueError):
        return time.gmtime(0)


def peer_label(p):
    if not p:
        return "A device"
    if p["name"]:
        return p["name"]
    t = gmtime(p["created"])
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
    return build_message(k["sign"], k["id"], x, b64d(p["enc_pub"]), pid, msg_json(n, type_, value, new_msg_id() if type_ in ("url", "text", "tel") else None),
                         keys=(k["sign_pub"], k["enc_pub"]) if approve else None)


def push_value(d, k):
    return {"type": "unifiedpush", "endpoint": "%s/%s?up=1" % (d["ntfy"].rstrip("/"), d["topic"]),
            "p256dh": b64e(k["push_pub"]), "auth": b64e(k["auth"])}


def new_topic():
    """"up" + 12 chars: the cli topic the relay server accepts (allowlist.ts cliTopicOk)."""
    return "up" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(12))


# ---- one run ----

class Ctx:
    def __init__(self, root):
        self.store = Store(root)
        self.settings, self.keys, self.api = {}, None, None
        self.mode, self.target, self.emit, self.last_fetch, self.skipped = "", None, None, 0, False
        self.also = set()  # pair: the other devices already shown as also wanting to pair

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
            try:
                self.refresh()
            except (ApiError, TempFail) as e:
                log("warning", "Could not refresh the device list: %s" % _why(e))


def _ids(xs):
    """The device ids in a list from the relay server: text of 40 base64url characters, each once."""
    out = []
    for x in xs:
        if isinstance(x, str) and len(x) == 40 and b64ok(x) and x not in out:
            out.append(x)
    return out


def merge_peers(d, j, k):
    me, acct, peers = k["id"], b64d(k["id"])[:9], d["peers"]
    d["my_allow"] = _ids(j["my_allow"]) if isinstance(j.get("my_allow"), list) else []
    listed = {it.get("id") for it in j["peers"] if isinstance(it, dict) and isinstance(it.get("id"), str)} if isinstance(j.get("peers"), list) else set()
    # stored remove messages (optional "removed"): opened with the pre-merge pins, quiet, like a live push
    for b, m in list(j["removed"].items())[:8] if isinstance(j.get("removed"), dict) else []:
        if isinstance(m, str) and b != me and b not in listed:
            open_fetched_remove(d, k, b, m)
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
        p.update(platform=it["platform"] if isinstance(it.get("platform"), str)
                 and re.fullmatch(r"[a-z0-9]{1,16}", it["platform"]) else "",
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


def open_fetched_remove(d, k, b, m):
    """Applies a fetched remove(b) only when it opens fresh and valid from a pinned peer; else drops it silently."""
    pins = {pid: {"sign_pub": b64d(p["sign_pub"]), "enc_pub": b64d(p["enc_pub"]),
                  "pairing_id": b64d(p["pairing_id"]), "ruling": p["ruling"],
                  "window": {"h": p["h"], "seen": p["seen"]}}
            for pid, p in d["peers"].items() if p["pinned"] and p["pairing_id"]}
    r = open_message(m, k["id"], k["enc"], b64d(k["id"])[:9], pins)
    if r["outcome"] != "accept" or r["type"] != "remove" or r["value"] != b:
        return
    p = d["peers"][r["from"]]
    w = window_accept({"h": p["h"], "seen": p["seen"]}, r["n"])
    p["h"], p["seen"] = w["h"], w["seen"]
    q = d["peers"].pop(b, None)
    d["pairs"].pop(b, None)
    if q:
        log("info", '"%s" was removed from your account.' % peer_label(q))


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
                log("warning", "Could not withdraw a device from the allow list: %s" % _why(e))
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
            extra = _ids(e.body.get("ids", [])) if isinstance(e.body.get("ids"), list) else []
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
        if out == "unreadable" and r["why"] == "type" and r["flag"] == 0:
            if r["ignorable"] and src != "returned":
                p = d["peers"][r["from"]]
                w = window_accept({"h": p["h"], "seen": p["seen"]}, r["n"])
                p["h"], p["seen"] = w["h"], w["seen"]
            elif not r["ignorable"] and src != "returned" and r["ruling"] != "approved":
                notes.append(("warning", UNREADABLE))
        elif out == "unreadable":
            if src != "returned":
                notes.append(("warning", UNREADABLE))
                fetch = r.get("why") == "unknown sender"
        elif out == "invalid" and r["n"] not in pins[r["from"]]["window"]["seen"]:
            notes.append(("warning", "Invalid message received"))
        elif out == "accept" and cx.mode != "listen" and r["type"] in ("url", "text", "tel"):
            cx.skipped = True  # content waits for listen
        elif out == "accept" and (src != "returned" or r["type"] == "approve"):
            p = d["peers"][r["from"]]
            w = window_accept({"h": p["h"], "seen": p["seen"]}, r["n"])
            p["h"], p["seen"] = w["h"], w["seen"]
            wipe, rec = act(cx, d, r, p, notes)
    for n in notes:
        log(*n)
    if fetch:
        cx.refresh_soon()
    if wipe == REMOVED:
        gone = removed_confirmed(cx)
        if gone is None:
            raise TempFail(UNREACHABLE, 0)  # keys kept; the message is already marked seen, so it is not acted on again
        if not gone:
            wipe = None  # the relay server still lists this device
    if wipe:
        cx.store.wipe()
        raise Fail(wipe, EXIT_LOGIN)
    if rec and cx.emit:
        try:
            cx.emit(rec)
        except Exception:  # not shown (a closed pipe): forget it was received, so the next listen shows it
            with cx.store.state() as d:
                p = d["peers"].get(r["from"])
                if p:
                    p["seen"] = [m for m in p["seen"] if m != r["n"]]
            raise


def removed_confirmed(cx):
    """One signed GET /v1/peers before the keys are deleted: True only when the relay server
    answers 401 unknown peer again; False when it answers 200 (this device is still listed);
    None for any other answer, or no answer. Only True deletes the keys."""
    try:
        cx.api.call("GET", "/v1/peers")
    except ApiError as e:
        return True if e.status == 401 and e.error == "unknown peer" else None
    except Fail:
        return None
    return False


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
            notes.append(("info", '"%s" confirmed this device.' % peer_label(p)))
        else:
            p["pending_approve_n"] = n
    elif t == "rename":
        if n > p["name_n"]:
            p["name"], p["name_n"] = v["name"], n
            notes.append(("info", '"%s" is now named "%s".' % (name, v["name"])))
    elif t == "remove":
        if v == cx.me:
            return REMOVED, None
        q = d["peers"].pop(v, None)
        d["pairs"].pop(v, None)
        if q:
            notes.append(("info", '"%s" was removed from your account.' % peer_label(q)))
    elif t == "delete":
        return "Your PushArmor account was deleted.", None
    elif t in ("logout", "login"):
        if n > p["logout_n"]:
            p["logged_out"], p["logout_n"] = t == "logout", n
        notes.append(("info", '"%s" %s.' % (name, "logged out" if t == "logout" else "logged in")))
    elif t == "deny":
        p["denies_me"], p["approves_me"] = True, False
        d["pairs"].pop(frm, None)
        notes.append(("info", '"%s" rejected this device.' % name))
    return None, None


def receive_pair(cx, pt):
    k = cx.keys
    o = open_pair(pt, k["id"], k["enc"], b64d(k["id"])[:9])
    if not o["ok"] or o["from"] == k["id"]:
        return log("warning", UNREADABLE)
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
            notes.append(("warning", UNREADABLE))
        elif want == "reply":
            send = on_reply(cx, e, p, o, notes)
        else:
            on_open(cx, d, e, p, o, notes)
    for n in notes:
        if n:
            log(*n)
    if send:
        r = post_pair(cx, frm, "open", send)
        if r not in ("sent", "429") and cx.mode == "pair" and frm == cx.target:
            raise Fail(pair_reason(r, peer_label(p)))  # its fingerprint would never show; pair again sends it
        if r not in ("sent", "429"):
            with cx.store.state(write=False) as d:
                sid = short_id(frm, d["peers"])
            log("warning", 'Unable to continue pairing with "%s". %s Run: `pusharmor pair %s` to try again.'
                % (peer_label(p), pair_reason(r, peer_label(p)), sid))


def pair_note(cx, d, x, text):
    """A pairing line for stderr, unless `pair` already runs for this device. While `pair` runs for another
    device, a request from this one shows once, as "also wants to pair"."""
    if cx.target == x:
        return None
    if cx.target and "wants to pair" in text:
        if x in cx.also:
            return None
        cx.also.add(x)
        text = '"%s" also wants to pair. Run: `pusharmor pair %s`'
    return ("info", text % (peer_label(d["peers"].get(x)), short_id(x, d["peers"])))


def on_commit(cx, frm, c_n, listed):
    k, notes, now, again = cx.keys, [], int(time.time()), None
    with cx.store.state() as d:
        p = d["peers"].get(frm) or {}
        while True:
            e = d["pairs"].get(frm)
            dec = pair_decide({
                "own_id": k["id"], "from_id": frm, "commit_c_N": c_n,
                "entry": e and {"role": e["role"], "state": e["state"], "c_N": b64d(e["c_N"]),
                                "reply_authorized": e["authorized"]},
                "pinned": p.get("pinned", False), "approved": p.get("ruling") == "approved",
                "approve_verified": p.get("approve_verified", False), "approves_me": p.get("approves_me", False),
                "get_after_verify": p.get("get_after_verify", False), "listed": listed,
                "open_entries": len(d["pairs"]), "cap": d["pair_auto"], "now": now})
            if dec["entry"] != "aborted":
                break
            d["pairs"].pop(frm, None)
            if p.get("pinned") and not p.get("approve_verified"):  # step 8: drop this pairing's pin
                ruling = p["ruling"]
                unpin(p)
                p["ruling"] = ruling
            notes.append(pair_note(cx, d, frm, 'Pairing with "%s" failed. Run: `pusharmor pair %s` to start again.'))
            # the old entry is gone: decide the new commit on its own
        if dec["entry"].startswith("created") or dec["entry"] == "n_wiped_x_replied":
            e = d["pairs"][frm] = new_entry("X", "prompted", secrets.token_bytes(32), c_n)
            if p.get("ruling") == "denied":  # a new request shows a rejected device again
                p["ruling"] = "none"
            e["authorized"] = dec["action"] == "reply"
            if dec["cap_counted"]:
                d["pair_auto"] = [t for t in d["pair_auto"] if 0 <= now - t < PAIR_CAP_WINDOW_S] + [now]
        notice = dec["notice"]
        if notice in ("commit", "represent"):
            notes.append(pair_note(cx, d, frm, '"%s" wants to pair. Run: `pusharmor pair %s`'))
        elif notice == "crossing":
            notes.append(pair_note(cx, d, frm, 'Pairing with "%s" is in progress. (%s)'))
            again = e["msg"]  # X may never have got this device's commit: send the stored one again
        elif notice == "half_state":
            notes.append(pair_note(cx, d, frm, '"%s" wants to pair again. Run: `pusharmor pair %s`'))
        else:
            notes.append(("warning", UNREADABLE))
    for n in notes:
        if n:
            log(*n)
    if again:
        post_pair(cx, frm, "commit", again)
    if dec["action"] == "reply":
        send_reply(cx, frm)


def on_reply(cx, e, p, o, notes):
    """N got X's reply: pin, fingerprint, and the open to send."""
    k = cx.keys
    r_n = b64d(e["r"])
    pid = pairing_id(r_n, o["r"])
    if e["state"] != "committed":
        if not (e["state"] == "shown" and p["pinned"] and p["pairing_id"] == b64e(pid)):
            notes.append(("warning", UNREADABLE))
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
            notes.append(("warning", UNREADABLE))
        return
    if e["state"] != "replied":
        return notes.append(("warning", UNREADABLE))
    if not open_matches_commit(o, b64d(e["c_N"])):
        d["pairs"].pop(frm, None)
        return notes.append(pair_note(cx, d, frm, 'Pairing with "%s" failed. Run: `pusharmor pair %s` to start again.'))
    r_x = b64d(e["r"])
    pin_peer(p, o["sign_pub"], o["enc_pub"], pairing_id(o["r"], r_x))
    e.update(state="shown", fingerprint=sas(o["sign_pub"], o["enc_pub"], k["sign_pub"], k["enc_pub"], o["r"], r_x),
             sign_pub=b64e(o["sign_pub"]), enc_pub=b64e(o["enc_pub"]))
    notes.append(pair_note(cx, d, frm, '"%s" wants to pair. Compare the fingerprint: pusharmor pair %s'))


def post_pair(cx, x, kind, c):
    """POST /v1/pair/X once -> result word (sent, denied, not listening, ...)."""
    try:
        j = cx.api.call("POST", "/v1/pair/" + x, {"k": kind, "c": c})
    except TempFail as e:
        return "network" if e.status == 0 else str(e.status)
    except ApiError as e:
        if e.status == 401:
            raise
        return ("%d %s" % (e.status, e.error)).strip()
    return j["r"] if isinstance(j.get("r"), str) else "failed"


def could_not(err, verb, name):
    """The Fail for a confirm or reject that the relay server did not take (a 401 goes on to log in again)."""
    if isinstance(err, ApiError):
        if err.status == 401:
            return err
        return Fail('Could not %s "%s". %s' % (verb, name, err.reason()))
    return Fail('Could not %s "%s". %s' % (verb, name, err), err.code)


def pair_reason(r, name):
    """A post_pair or post_approve result word -> reason; the word itself is never shown."""
    if r == "network":
        return UNREACHABLE
    m = re.fullmatch(r"([0-9]{3}) ?(.*)", r)
    if m:
        return SERVER_DOWN if int(m.group(1)) >= 500 else ApiError(int(m.group(1)), m.group(2), {}).reason()
    return device_reason(r, name)


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
    """Pairings older than 14 days (pair_timeout). A start time in the future counts as now."""
    now, dropped = int(time.time()), False
    with cx.store.state(write=False) as d:
        future = any(e["started"] > now for e in d["pairs"].values())
    if future:
        with cx.store.state() as d:
            for e in d["pairs"].values():
                if e["started"] > now:
                    e["started"] = now
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
            except (TempFail, ApiError, ValueError) as err:
                log("warning", "Could not resend the pairing approval: %s" % _why(err))
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
                log("info", 'Pairing with "%s" timed out. Run: `pusharmor pair %s` to start again.'
                    % (peer_label(p), short_id(x, d["peers"])))
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
    """listen and pair: subscribe first, report listening, re-send push when it is not confirmed."""
    with cx.store.state(write=False) as d:
        s = Stream(d["ntfy"], d["topic"], cx.keys, since, timeout)
        ok = d.get("push_ok")
    try:
        s.connect()
    except OSError:
        raise TempFail(PUSH_DOWN % urllib.parse.urlsplit(s.url).hostname, 0)
    report_listening(cx)
    if not ok or cx.api.push_missing:
        send_push(cx)
    return s


# ---- output ----

# C0 and C1 controls except tab and newline, line and paragraph separators, and bidi controls
CONTROL_CHARS = r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]"


def _clean(s):
    return re.sub(CONTROL_CHARS, "?", s)


def format_record(rec, fmt):
    if fmt == "json":
        return json.dumps({k: rec[k] for k in REC_KEYS}, ensure_ascii=True)
    if fmt == "tsv":
        esc = lambda s: re.sub(CONTROL_CHARS, lambda m: "\\u%04x" % ord(m.group()),  # noqa: E731
                               s.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n").replace("\r", "\\r"))
        return "\t".join(esc(rec[k]) for k in REC_KEYS)
    t = datetime.datetime.strptime(rec["date"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    body = _clean(rec["body"].replace("\r\n", "\n").replace("\r", "\n")).replace("\n", "\n ")
    return "From: %s %s\nPlatform: %s\nType: %s\nDate: %s\nBody: %s\n" % (
        rec["from"][:6], rec["name"], platform_label(rec["platform"]), rec["type"],
        email.utils.format_datetime(t.astimezone()), body)


def _relay_lines(pipe, out, failed):
    """Each line the notify program writes, as it comes, with "cmd: " in front. A failed write is kept
    for the caller, and the rest is read and dropped so the program never blocks on a full pipe."""
    for raw in iter(pipe.readline, b""):
        if failed:
            continue
        line = raw.decode("utf-8", "replace")
        line = line[:-1] if line.endswith("\n") else line
        try:
            print("cmd: " + (line[:-1] if line.endswith("\r") else line), file=out, flush=True)
        except (OSError, ValueError) as e:
            failed.append(e)
    pipe.close()


def run_exec(prog, rec):
    try:
        r = subprocess.Popen([prog] + [re.sub("[\x00\ud800-\udfff]", "\ufffd", rec[k])
                                       for k in ("from", "name", "platform", "type", "body")],
                             stdout=subprocess.PIPE if sys.stdout else subprocess.DEVNULL,
                             stderr=subprocess.PIPE if sys.stderr else subprocess.DEVNULL)
    except (OSError, ValueError) as e:
        why = (getattr(e, "strerror", None) or str(e)).rstrip(".")
        log("warning", 'The notify program "%s" could not be run: %s. Listening continues.' % (prog, why))
        return
    failed = []
    relays = [threading.Thread(target=_relay_lines, args=(pipe, out, failed), daemon=True)
              for pipe, out in ((r.stdout, sys.stdout), (r.stderr, sys.stderr)) if pipe]
    for t in relays:
        t.start()
    for t in relays:
        t.join()
    r.wait()
    if failed:
        raise failed[0]  # stdout or stderr is closed: as for any other write of this run
    if r.returncode:
        log("warning", 'The notify program "%s" exited with status %d. Listening continues.'
            % (prog, r.returncode))


# ---- command functions ----

def cmd_login(cx, args):
    if not stdin_tty():
        raise Fail("pusharmor login needs a terminal. Run it in a terminal window.", EXIT_USAGE)
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
    link = "%s/auth/cli#%s%s" % (SITE, purpose, b64e(sha256(cx.keys["sign_pub"])[:16]))
    print("Open this link in a browser and log in:\n\n  %s\n\nThen paste the code from the page here." % link)
    shown, tries, code = time.time(), 0, None
    while True:
        if code is None:
            try:
                raw = ask("Code: ")
            except EOFError:
                raise Fail("No code was entered. Run `pusharmor login` again.")
            code = re.sub(r"[\s\"'`]", "", raw)
            if not re.fullmatch(r"[A-Za-z0-9_-]{34}", code):
                code, tries = None, tries + 1
                if tries >= CODE_TRIES:
                    raise Fail("The code was not accepted after %d tries. Run `pusharmor login` to get a new code."
                               % CODE_TRIES)
                print("The code is not correct. Copy the whole code from the page and paste it again.")
                continue
        if time.time() - shown > LINK_LIFE_S:
            print("The code expired. Open the link to get a new code:\n\n  %s\n" % link)
            shown, code = time.time(), None
            continue
        try:
            (register if purpose == "r" else relogin)(cx, code)
            break
        except ApiError as e:
            if e.status == 401 and e.error == "unknown peer":
                raise
            if e.status == 401 and e.error == "ticket expired":
                print("The code expired. Open the link to get a new code:\n\n  %s\n" % link)
                shown, code = time.time(), None
                continue
            if e.status == 401 and e.error in ("bad ticket", "invalid ticket"):
                code, tries = None, tries + 1
                if tries >= CODE_TRIES:
                    raise Fail(BAD_LINK)
                print("The code is not correct. Check it and paste it again.")
                continue
            raise Fail(e.reason())
        except TempFail as e:
            if e.status == 429 or not ask_yes("%s Retry? [Y/n] " % e, default=True):
                raise Fail(str(e))
    with cx.store.state(write=False) as d:
        name = d["name"]
    print('Logged in. This device is named "%s". Next: run pusharmor pair to see your devices.' % name)
    return EXIT_OK


def register(cx, code):
    """POST /v1/peers with push, then the probe confirm. Nothing is written before it succeeds."""
    k = cx.keys
    if not getattr(cx, "topic", None):
        cx.topic = new_topic()
    ntfy = cx.settings.get("ntfy", DEFAULT_NTFY)
    d0 = {"ntfy": ntfy, "topic": cx.topic}
    stream = Stream(ntfy, cx.topic, k, str(int(time.time()) - 30), WAIT_TIMEOUT_S)  # since: a probe sent just before the connect is kept
    try:
        stream.connect()
    except OSError:
        raise TempFail(PUSH_DOWN % urllib.parse.urlsplit(ntfy).hostname, 0)
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
            j = cx.api.call("POST", "/v1/peers", body, with_id=False)
            break
        except ApiError as e:
            if e.status != 409 or e.error != "peer limit" or not isinstance(e.body.get("ticket"), str):
                raise
            body["evict"], body["ticket"] = choose_evict(e.body.get("peers")), e.body["ticket"]
    pid = j.get("id")
    if not isinstance(pid, str) or not b64ok(pid) or not peer_keys_ok(pid, b64d(pid)[:9], k["sign_pub"], k["enc_pub"]):
        raise Fail("The relay server sent a reply this device cannot use. Try again.")
    k["id"] = pid
    try:
        cx.store.save_keys(k)
        with cx.store.state(fresh=True) as d:
            d.clear()
            d.update(version=STATE_VERSION, name=default_name(), reg="registered", ntfy=ntfy, topic=cx.topic,
                     push_ok=False, since=str(int(time.time())), peers={}, pairs={}, my_allow=[], listed=[],
                     pair_auto=[])
            merge_peers(d, j, k)
    except BaseException:
        undo_register(cx)
        raise
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
    log("warning", "This device could not confirm that it can receive messages. Run `pusharmor listen` to try again.")


def undo_register(cx):
    """login could not save this device: remove it from the relay server again, so it takes no place there."""
    try:
        cx.api.call("DELETE", "/v1/peers/" + cx.me, {"m": {}})
    except (Fail, ApiError):
        log("warning", "This device could not be removed from your account again. To free its place, remove it "
            "on another device.")
    with contextlib.suppress(OSError):
        os.unlink(cx.store.key_path)


def choose_evict(peers):
    rows = [p for p in (peers if isinstance(peers, list) else [])
            if isinstance(p, dict) and isinstance(p.get("id"), str) and len(p["id"]) == 40 and b64ok(p["id"])]
    print("This account already has %d devices, the most it can have. To add this device, remove one or more."
          " A removed device must log in again and pair with every device again." % len(rows))
    for i, p in enumerate(rows, 1):
        added = time.strftime("%Y-%m-%d", gmtime(p["created"] if type(p.get("created")) is int else 0))
        print("  %d  %s  %s  added %s" % (i, id_hex(p["id"])[:6], platform_label(str(p.get("platform", ""))), added))
    try:
        a = ask("Numbers to remove (for example: 1 3), or Enter to stop: ")
    except EOFError:
        a = ""
    picks = sorted({int(w) for w in a.split() if re.fullmatch(r"[0-9]{1,2}", w) and 1 <= int(w) <= len(rows)})
    if not picks or len(picks) > 9:
        raise Fail("No devices were chosen to remove, so you are not logged in. Run `pusharmor login` to try again.")
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
    print("Logged out. Run `pusharmor login` to log in again.")
    retry_pending_logout(cx)
    with cx.store.state(write=False) as d:
        if d.get("logout_pending"):
            log("warning", "The relay server could not be reached yet. PushArmor will try again the next time it runs.")
    return EXIT_OK


def resolve_peer(cx, text, with_self=False):
    with cx.store.state(write=False) as d:
        ids = list(d["peers"]) + ([cx.me] if with_self else [])
    x = resolve_id(text, ids)
    if x is None:
        raise Fail('No device matches "%s". Run `pusharmor pair` to see your devices.' % text)
    return x


def peer_status(p, e):
    if p["pinned"] and p["ruling"] == "approved" and p["approves_me"]:
        return "paired" + (", logged out" if p["logged_out"] else ", not listening" if not p["listening"] else "")
    if e and e["state"] == "shown" and not e["approved"]:
        return "compare fingerprint " + e["fingerprint"]
    if p["pinned"] and p["ruling"] == "approved":
        return "waiting for it to confirm"
    if e:
        return "wants to pair" if e["role"] == "X" else "pairing"  # X: the other device started it
    return "not paired"


def resend_waiting(cx, skip=None):
    """Once per run: send the current pair message of each waiting pairing again (commit, open, or reply)."""
    if getattr(cx, "resent", False):
        return
    cx.resent = True
    with cx.store.state(write=False) as d:
        todo = []
        for x, e in d["pairs"].items():
            p = d["peers"].get(x)
            if x == skip or not p or not e["msg"]:
                continue
            kind = None
            if e["role"] == "N" and e["state"] == "committed":
                kind = "commit"
            elif e["role"] == "N" and e["state"] == "shown" and not p["approve_verified"]:
                kind = "open"
            elif e["role"] == "X" and e["state"] == "replied" and e["authorized"]:
                kind = "reply"
            if kind:
                todo.append((x, kind, e["msg"]))
    for x, kind, msg in todo:
        post_pair(cx, x, kind, msg)


def drain_cache(cx):
    """One read of the ntfy cache: the pairing messages the relay server sent while nothing listened."""
    with cx.store.state(write=False) as d:
        drain = Stream(d["ntfy"], d["topic"], cx.keys, d.get("since", ""), WAIT_TIMEOUT_S, poll=True)
    while True:
        pt = drain.next(time.time() + WAIT_TIMEOUT_S)
        if pt is None:
            return drain
        pair_receive(cx, pt, drain)


def pair_list(cx):
    cx.refresh()
    resend_waiting(cx)
    drain_cache(cx)
    with cx.store.state(write=False) as d:
        ids = list(d["peers"]) + [cx.me]
        rows = [("ID", "NAME", "DEVICE", "STATUS"), (short_id(cx.me, ids), d["name"], "Command line", "this device")]
        for pid, p in sorted(d["peers"].items(), key=lambda kv: kv[1]["created"]):
            if p["ruling"] == "denied" and pid not in d["pairs"]:
                continue  # rejected: hidden until it asks again or pair ID is run
            rows.append((short_id(pid, ids), peer_label(p), platform_label(p["platform"]),
                         peer_status(p, d["pairs"].get(pid))))
    w = [max(len(r[i]) for r in rows) for i in range(3)]
    for r in rows:
        print("  ".join(c.ljust(w[i]) for i, c in enumerate(r[:3])) + "  " + r[3])
    if len(rows) > 2:
        print("\nTo pair with a device: pusharmor pair ID")
    return EXIT_OK


def cmd_devices(cx, args):
    cx.need()
    return pair_list(cx)


def cmd_pair(cx, args):
    cx.need()
    if not args.id:
        return pair_list(cx)
    if not stdin_tty():
        raise Fail("pusharmor pair needs a terminal to compare the pairing fingerprint. Run it in a terminal window.",
                   EXIT_USAGE)
    cx.mode = "pair"
    cx.refresh()
    x = cx.target = resolve_peer(cx, args.id, with_self=True)
    if x == cx.me:
        raise Fail("This is the device you are using. Choose another device.")
    resend_waiting(cx, x)
    with cx.store.state() as d:
        if d["peers"][x]["ruling"] == "denied":
            d["peers"][x]["ruling"] = "none"
    stream = start_receive(cx, drain_cache(cx).since, WAIT_TIMEOUT_S)
    sweep(cx)
    deadline, told, first = None, None, True
    while True:
        with cx.store.state(write=False) as d:
            p, e = d["peers"].get(x), d["pairs"].get(x)
            sid = short_id(x, d["peers"])
        name = peer_label(p)
        if p is None:
            raise Fail('"%s" is no longer on this account.' % name)
        if p["pinned"] and p["ruling"] == "approved" and p["approves_me"]:
            print('Paired with "%s".' % name)
            return EXIT_OK
        r, wait = "sent", 'Waiting for "%s". Open PushArmor on it to continue pairing. Press Ctrl+C to stop.' % name
        if e and e["state"] == "shown" and not e["approved"]:
            if first and e["role"] == "N":
                r = post_pair(cx, x, "open", e["msg"])
                if r not in ("sent", "429"):
                    raise Fail(pair_reason(r, name))
            first = False
            print("\nCompare Pairing Fingerprint: %s\n" % e["fingerprint"])
            try:
                yes = ask_yes('Check that "%s" shows the same fingerprint. Confirmed (y) or Reject (n)? [y/N] ' % name,
                              strict=True)
            except EOFError:
                print()  # Ctrl-D leaves the cursor after the prompt
                raise Fail("No answer was given. Run `pusharmor pair %s` again." % sid)
            if not yes:
                try:
                    deny(cx, x)
                except (ApiError, TempFail) as err:
                    raise could_not(err, "reject", name)
                print('Did not pair with "%s".' % name)
                return EXIT_OK
            try:
                r = approve(cx, x)
            except (ApiError, TempFail) as err:
                raise could_not(err, "confirm", name)
            if r not in ("sent", "stored"):
                raise Fail('Could not confirm "%s". %s' % (name, pair_reason(r, name)))
            continue
        if p["pinned"] and p["ruling"] == "approved":
            wait = 'Waiting for "%s" to confirm this device. Press Ctrl+C to stop.' % name
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
            raise Fail(pair_reason(r, name))
        if wait != told:
            log("info", wait)
            told, deadline = wait, time.time() + PAIR_WAIT_S  # each wait ends after PAIR_WAIT_S
        pt = stream.next(deadline)
        if pt is None:
            raise Fail('Pairing with "%s" timed out. Run: `pusharmor pair %s` to try again.' % (name, sid))
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
        sys.stdout.reconfigure(line_buffering=True, errors="replace")  # "?" for what the terminal cannot show

    def emit(rec):
        if args.exec:
            return run_exec(args.exec, rec)
        print(format_record(rec, fmt), flush=True)

    cx.emit = emit
    if args.exec and not (os.path.isfile(args.exec) and os.access(args.exec, os.X_OK) if "/" in args.exec
                          else shutil.which(args.exec)):
        raise Fail('The notify program "%s" was not found or cannot be run.' % args.exec, EXIT_USAGE)
    with cx.store.state(write=False) as d:
        since = d.get("since", "")
    stream = start_receive(cx, since, LISTEN_TIMEOUT_S)
    cx.refresh()
    sweep(cx)
    log("info", "Listening. Press Ctrl+C to stop.")
    while True:
        with cx.store.state(write=False) as d:
            due = d.get("listen_at", 0) + LISTEN_REPORT_S
        pt = stream.next(due)
        if pt is None:
            try:
                report_listening(cx)
            except TempFail as e:
                log("warning", "%s Listening continues." % e)
                with cx.store.state() as d:
                    d["listen_at"] = int(time.time()) - LISTEN_REPORT_S + 3600
            continue
        try:
            receive(cx, pt)
        except TempFail as e:
            log("warning", "%s Listening continues." % e)
        except ApiError as e:
            if e.status == 401:
                raise
            log("warning", "%s Listening continues." % e.reason())
        with cx.store.state() as d:
            d["since"] = stream.since


def cmd_send(cx, args):
    cx.need()
    if args.message and args.message != ["-"]:
        text = " ".join(args.message)
    elif args.message == ["-"] or not stdin_tty():
        data = sys.stdin.buffer.read(CONTENT_CAP * 4 + 1) if sys.stdin else b""
        if len(data) > CONTENT_CAP * 4:
            raise Fail(TOO_LONG, EXIT_USAGE)
        try:
            text = data.decode("utf-8").rstrip("\r\n")
        except UnicodeDecodeError:
            raise Fail("The input is not text that PushArmor can send. Check what you pipe in.")
    else:
        raise Fail("There is no message to send. Give a message, or pipe text into pusharmor send.", EXIT_USAGE)
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        raise Fail("The message is not text that PushArmor can send.")
    if not text.strip():
        raise Fail("The message is empty.", EXIT_USAGE)
    type_, value = ("text", text) if args.text else detect(text)
    size = len(value.encode("utf-8"))
    if size > CONTENT_CAP:
        raise Fail(TOO_LONG, EXIT_USAGE)
    cx.refresh()
    with cx.store.state() as d:
        ready = [pid for pid, p in d["peers"].items() if sendable(p)]
        targets = ready
        if args.to:
            targets = []
            for t in args.to:
                pid = resolve_id(t, list(d["peers"]))
                if pid is None:
                    raise Fail('No device matches "%s". Run `pusharmor pair` to see your devices.' % t)
                if pid not in ready:
                    p = d["peers"][pid]
                    why = ("unknown" if p["missing"] else "unapproved" if not (
                        p["pinned"] and p["ruling"] == "approved" and p["approves_me"])
                        else "logged out" if p["logged_out"] else "not listening")
                    raise Fail(SEND_WHY[why] % peer_label(p), EXIT_SEND)
                targets.append(pid)
        if not targets:
            raise Fail("No device is paired yet. Run `pusharmor pair` to pair one.", EXIT_SEND)
        m, names = {}, {}
        for pid in dict.fromkeys(targets):
            p = d["peers"][pid]
            names[pid] = peer_label(p)
            m[pid] = seal_msg(cx.keys, pid, p, reserve(p), type_, value)
    j = cx.api.call("POST", "/v1/send", {"v": 1, "m": m})
    res = j.get("r") if isinstance(j.get("r"), dict) else {}
    failed = [pid for pid in m if res.get(pid) != "sent"]
    with cx.store.state() as d:
        for pid in failed:
            r = res.get(pid) if isinstance(res.get(pid), str) else "failed"
            log("error", device_reason(r, names[pid]))
            p = d["peers"].get(pid)
            if p and r == "logged out":
                p["logged_out"] = True
            if p and r == "not listening":
                p["listening"] = False
    print("Sent to %d of %d device%s." % (len(m) - len(failed), len(m), "" if len(m) == 1 else "s"))
    return EXIT_SEND if failed else EXIT_OK


# /v1/send, /v1/pair, and /v1/approve result word -> reason for one device (%s: its name).
SEND_WHY = {"gone": '"%s" needs attention. Open PushArmor on it to resolve.',
            "logged out": '"%s" is logged out. Log in on it to receive messages.',
            "not listening": '"%s" has not listened recently. Run `pusharmor listen` on it.',
            "unapproved": '"%s" is not paired with this device. Pair with it to send it messages.',
            "denied": '"%s" is not paired with this device.', "unknown": '"%s" is no longer on this account.'}
SEND_FAILED = 'The push service of "%s" did not accept the message. Try again later.'  # failed:CODE
SEND_NOT_READY = '"%s" has not finished turning on notifications. Open PushArmor on it.'  # failed, any other word


def device_reason(r, name):
    if r in SEND_WHY:
        return SEND_WHY[r] % name
    return (SEND_FAILED if r.startswith("failed:") else SEND_NOT_READY) % name


def cmd_rename(cx, args):
    if not NAME_RE.fullmatch(args.name):
        raise Fail("The name must be 1 to 32 plain ASCII characters, with no double quote.", EXIT_USAGE)
    cx.need()
    with cx.store.state(write=False) as d:
        if d.get("name") == args.name:
            print('This device is already named "%s".' % args.name)
            return EXIT_OK
    k = cx.keys

    def content(pid, p, n, names):
        e = make_name_entry(k["sign"], k["id"], pid, b64d(p["pairing_id"]), n, args.name)
        names[pid] = seal_name_entry(pid, b64d(p["enc_pub"]), e)
        return "rename", e

    allow_list_call(cx, "PATCH", "/v1/peers/" + cx.me, lambda m, names: {"name": names, "m": m}, content)
    with cx.store.state() as d:
        d["name"] = args.name
    print('This device is now named "%s".' % args.name)
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
        q = ('Remove "%s" from your account? "%s" must log in again and pair with every device again. [y/N] '
             % (name, name))
    if not args.yes:
        if not stdin_tty():
            raise Fail("Removing needs your answer in a terminal. Add --yes to remove without asking.", EXIT_USAGE)
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
    print('Removed "%s".' % name)
    return EXIT_OK


# The one command table: name -> (function, help, arguments). Names are frozen.
COMMANDS = {
    "login": (cmd_login, "Log in this device to your PushArmor account.", []),
    "logout": (cmd_logout, "Log out this device. Keys and paired devices stay on it.", []),
    "pair": (cmd_pair, "List your devices, or pair with one (compare the fingerprint, then confirm or reject).",
             [(("id",), {"nargs": "?", "metavar": "ID", "help": "device ID from the list (6 or more hex characters)"})]),
    "devices": (cmd_devices, "List your devices and their pairing status.", []),
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


class Parser(argparse.ArgumentParser):
    """A usage error is one "error: " line on stderr and exit code 2, like every other error."""

    def error(self, message):
        log("error", message)
        sys.exit(EXIT_USAGE)


def build_parser():
    p = Parser(prog="pusharmor", description="PushArmor: send links and text to your own "
                                "devices, end-to-end encrypted. See https://pusharmor.com",
                                epilog="exit codes:\n" + "\n".join("  %-3d %s" % c for c in EXIT_CODES),
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--config", metavar="DIR", help="config dir (default: %%PUSHARMOR_CONFIG%%, else "
                   "%%APPDATA%%\\PushArmor)" if windows() else "config dir (default: $PUSHARMOR_CONFIG, else "
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


def _quiet_stdout():
    """After a failed write to stdout: point it at /dev/null so the flush at exit cannot fail again.
    True when stdout was the part that failed."""
    try:
        sys.stdout.flush()
    except (OSError, ValueError, AttributeError):
        with contextlib.suppress(OSError, ValueError, AttributeError):
            os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return True
    return False


def _os_error_text(e):
    path = e.filename2 or e.filename
    reason = e.strerror or str(e) or type(e).__name__
    if path:
        return "Cannot read or write %s: %s." % (quoted_path(str(path)), reason)
    return "Cannot read or write a file on this device: %s." % reason


def main(argv=None):
    """Runs one command. Every error ends on stderr as one line, and an exit code from EXIT_CODES."""
    try:
        try:
            return _main(argv)
        finally:
            if sys.stdout is not None:
                sys.stdout.flush()  # a closed or full stdout fails here, not at exit
    except BrokenPipeError:  # the output was closed, for example listen | head -1
        _quiet_stdout()
        return EXIT_ERR
    except OSError as e:
        if _quiet_stdout() and windows() and e.errno == errno.EINVAL:  # a closed pipe on Windows
            return EXIT_ERR
        log("error", STORAGE_FULL if e.errno == errno.ENOSPC else _os_error_text(e))
        return EXIT_ERR
    except UnicodeError as e:
        _quiet_stdout()
        if isinstance(e, UnicodeEncodeError):
            log("error", "This terminal cannot show some characters. Set LANG=C.UTF-8 and try again.")
        else:
            log("error", "Some text could not be read as text. Try again.")
        return EXIT_ERR
    except Exception as e:
        _quiet_stdout()
        log("error", "PushArmor stopped on an unexpected error (%s)."
            % " ".join(("%s: %s" % (type(e).__name__, e)).split()))
        return EXIT_BUG


def _main(argv):
    if windows():  # the same UTF-8 bytes and line ends as on Linux and macOS, also into a pipe or file
        for f in (sys.stdout, sys.stderr):
            with contextlib.suppress(AttributeError, ValueError):
                f.reconfigure(encoding="utf-8", newline="\n")
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "_check", lambda a: True)(args):
        parser.error("Use only one of --json, --tsv, and --exec.")
    cx = Ctx(config_dir(args.config))
    if args.config and os.path.exists(cx.store.root) and not os.path.isdir(cx.store.root):
        log("error", "The --config path %s is a file, not a folder." % quoted_path(cx.store.root))
        return EXIT_USAGE
    if args.config and args.command not in ("login", "logout") and not os.path.isdir(cx.store.root):
        log("error", "This device is not logged in. The --config folder %s does not exist."
            % quoted_path(cx.store.root))
        return EXIT_LOGIN
    try:
        if args.command not in ("login", "logout"):
            retry_pending_logout(cx)
        return COMMANDS[args.command][0](cx, args)
    except KeyboardInterrupt:
        log("info", "Stopped.")
        return 130
    except Fail as e:
        log("error", str(e))
        return e.code
    except ApiError as e:
        if e.status == 401 and e.error == "unknown peer":
            gone = removed_confirmed(cx)
            if not gone:
                log("error", UNREACHABLE if gone is None
                    else "The relay server did not confirm this device yet. Try again.")
                return EXIT_TEMP
            cx.store.wipe()
            log("error", REMOVED)
            return EXIT_LOGIN
        if e.status == 401 and e.error == "logged out":
            with contextlib.suppress(Fail, OSError), cx.store.state() as d:
                d["reg"] = "logged_out"
            log("error", LOGGED_OUT)
            return EXIT_LOGIN
        log("error", e.reason())
        return EXIT_ERR


if __name__ == "__main__":
    sys.exit(main())

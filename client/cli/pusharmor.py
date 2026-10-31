"""PushArmor command-line client.

The top part is the core layer: encodings, keys, signed requests, HPKE,
inner messages, name entries, pairing, replay window, RFC 8291 push decrypt
and send-type detection. Pure functions only: no network, no files.
"""

import hashlib
import hmac
import ipaddress
import json
import re
import sys
import unicodedata
import zlib

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

VERSION = "0.0.19"

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

def main():
    print("The PushArmor command-line client is coming soon. See https://pusharmor.com")
    return 1


if __name__ == "__main__":
    sys.exit(main())

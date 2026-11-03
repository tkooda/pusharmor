"""Relay server side and test vector functions the command-line client itself never calls."""

import re

import pusharmor as pa


def peer_id(id_secret, account, kh):
    """Server-side construction; the client only parses and checks ids."""
    return account + kh + pa._hmac(id_secret, account, kh)[:9]


def verify_request(pub, method, path, pa_time, body, sig):
    if not re.fullmatch(r"[1-9][0-9]{12}", pa_time):
        return False
    return pa.verify(pub, pa.request_bytes(method, path, pa_time, body), sig)


def hpke_derive_key_pair(ikm):
    prk = pa._lextract(pa._KEM_SUITE, b"", b"dkp_prk", ikm)
    for counter in range(256):
        sk = pa._lexpand(pa._KEM_SUITE, prk, b"candidate", bytes([counter]), 32)
        if 0 < int.from_bytes(sk, "big") < pa._N:
            return sk, pa.pub_from_priv(sk)
    raise ValueError("hpke: DeriveKeyPairError")


def truncate_utf8(s, cap=pa.CONTENT_CAP):
    """The first cap UTF-8 bytes of s, cut on a code point boundary."""
    return s.encode("utf-8")[:cap].decode("utf-8", "ignore")

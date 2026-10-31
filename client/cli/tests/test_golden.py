"""Golden cross-platform vectors (tests/vectors/golden-v1.json) through the core layer."""

import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pusharmor as pa  # noqa: E402

with open(os.path.join(HERE, "..", "..", "..", "tests", "vectors", "golden-v1.json"), "rb") as f:
    G = json.load(f)

b64d, b64e = pa.b64d, pa.b64e


def peer(name):
    p = G["keys"]["peers"][name]
    return {k: (v if k in ("id", "email") else b64d(v)) for k, v in p.items()}


def pins_of(pin):
    if not pin:
        return {}
    return {pin["id"]: {"sign_pub": b64d(pin["sign_pub"]), "enc_pub": b64d(pin["enc_pub"]),
                        "pairing_id": b64d(pin["pairing_id"]), "ruling": pin["ruling"]}}


def receive(c):
    r = peer(c["receiver"])
    pins = pins_of(c.get("pin"))
    for p in pins.values():
        p["window"] = c["window"]
        p["history"] = c["history"]
    return pa.open_message(c["message"], r["id"], r["enc_priv"], r["account"], pins)


def test_b64url():
    for c in G["b64url"]["cases"]:
        if c["ok"]:
            assert b64d(c["input"]).hex() == c["hex"], c
            assert b64e(bytes.fromhex(c["hex"])) == c["input"], c
        else:
            with pytest.raises(ValueError):
                b64d(c["input"])


def test_keys():
    secret = b64d(G["keys"]["id_secret"])
    for name in G["keys"]["peers"]:
        p = peer(name)
        assert pa.pub_from_priv(p["sign_priv"]) == p["sign_pub"]
        assert pa.pub_from_priv(p["enc_priv"]) == p["enc_pub"]
        kh = pa.keyhash(p["sign_pub"], p["enc_pub"])
        assert kh == p["keyhash"]
        assert b64e(pa.peer_id(secret, p["account"], kh)) == p["id"]
        assert pa.id_matches(b64d(p["id"]), p["account"], p["sign_pub"], p["enc_pub"])
        assert pa.peer_keys_ok(p["id"], p["account"], p["sign_pub"], p["enc_pub"]) == (p["sign_pub"] != p["enc_pub"])
        ids = [peer(n)["id"] for n in G["keys"]["peers"]]
        assert pa.resolve_id(pa.id_hex(p["id"])[:6].upper(), ids) == p["id"]
        assert pa.resolve_id(p["id"], ids) == p["id"]
    assert pa.resolve_id("12345", []) is None


def test_new_key_sign_verify():
    priv, pub = pa.new_key()
    assert pa.pub_from_priv(priv) == pub and pa.is_valid_pub(pub)
    sig = pa.sign(priv, b"x")
    assert len(sig) == 64 and pa.verify(pub, b"x", sig) and not pa.verify(pub, b"y", sig)


def test_id_order():
    for c in G["id_order"]["cases"]:
        assert ("a" if pa.compare_ids(c["a"], c["b"]) < 0 else "b") == c["lower"], c["name"]


def test_request_sig():
    for c in G["request_sig"]["cases"]:
        body = b64d(c["body"])
        assert b64e(pa.request_bytes(c["method"], c["path"], c["pa_time"], body)) == c["signed_bytes"], c["name"]
        assert body.decode() == c["body_text"]
        assert pa.verify_request(b64d(c["sign_pub"]), c["method"], c["path"], c["pa_time"], body, b64d(c["sig"]))
    x = peer("X")
    sig = pa.sign_request(x["sign_priv"], "POST", "/v1/send", "1761300000123", b"{}")
    assert pa.verify_request(x["sign_pub"], "POST", "/v1/send", "1761300000123", b"{}", b64d(sig))


def test_rfc9180():
    v = G["rfc9180"]
    h = bytes.fromhex
    assert [v["mode"], v["kem_id"], v["kdf_id"], v["aead_id"]] == [0, 16, 1, 2]
    sk_r, pk_r = pa.hpke_derive_key_pair(h(v["ikmR"]))
    assert (sk_r.hex(), pk_r.hex()) == (v["skRm"], v["pkRm"])
    sk_e, pk_e = pa.hpke_derive_key_pair(h(v["ikmE"]))
    assert (sk_e.hex(), pk_e.hex()) == (v["skEm"], v["enc"])
    ks = pa.hpke_schedule(pa.ecdh(sk_e, pk_r), pk_e, pk_r, h(v["info"]))
    for k in ("shared_secret", "key_schedule_context", "secret", "key", "base_nonce", "exporter_secret"):
        assert ks[k].hex() == v[k], k
    e = v["encryptions"][0]
    wire = pa.hpke_seal(pk_r, h(v["info"]), h(e["aad"]), h(e["pt"]), sk_e=sk_e)
    assert wire == h(v["enc"]) + h(e["ct"])
    assert pa.hpke_open(sk_r, h(v["info"]), h(e["aad"]), wire).hex() == e["pt"]
    rnd = pa.hpke_seal(pk_r, b"PA-MSG1", b"aad", b"hello")
    assert pa.hpke_open(sk_r, b"PA-MSG1", b"aad", rnd) == b"hello"
    with pytest.raises(Exception):
        pa.hpke_open(sk_r, b"PA-MSG1", b"other", rnd)


def test_rfc8291():
    v = G["rfc8291"]
    d = pa.webpush_derive(pa.ecdh(b64d(v["ua_private"]), b64d(v["as_public"])), b64d(v["auth_secret"]),
                          b64d(v["ua_public"]), b64d(v["as_public"]), b64d(v["salt"]))
    assert b64e(pa.ecdh(b64d(v["ua_private"]), b64d(v["as_public"]))) == v["ecdh_secret"]
    for k in ("prk_key", "key_info", "ikm", "prk", "cek", "nonce"):
        assert b64e(d[k]) == v[k], k
    assert b64e(pa.webpush_decrypt(b64d(v["body"]), b64d(v["ua_private"]), b64d(v["auth_secret"]))) == v["plaintext"]


def check_full_message(c):
    r, frm = peer(c["receiver"]), peer(c["from"])
    pt = pa.hpke_open(r["enc_priv"], b"PA-MSG1", r["id"].encode(), b64d(c["message"]))
    assert b64e(pt) == c["plaintext"]
    assert b64e(pa.msg_signed_bytes(r["id"], pt[64:])) == c["signed_bytes"]
    assert b64e(pt[:64]) == c["sig"]
    assert pa.verify(frm["sign_pub"], b64d(c["signed_bytes"]), b64d(c["sig"]))
    assert pa.inflate_capped(b64d(c["deflated"])).decode() == c["json"]
    assert len(c["message"]) in pa.BUCKETS
    got = receive(c)
    assert {k: got.get(k) for k in ("outcome", "type", "n", "value")} == c["expect"], c["name"]
    assert got["from"] == frm["id"]


def seal_round_trip(c):
    """Build the same message with a random HPKE key and the expected value, then open it."""
    r, frm = peer(c["receiver"]), peer(c["from"])
    e = c["expect"]
    pid = b64d(c["pin"]["pairing_id"])
    value = e["value"]
    if e["type"] in ("approve", "rename"):
        value = pa.make_name_entry(frm["sign_priv"], frm["id"], r["id"], pid, e["n"], value["name"])
    keys = (frm["sign_pub"], frm["enc_pub"]) if e["type"] == "approve" else None
    text = pa.msg_json(e["n"], e["type"], value)
    assert json.loads(text) == json.loads(c["json"]) or e["type"] in ("approve", "rename")
    msg = pa.build_message(frm["sign_priv"], frm["id"], r["id"], r["enc_pub"], pid, text, keys)
    assert len(msg) == len(c["message"])
    got = receive(dict(c, message=msg))
    assert {k: got.get(k) for k in ("outcome", "type", "n", "value")} == e


def test_messages():
    cases = G["messages"]["cases"]
    assert sorted(c["type"] for c in cases) == sorted(pa.TYPES)
    for c in cases:
        check_full_message(c)
        assert len(c["message"]) == c["wire_chars"]
        seal_round_trip(c)


def test_padded_messages():
    for c in G["padded_messages"]["cases"]:
        check_full_message(c)
        assert len(c["message"]) == c["bucket"]
        assert pa.bucket_for(pa.wire_chars(64 + c["unpadded_body_len"] + 81)) == c["bucket"]
        seal_round_trip(c)


def test_padding():
    for c in G["padding"]["cases"]:
        chars = pa.wire_chars(c["plaintext_len"] + 81)
        assert chars == c["unpadded_chars"]
        b = pa.bucket_for(chars)
        assert b == c["bucket"]
        assert (None if b is None else pa.plaintext_len_for(b)) == c["padded_plaintext_len"]
    assert pa.bucket_for(10, approve=True) == 1024


def test_content_cap():
    for c in G["content_cap"]["cases"]:
        n = len(c["input"].encode())
        assert n == c["utf8_bytes"] and (n <= pa.CONTENT_CAP) == c["ok"]
        assert pa.truncate_utf8(c["input"]) == c["truncated"]


def test_inflate():
    for c in G["inflate"]["cases"]:
        out = pa.inflate_capped(b64d(c["deflated"]))
        assert (out is not None) == c["ok"], c["name"]
        if out is not None:
            assert len(out) == c["inflated_len"]
            assert b64e(pa.sha256(out)) == c["inflated_sha256"]
            if c["inflated"] is not None:
                assert b64e(out) == c["inflated"]


def test_replay_window():
    for c in G["replay_window"]["cases"]:
        o = pa.replay_outcome(c["state"], c["n"], c["type"], c["history_row"])
        assert o == c["outcome"], c["name"]
        assert (pa.window_accept(c["state"], c["n"]) if o == "accept" else c["state"]) == c["state_after"], c["name"]


def test_name_entries():
    for c in G["name_entries"]["cases"]:
        owner, rec = peer(c["owner"]), peer(c["recipient"])
        signed = pa.name_signed_bytes(owner["id"], rec["id"], c["pairing_id"], c["n"], c["name_b64"])
        assert signed.decode() == c["signed_string"]
        assert b64d(c["name_b64"]).decode() == c["name_text"]
        assert pa.verify(owner["sign_pub"], signed, b64d(c["s"]))
        assert len(c["ciphertext"]) <= 1024
        pt = pa.hpke_open(rec["enc_priv"], b"PA-NAME1", rec["id"].encode(), b64d(c["ciphertext"]))
        assert pt.decode() == c["entry_json"]
        pin = {"sign_pub": owner["sign_pub"], "pairing_id": b64d(c["pairing_id"])}
        want = {"ok": True, "name": c["name_text"], "n": c["n"]}
        assert pa.open_name_entry(c["ciphertext"], rec["id"], rec["enc_priv"], owner["id"], pin) == want
        entry = pa.make_name_entry(owner["sign_priv"], owner["id"], rec["id"], pin["pairing_id"], c["n"], c["name_text"])
        sealed = pa.seal_name_entry(rec["id"], rec["enc_pub"], entry)
        assert len(sealed) <= 1024
        assert pa.open_name_entry(sealed, rec["id"], rec["enc_priv"], owner["id"], pin) == want


def test_pairing():
    P = G["pairing"]
    n, x = peer(P["N"]), peer(P["X"])
    r_n, r_x = b64d(P["r_N"]), b64d(P["r_X"])
    assert b64e(pa.commit_hash(n["sign_pub"], n["enc_pub"], r_n)) == P["c_N"]
    fph = pa.fingerprint_hash(n["sign_pub"], n["enc_pub"], x["sign_pub"], x["enc_pub"], r_n, r_x)
    assert b64e(fph) == P["fingerprint_hash"]
    assert pa.sas(n["sign_pub"], n["enc_pub"], x["sign_pub"], x["enc_pub"], r_n, r_x) == P["fingerprint"]
    assert b64e(pa.pairing_id(r_n, r_x)) == P["pairing_id"]
    for c in P["fingerprint_cases"]:
        assert pa.crockford20(b64d(c["hash"])) == c["fingerprint"]
    bodies = {"commit": pa.commit_body(b64d(P["c_N"])),
              "reply": pa.keys_body(x["sign_pub"], x["enc_pub"], r_x),
              "open": pa.keys_body(n["sign_pub"], n["enc_pub"], r_n)}
    for m in P["pair_messages"]:
        to, frm = peer(m["to"]), peer(m["from"])
        assert len(m["message"]) == pa.PAIR_WIRE_LEN
        pt = pa.hpke_open(to["enc_priv"], b"PA-PAIR1", to["id"].encode(), b64d(m["message"]))
        assert b64e(pt) == m["plaintext"]
        assert pt == bytes([pa.PAIR_KINDS[m["kind"]]]) + b64d(frm["id"]) + bodies[m["kind"]]
        for msg in (m["message"], pa.seal_pair(m["kind"], frm["id"], bodies[m["kind"]], to["id"], to["enc_pub"])):
            r = pa.open_pair(msg, to["id"], to["enc_priv"], to["account"])
            assert r["ok"] and r["kind"] == m["kind"] and r["from"] == frm["id"]
            if m["kind"] == "commit":
                assert b64e(r["c_N"]) == P["c_N"]
            if m["kind"] == "reply":
                assert b64e(r["r"]) == P["r_X"]
            if m["kind"] == "open":
                assert pa.open_matches_commit(r, b64d(P["c_N"]))


def test_pair_decide_and_timeout():
    for c in G["pair_decide"]["cases"]:
        assert pa.pair_decide(c["input"]) == c["output"], c["name"]
    for c in G["pair_timeout"]["cases"]:
        assert pa.pair_timeout(c["input"]) == c["output"], c["name"]


def test_url_parse():
    for c in G["url_parse"]["cases"]:
        want = {k: v for k, v in c.items() if k != "input"}
        assert pa.parse_url(c["input"]) == want, c["input"]


def test_phone():
    for c in G["phone"]["cases"]:
        assert pa.is_phone(c["input"]) == c["phone"], c["input"]


def test_detect():
    assert pa.detect("tel:+15551234567") == ("tel", "tel:+15551234567")
    assert pa.detect(" HTTPS://Example.COM/a b ") == ("url", "https://example.com/a%20b")
    assert pa.detect("+1 555-123-4567") == ("tel", "+1 555-123-4567")
    assert pa.detect("https://example.com/5551234567") == ("url", "https://example.com/5551234567")
    assert pa.detect("hello https://example.com") == ("text", "hello https://example.com")
    assert pa.detect("2026-10-24") == ("text", "2026-10-24")


def test_must_decode():
    for c in G["must_decode"]["messages"]:
        got = receive(c)
        assert {k: got.get(k) for k in ("outcome", "type", "n", "value")} == c["expect"], c["name"]
    for c in G["must_decode"]["name_entries"]:
        r, owner = peer(c["receiver"]), peer(c["owner"])
        pin = pins_of(c["pin"])[owner["id"]]
        assert pa.open_name_entry(c["ciphertext"], r["id"], r["enc_priv"], owner["id"], pin) == c["expect"], c["name"]


def must_fail_outcome(c):
    kind = c["kind"]
    if kind == "message":
        return receive(c)["outcome"]
    if kind == "request":
        ok = pa.verify_request(b64d(c["sign_pub"]), c["method"], c["path"], c["pa_time"], b64d(c["body"]),
                               b64d(c["sig"]))
        return "accept" if ok else "unreadable"
    r = peer(c["receiver"])
    if kind == "pair":
        p = pa.open_pair(c["message"], r["id"], r["enc_priv"], r["account"])
        if not p["ok"] or p["kind"] != c["expected_kind"]:
            return "unreadable"
        if p["kind"] == "open" and not pa.open_matches_commit(p, b64d(c["stored_c_N"])):
            return "unreadable"
        return "accept"
    if kind == "name_entry":
        owner = peer(c["owner"])
        pin = pins_of(c["pin"])[owner["id"]]
        ok = pa.open_name_entry(c["ciphertext"], r["id"], r["enc_priv"], owner["id"], pin)["ok"]
        return "accept" if ok else "unreadable"
    if kind == "peer_entry":
        ok = pa.peer_keys_ok(c["id"], r["account"], b64d(c["sign_pub"]), b64d(c["enc_pub"]))
        return "accept" if ok else "unreadable"
    raise AssertionError("unknown kind " + kind)


@pytest.mark.parametrize("c", G["must_fail"]["cases"], ids=lambda c: c["name"])
def test_must_fail(c):
    assert c["outcome"] in ("invalid", "unreadable")
    assert must_fail_outcome(c) == c["outcome"]

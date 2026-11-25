"""File send vectors (tests/vectors/file-v1.json) through the core layer and the upload request builder."""

import io
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pusharmor as pa  # noqa: E402

VECTORS = os.path.join(HERE, "..", "..", "..", "tests", "vectors")
with open(os.path.join(VECTORS, "file-v1.json"), "rb") as f:
    V = json.load(f)
with open(os.path.join(VECTORS, "golden-v1.json"), "rb") as f:
    G = json.load(f)

b64d, b64e = pa.b64d, pa.b64e


def test_constants():
    assert pa.MAX_FILE == V["constants"]["MAX_FILE"] and pa.BLOB_OVERHEAD == V["constants"]["BLOB_OVERHEAD"]


@pytest.mark.parametrize("c", V["names"]["cases"], ids=lambda c: repr(c["input"]))
def test_names(c):
    assert pa.sanitize_name(c["input"], V["names"]["time"], c["image"]) == c["output"]


@pytest.mark.parametrize("c", V["collision"]["cases"], ids=lambda c: c["name"] + "-" + c["mode"])
def test_collision(c):
    assert pa.collide(c["input"], c["existing"], {"ignore_case": True, "exact": False}[c["mode"]]) == c["output"]


@pytest.mark.parametrize("c", V["blob"]["cases"], ids=lambda c: c["name"])
def test_blob(c):
    key, blob, pt = b64d(c["key"]), b64d(c["blob"]), b64d(c["plaintext"])
    out = io.BytesIO()
    assert pa.seal_file(io.BytesIO(pt), out, key, b64d(c["nonce"]), c["size"]) == c["sha256"]
    assert out.getvalue() == blob and len(blob) == c["blob_size"] == c["size"] + pa.BLOB_OVERHEAD
    out = io.BytesIO()
    pa.open_file_blob(io.BytesIO(blob), out, key, len(blob))
    assert out.getvalue() == pt
    for bit in range(0, len(blob) * 8, 7):
        bad = bytearray(blob)
        bad[bit // 8] ^= 1 << (bit % 8)
        with pytest.raises(ValueError):
            pa.open_file_blob(io.BytesIO(bytes(bad)), io.BytesIO(), key, len(blob))


def test_seal_refuses_a_file_that_changed_size():
    with pytest.raises(ValueError):
        pa.seal_file(io.BytesIO(b"abc"), io.BytesIO(), bytes(32), bytes(12), 4)
    with pytest.raises(ValueError):
        pa.seal_file(io.BytesIO(b"abcde"), io.BytesIO(), bytes(32), bytes(12), 4)


def test_streaming_crypto_works_in_chunks(monkeypatch):
    monkeypatch.setattr(pa, "FILE_CHUNK", 5)
    pt, key, out, back = os.urandom(123), os.urandom(32), io.BytesIO(), io.BytesIO()
    pa.seal_file(io.BytesIO(pt), out, key, os.urandom(12), len(pt))
    pa.open_file_blob(io.BytesIO(out.getvalue()), back, key, len(out.getvalue()))
    assert back.getvalue() == pt


@pytest.mark.parametrize("c", V["sha256"]["cases"], ids=lambda c: c["name"])
def test_sha256(c):
    assert b64e(pa.sha256(b64d(c["input"]))) == c["sha256"]


@pytest.mark.parametrize("c", V["file_sig"]["cases"], ids=lambda c: c["name"])
def test_file_sig(c):
    b = pa.file_sig_bytes(c["method"], c.get("path", "/v1/file"), c["pa_time"], c.get("content_length"),
                          c.get("file_sha256"), c.get("send_id"))
    assert b == b64d(c["signed_bytes"]) == c["signed_text"].encode()
    assert pa.verify(b64d(c["sign_pub"]), b, b64d(c["sig"])) is c["verifies"]


def test_upload_request():
    u = V["upload_request"]
    x = {k: (v if k in ("id", "email") else b64d(v)) for k, v in G["keys"]["peers"][u["signer"]].items()}
    keys = {"id": x["id"], "sign": x["sign_priv"]}
    body, h = b64d(u["body"]), u["headers"]
    sha = b64e(pa.sha256(body))
    got = pa.file_post_headers(keys, h["PA-Time"], len(body), sha, h["PA-Send-ID"])
    for k in ("Content-Length", "PA-File-SHA256", "PA-ID", "PA-Send-ID", "PA-Time"):
        assert got[k] == h[k], k
    assert got["PA-Client"] == "cli/" + pa.VERSION and h["PA-Client"].startswith("cli/")
    signed = b64d(u["signed_bytes"])
    assert signed == pa.file_sig_bytes(u["method"], u["path"], h["PA-Time"], len(body), sha, h["PA-Send-ID"])
    assert pa.verify(b64d(u["sign_pub"]), signed, b64d(h["PA-Sig"]))
    assert pa.verify(b64d(u["sign_pub"]), signed, b64d(got["PA-Sig"]))
    out = io.BytesIO()
    pa.open_file_blob(io.BytesIO(body), out, b64d(u["key"]), len(body))
    assert out.getvalue() == b64d(u["plaintext"])


@pytest.mark.parametrize("c", V["download_sig"]["cases"], ids=lambda c: c["name"])
def test_download_sig(c):
    path = pa.urllib.parse.urlsplit(c["url"]).path
    assert path == c["path"] and c["method"] == "GET"
    b = pa.download_sig_bytes(path, c["pa_time"])
    assert b == b64d(c["signed_bytes"]) == c["signed_text"].encode()
    assert pa.verify(b64d(c["sign_pub"]), b, b64d(c["sig"])) is c["verifies"]
    x = {k: (v if k in ("id", "email") else b64d(v)) for k, v in G["keys"]["peers"][c["signer"]].items()}
    keys = {"id": x["id"], "sign": x["sign_priv"], "sign_pub": x["sign_pub"], "enc_pub": x["enc_pub"]}
    got = pa.download_headers(keys, c["url"], c["pa_time"])
    assert sorted(got) == sorted(c["headers"])
    for k in ("PA-ID", "PA-Time", "PA-Sign-Pub", "PA-Enc-Pub"):
        assert got[k] == c["headers"][k], k
    assert c["headers"]["PA-Sig"] == c["sig"] and len(got["PA-Sig"]) == 86
    assert pa.verify(b64d(c["sign_pub"]), b, b64d(got["PA-Sig"]))


@pytest.mark.parametrize("c", [c for c in V["auto_download"]["cases"] if c["client"] == "cli"], ids=lambda c: str(c["size"]))
def test_auto_download_cli(c, monkeypatch, tmp_path):
    """listen --files: every file up to MAX_FILE is fetched, no picker; a larger one is refused before any GET."""
    gets = []
    monkeypatch.setattr(pa, "http_open", lambda url, h: gets.append(url) or (410, {}, io.BytesIO(b"")))
    monkeypatch.setattr(pa.shutil, "disk_usage", lambda p: pa.shutil._ntuple_diskusage(1 << 40, 0, 1 << 40))

    class Cx:
        keys = {"id": "x", "sign": pa.new_key()[0], "sign_pub": pa.new_key()[1], "enc_pub": pa.new_key()[1]}

        class api:
            skew_ms = 0

    v = {"url": "https://b2file.pusharmor.com/v1/x", "expires": int(pa.time.time()) + 600, "key": bytes(32),
         "name": "a.bin", "size": c["size"], "sha256": "A" * 43}
    with pytest.raises(pa.FileFail) as e:
        pa.download_file(Cx, v, "a.bin", str(tmp_path), set())
    assert bool(gets) is c["download"]
    assert ("expired" in str(e.value)) is c["download"] and ("too large" in str(e.value)) is not c["download"]


FILE_OBJ = {"url": "https://b2file.pusharmor.com/v1/202611230347/3f9a1c5e7b2d4a60/202611230347-" + "0" * 32,
            "expires": 1795405632, "key": pa.b64e(b"0123456789abcdef" * 2), "name": "report (1).pdf",
            "size": 1234567, "sha256": "n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg"}


def test_file_value_accepts_the_plan_example():
    v = pa.file_value(pa.parse_strict(json.dumps(dict(FILE_OBJ, extra=1)).encode()))
    assert v == dict(FILE_OBJ, key=b64d(FILE_OBJ["key"]))


@pytest.mark.parametrize("change", [{"url": 1}, {"expires": -1}, {"expires": 1.5}, {"expires": "1"}, {"size": -1},
                                    {"size": 2 ** 53}, {"key": "A" * 42}, {"key": "A" * 43 + "A"}, {"sha256": None},
                                    {"name": 5}, {"name": "x" * 2049}])
def test_file_value_refuses_a_bad_field(change):
    assert pa.file_value(pa.parse_strict(json.dumps(dict(FILE_OBJ, **change)).encode())) is None
    for k in FILE_OBJ:
        assert pa.file_value(pa.parse_strict(json.dumps({x: y for x, y in FILE_OBJ.items() if x != k}).encode())) is None


def test_file_message_json_has_show():
    o = json.loads(pa.msg_json(44, "file", FILE_OBJ))
    assert o["show"] is True and o["file"] == FILE_OBJ and list(o) == ["v", "n", "id", "show", "file"]


@pytest.mark.parametrize("url,ok", [
    ("https://b2file.pusharmor.com/v1/a", True), ("https://b2file.pusharmor.com:443/v1/a", True),
    ("http://b2file.pusharmor.com/v1/a", False), ("https://pusharmor.com.evil.com/v1/a", False),
    ("https://b2file.pusharmor.com:8443/v1/a", False), ("https://u:p@b2file.pusharmor.com/v1/a", False),
    ("https://evilpusharmor.com/v1/a", False), ("https://b2file.pusharmor.com:x/v1/a", False)])
def test_file_url_allow_list(url, ok):
    assert pa.file_url_ok(url) is ok


@pytest.mark.parametrize("s,text", [(1, "1 minute"), (60, "1 minute"), (61, "2 minutes"), (3599, "60 minutes"),
                                    (3600, "1 hour"), (7201, "3 hours"), (172799, "48 hours"), (172800, "2 days"),
                                    (200000, "3 days")])
def test_file_wait_units(s, text):
    assert pa.file_wait(s) == text


def test_download_follows_no_redirect_off_the_file_host():
    import http.server
    import threading

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "https://example.com/blob")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        status, hdrs, r = pa.http_open("http://127.0.0.1:%d/v1/x" % srv.server_port, {})
        r.close()
    finally:
        srv.shutdown()
        srv.server_close()
    assert status == 302

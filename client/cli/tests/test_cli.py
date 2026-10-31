"""Command layer: parsing, files, HTTP rules, login, pair, send, and listen through a fake relay server."""

import io
import json
import os
import sys
import threading
import time
import tomllib

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pusharmor as pa  # noqa: E402
from fake_relay import Net  # noqa: E402

CODE = "A" * 22 + "bcd_-0123456"


class Stdin:
    def __init__(self, tty=True, data=b""):
        self.tty, self.buffer = tty, io.BytesIO(data)

    def isatty(self):
        return self.tty


@pytest.fixture
def net(monkeypatch):
    n = Net()
    monkeypatch.setattr(pa, "http_request", n.http)
    monkeypatch.setattr(pa, "ntfy_open", n.ntfy_open)
    monkeypatch.setattr(pa, "WAIT_TIMEOUT_S", 0.3)
    monkeypatch.setattr(pa, "PROBE_WAIT_S", 3)
    monkeypatch.setattr(pa, "PAIR_WAIT_S", 20)
    monkeypatch.setattr(pa, "FETCH_GAP_S", 0)
    monkeypatch.setattr(sys, "stdin", Stdin())
    monkeypatch.delenv("PUSHARMOR_CONFIG", raising=False)
    yield n
    n.stop.set()


def answers(monkeypatch, *items):
    it = iter(items)
    monkeypatch.setattr(pa, "input", lambda prompt="": next(it), raising=False)


def run(cfg, *argv):
    return pa.main(["--config", str(cfg)] + list(argv))


def state(cfg):
    with open(os.path.join(cfg, "devices.toml"), "rb") as f:
        return tomllib.load(f)


def my_id(cfg):
    with open(os.path.join(cfg, "keys", "private.toml"), "rb") as f:
        return tomllib.load(f)["id"]


def login(monkeypatch, cfg):
    answers(monkeypatch, "  `" + CODE + "`  ")
    assert run(cfg, "login") == 0
    return my_id(cfg)


def pair_two(monkeypatch, net, a, b):
    """a runs pair b; once a's commit reached b, b runs pair a. Both approve."""
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    monkeypatch.setattr(pa, "input", lambda prompt="": "y", raising=False)
    codes = {}
    before = net.count(idb)
    ta = threading.Thread(target=lambda: codes.__setitem__("a", run(a, "pair", pa.id_hex(idb)[:6])))
    ta.start()
    end = time.time() + 10
    while net.count(idb) == before and time.time() < end:
        time.sleep(0.02)
    tb = threading.Thread(target=lambda: codes.__setitem__("b", run(b, "pair", pa.id_hex(ida)[:8])))
    tb.start()
    ta.join(30)
    tb.join(30)
    assert codes == {"a": 0, "b": 0}
    return ida, idb


# ---- parsing ----

def test_command_table_is_frozen():
    assert list(pa.COMMANDS) == ["login", "logout", "pair", "listen", "send", "rename", "delete"]


@pytest.mark.parametrize("argv", [[], ["frob"], ["rename"], ["delete"], ["send", "--bogus"], ["pair", "a", "b"],
                                  ["listen", "--json", "--tsv"], ["listen", "--tsv", "--exec", "x"], ["login", "x"]])
def test_bad_usage_exits_2(argv, capsys):
    with pytest.raises(SystemExit) as e:
        pa.main(argv)
    assert e.value.code == 2


@pytest.mark.parametrize("name", list(pa.COMMANDS))
def test_help_for_every_command(name, capsys):
    with pytest.raises(SystemExit) as e:
        pa.main([name, "--help"])
    assert e.value.code == 0 and "usage: pusharmor " + name in capsys.readouterr().out


def test_parse_args_per_command():
    p = pa.build_parser()
    a = p.parse_args(["--config", "/x", "send", "--to", "abcdef", "--to", "123456", "--text", "hi", "there"])
    assert (a.config, a.command, a.to, a.text, a.message) == ("/x", "send", ["abcdef", "123456"], True, ["hi", "there"])
    assert p.parse_args(["pair"]).id is None and p.parse_args(["pair", "abcdef"]).id == "abcdef"
    a = p.parse_args(["listen", "--exec", "notify"])
    assert (a.exec, a.json, a.tsv) == ("notify", False, False)
    assert p.parse_args(["rename", "My laptop"]).name == "My laptop"
    assert p.parse_args(["delete", "abcdef"]).id == "abcdef"


def test_windows_refused(monkeypatch, capsys):
    monkeypatch.setattr(pa.sys, "platform", "win32")
    assert pa.main(["send", "x"]) == 1
    assert capsys.readouterr().err.strip() == "PushArmor command line is not supported on Windows yet."


# ---- files ----

def test_config_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("PUSHARMOR_CONFIG", raising=False)
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    assert pa.config_dir() == str(tmp_path / ".config" / "pusharmor")
    monkeypatch.setenv("XDG_CONFIG_HOME", "relative/ignored")
    assert pa.config_dir() == str(tmp_path / ".config" / "pusharmor")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg")
    assert pa.config_dir() == "/xdg/pusharmor"
    monkeypatch.setenv("PUSHARMOR_CONFIG", "/env")
    assert pa.config_dir() == "/env"
    assert pa.config_dir("/arg") == "/arg"


def test_toml_round_trip():
    wide = "e" + chr(0xE9) + " " + chr(0x20AC) + " " + chr(0x1F600)
    d = {"version": 1, "s": 'q"b\\s\n\t\x01\x7f ' + wide, "i": 0, "neg": -5, "t": True, "f": False,
         "l": [1, 2], "ls": ["a", "b c"], "empty": [],
         "peers": {"AbC-_9": {"x": "y", "seen": [3, 2]}, "needs quote": {}}, "pairs": {}}
    text = pa.toml_dumps(d)
    assert text.isascii() and tomllib.loads(text) == d


def make_keys(cfg, dmode=0o700, fmode=0o600):
    st = pa.Store(str(cfg))
    k = {"id": pa.b64e(bytes(30)), "auth": bytes(16)}
    for n in ("sign", "enc", "push"):
        k[n], k[n + "_pub"] = pa.new_key()
    st.save_keys(k)
    os.chmod(st.key_path, fmode)
    os.chmod(st.keys_dir, dmode)
    return st


def test_permissions(tmp_path):
    st = make_keys(tmp_path)
    assert st.load_keys()["id"] == pa.b64e(bytes(30))
    with open(st.key_path) as f:
        assert f.read().startswith("# PushArmor private keys")
    os.chmod(st.keys_dir, 0o755)
    with pytest.raises(pa.Fail) as e:
        st.load_keys()
    assert str(e.value).startswith("Refusing to use %s: found mode 0755" % st.keys_dir)
    assert "Fix: chmod 700 %s" % st.keys_dir in str(e.value)
    os.chmod(st.keys_dir, 0o700)
    os.chmod(st.key_path, 0o644)
    with pytest.raises(pa.Fail) as e:
        st.load_keys()
    assert "found mode 0644" in str(e.value) and "Fix: chmod 600 %s" % st.key_path in str(e.value)


def test_version_refused(tmp_path):
    st = make_keys(tmp_path)
    with open(st.dev_path, "w") as f:
        f.write("version = 2\n")
    with pytest.raises(pa.Fail) as e:
        with st.state():
            pass
    assert "version 2" in str(e.value) and "Update PushArmor" in str(e.value)
    with open(st.key_path, "w") as f:
        f.write('id = "x"\n')
    with pytest.raises(pa.Fail) as e:
        st.load_keys()
    assert "version None" in str(e.value)


def test_not_logged_in(tmp_path, capsys):
    assert pa.main(["--config", str(tmp_path), "send", "hi"]) == 3
    assert "Not logged in" in capsys.readouterr().err


# ---- HTTP rules ----

def test_426_update(monkeypatch):
    monkeypatch.setattr(pa, "http_request", lambda *a: (426, {}, b'{"error":"update required"}'))
    with pytest.raises(pa.Fail) as e:
        pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers")
    assert str(e.value).startswith("Update PushArmor to continue: ") and e.value.code == 1


def test_clock_skew_resync(monkeypatch):
    seen = []

    def fake(method, url, headers, body):
        seen.append(int(headers["PA-Time"]))
        assert headers["PA-Client"] == "cli/" + pa.VERSION
        if len(seen) == 1:
            return 401, {"pa-epoch": "2000000000"}, b'{"error":"clock skew"}'
        return 200, {}, b'{"ok":1}'

    monkeypatch.setattr(pa, "http_request", fake)
    assert pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers") == {"ok": 1}
    assert len(seen) == 2 and abs(seen[1] - 2000000000000) < 5000 and len(str(seen[1])) == 13


def test_temporary_failures(monkeypatch):
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    calls = []

    def down(*a):
        calls.append(1)
        raise OSError("down")

    monkeypatch.setattr(pa, "http_request", down)
    with pytest.raises(pa.TempFail) as e:
        pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers")
    assert e.value.code == 75 and len(calls) == 3
    monkeypatch.setattr(pa, "http_request", lambda *a: (400, {}, b'{"error":"bad request"}'))
    with pytest.raises(pa.ApiError) as e:
        pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers")
    assert (e.value.status, e.value.error) == (400, "bad request")


# ---- login ----

def test_login_needs_tty(net, tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "stdin", Stdin(tty=False))
    assert run(tmp_path, "login") == 2


def test_login_code_tries(net, tmp_path, monkeypatch, capsys):
    answers(monkeypatch, "short", CODE[:-1] + "!", "'" + CODE + "x'")
    assert run(tmp_path, "login") == 1
    out = capsys.readouterr()
    assert "\n\n  https://pusharmor.com/auth/cli#r." in out.out
    assert "after 3 tries" in out.err and net.log == []
    assert not os.path.exists(tmp_path / "keys")


def test_login_registers_and_confirms(net, tmp_path, monkeypatch, capsys):
    pid = login(monkeypatch, tmp_path)
    p = net.peers[pid]
    assert p["push_ok"] and p["platform"] == "cli"
    d = state(tmp_path)
    assert d["reg"] == "registered" and d["push_ok"]
    assert pa.re.fullmatch(r"up[A-Za-z0-9]{12}", d["topic"])
    assert os.stat(tmp_path / "keys").st_mode & 0o777 == 0o700
    assert os.stat(tmp_path / "keys" / "private.toml").st_mode & 0o777 == 0o600
    out = capsys.readouterr().out
    assert "#r." + pa.b64e(pa.sha256(pa.b64d(p["sign_pub"]))[:16]) in out
    assert run(tmp_path, "login") == 0 and "already logged in" in capsys.readouterr().out


def test_login_peer_limit(net, tmp_path, monkeypatch):
    net.limit = 1
    first = login(monkeypatch, tmp_path / "a")
    answers(monkeypatch, CODE, "1")
    assert run(tmp_path / "b", "login") == 0
    assert first not in net.peers and len(net.peers) == 1


# ---- pair, send, listen ----

def test_pair_send_listen(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = pair_two(monkeypatch, net, a, b)
    da, db = state(a), state(b)
    assert da["peers"][idb]["approves_me"] and db["peers"][ida]["approves_me"]
    assert da["peers"][idb]["pairing_id"] == db["peers"][ida]["pairing_id"]
    assert da["pairs"] == {} and db["pairs"] == {}
    out = capsys.readouterr().out
    assert out.count("Pairing fingerprint ") == 2 and out.count("Paired with ") == 2

    assert run(a, "pair") == 0
    listing = capsys.readouterr().out
    assert "this device" in listing and "paired" in listing and pa.id_hex(idb)[:6] in listing

    # write-ahead counter: n is on disk before the POST reaches the relay server
    n0 = da["peers"][idb]["n"]

    def check(method, path, headers, body):
        assert state(a)["peers"][idb]["n"] == n0 + 1

    net.hooks[("POST", "send")] = check
    assert run(a, "send", "https://example.com/a b") == 0
    del net.hooks[("POST", "send")]
    monkeypatch.setattr(sys, "stdin", Stdin(tty=False, data="line one\n\tline two\n".encode()))
    assert run(a, "send", "--to", pa.id_hex(idb)[:6]) == 0
    monkeypatch.setattr(sys, "stdin", Stdin())

    net.stop.set()
    capsys.readouterr()
    assert run(b, "listen", "--json") == 130
    lines = [json.loads(x) for x in capsys.readouterr().out.splitlines()]
    assert [x["type"] for x in lines] == ["url", "text"]
    assert lines[0]["body"] == "https://example.com/a%20b" and lines[1]["body"] == "line one\n\tline two"
    assert list(lines[0]) == list(pa.REC_KEYS) and lines[0]["from"] == pa.id_hex(ida)
    assert lines[0]["platform"] == "cli"

    # rename reaches the other device by push
    assert run(a, "rename", "Desk") == 0
    assert run(b, "listen") == 130
    assert state(b)["peers"][ida]["name"] == "Desk"

    # delete the other device: it gets a remove message and wipes itself on receive
    answers(monkeypatch, "y")
    assert run(a, "delete", pa.id_hex(idb)[:6]) == 0
    assert idb not in net.peers and idb not in state(a)["peers"]
    assert run(b, "listen") == 3
    assert not os.path.exists(b / "keys" / "private.toml")


def test_send_no_devices_and_logout(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    assert run(tmp_path, "send", "hi") == 4
    assert run(tmp_path, "send") == 2
    assert run(tmp_path, "rename", 'bad "name"') == 2
    answers(monkeypatch, "y")
    assert run(tmp_path, "logout") == 0 and state(tmp_path)["reg"] == "logged_out"
    assert run(tmp_path, "send", "hi") == 3
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == 0 and state(tmp_path)["reg"] == "registered"


def test_delete_self(net, tmp_path, monkeypatch):
    pid = login(monkeypatch, tmp_path)
    answers(monkeypatch, "y")
    assert run(tmp_path, "delete", pa.id_hex(pid)[:6]) == 0
    assert pid not in net.peers and not os.path.exists(tmp_path / "devices.toml")


def test_send_too_long(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    assert run(tmp_path, "send", "x" * 2049) == 1
    assert "Too long (2049 / 2048)" in capsys.readouterr().err


# ---- listen output ----

REC = {"from": "ab" * 21, "name": "Pixel", "platform": "android", "type": "text", "body": "a\tb\nc\\d\x1b",
       "date": "2026-10-30T12:00:00Z"}


def test_format_json_and_tsv():
    assert json.loads(pa.format_record(REC, "json")) == REC
    assert pa.format_record(REC, "tsv") == "\t".join(["ab" * 21, "Pixel", "android", "text", "a\\tb\\nc\\\\d\x1b",
                                                       "2026-10-30T12:00:00Z"])


def test_format_blocks():
    out = pa.format_record(REC, "blocks").splitlines()
    assert out[0] == "From: ababab Pixel" and out[1] == "Platform: Android" and out[2] == "Type: text"
    assert out[3].startswith("Date: ") and out[4] == "Body: a\tb" and out[5] == " c\\d?"

"""Command layer: parsing, files, HTTP rules, login, pair, send, and listen through a fake relay server."""

import contextlib
import io
import json
import os
import sys
import threading
import time

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
    with open(os.path.join(cfg, "devices.toml"), encoding="utf-8") as f:
        return pa.toml_loads(f.read())


def my_id(cfg):
    with open(os.path.join(cfg, "keys", "private.toml"), encoding="utf-8") as f:
        return pa.toml_loads(f.read())["id"]


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
    assert text.isascii() and pa.toml_loads(text) == d
    assert pa._toml_loads(text) == d
    assert pa._toml_loads(pa.KEY_HEADER + text) == d


def test_toml_fallback_reader():
    text = ('# settings\n\n  server = "https://r.example"  # mine\nntfy = "https://n.example"\n'
            '[a]\nx = [ 1 , -2 ]\n[ a . "b c" ]\ny = true\n')
    want = {"server": "https://r.example", "ntfy": "https://n.example", "a": {"x": [1, -2], "b c": {"y": True}}}
    assert pa._toml_loads(text) == want
    if pa.tomllib is not None:
        assert pa.tomllib.loads(text) == want
    for bad in ('x = 1\nx = 2\n', '[a]\n[a]\n', 'x = "a\n', 'x = 1.5\n', 'x = 01\n', 'x = "\\q"\n',
                'x = "\\ud800"\n', 'x = truex\n', 'x = 1 y\n', 'x 1\n', '[a\n', 'x = [1 2]\n',
                'x = 1\n[x]\n', "x = 'lit'\n"):
        with pytest.raises(pa.TomlError):
            pa._toml_loads(bad)


def test_bad_toml_file(tmp_path):
    p = tmp_path / "settings.toml"
    p.write_text("server = \n")
    with pytest.raises(pa.Fail) as e:
        pa.read_toml(str(p))
    assert "is not valid TOML" in str(e.value)


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
    assert str(e.value) == "%s has version 2, which this PushArmor does not know. Update PushArmor to continue." % st.dev_path
    with open(st.key_path, "w") as f:
        f.write('id = "x"\n')
    with pytest.raises(pa.Fail) as e:
        st.load_keys()
    assert "damaged" in str(e.value) and "version None" not in str(e.value)


def test_not_logged_in(tmp_path, capsys):
    assert pa.main(["--config", str(tmp_path), "send", "hi"]) == 3
    assert "Not logged in" in capsys.readouterr().err


# ---- HTTP rules ----

def test_426_update(monkeypatch):
    monkeypatch.setattr(pa, "http_request", lambda *a: (426, {}, b'{"error":"update required"}'))
    with pytest.raises(pa.Fail) as e:
        pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers")
    assert str(e.value) == "Update PushArmor to continue." and e.value.code == 1


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


def test_login_that_cannot_save_removes_the_device(net, tmp_path, monkeypatch, capsys):
    (tmp_path / "devices.toml").mkdir()
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == 1
    assert net.peers == {} and not (tmp_path / "keys" / "private.toml").exists()
    assert "Is a directory" in capsys.readouterr().err
    (tmp_path / "devices.toml").rmdir()
    pid = login(monkeypatch, tmp_path)
    assert list(net.peers) == [pid]


@pytest.mark.skipif(os.getuid() == 0, reason="root writes any folder")
def test_login_in_a_read_only_folder_removes_the_device(net, tmp_path, monkeypatch):
    tmp_path.chmod(0o500)
    answers(monkeypatch, CODE)
    try:
        assert run(tmp_path, "login") == 1
    finally:
        tmp_path.chmod(0o700)
    assert net.peers == {}


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
    answers(monkeypatch)  # logout must never prompt
    assert run(tmp_path, "logout") == 0 and state(tmp_path)["reg"] == "logged_out"
    assert run(tmp_path, "send", "hi") == 3
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == 0 and state(tmp_path)["reg"] == "registered"


def test_logout_local_first_and_retried(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    me = my_id(tmp_path)
    answers(monkeypatch)
    down = [True]

    def hook(method, path, headers, body):
        if down[0]:
            return net.reply(503, {})

    net.hooks[("POST", "peers")] = hook
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    assert run(tmp_path, "logout") == 0
    assert state(tmp_path)["reg"] == "logged_out" and state(tmp_path)["logout_pending"] is True
    assert "try again" in capsys.readouterr().err
    assert net.peers[me]["logged_out"] is False
    # still down: the next run keeps it pending
    assert run(tmp_path, "send", "hi") == 3
    assert state(tmp_path)["logout_pending"] is True
    # server back: the next run sends it and clears the pending flag
    down[0] = False
    assert run(tmp_path, "send", "hi") == 3
    assert net.peers[me]["logged_out"] is True and "logout_pending" not in state(tmp_path)
    # not logged in or already logged out: exit 0, plain sentence
    capsys.readouterr()
    assert run(tmp_path, "logout") == 0
    assert "already logged out" in capsys.readouterr().out


def test_logout_not_logged_in(net, tmp_path, capsys):
    assert run(tmp_path, "logout") == 0
    cap = capsys.readouterr()
    assert "not logged in" in cap.out and "pusharmor login" not in cap.out + cap.err


def test_logout_pending_dropped_when_device_gone(net, tmp_path, monkeypatch):
    login(monkeypatch, tmp_path)
    me = my_id(tmp_path)
    answers(monkeypatch)
    net.hooks[("POST", "peers")] = lambda *a: net.reply(503, {})
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    assert run(tmp_path, "logout") == 0 and state(tmp_path)["logout_pending"] is True
    net.hooks.clear()
    del net.peers[me]
    run(tmp_path, "send", "hi")
    assert "logout_pending" not in state(tmp_path)


def test_bad_config_path_is_named(net, tmp_path, capsys):
    f = tmp_path / "afile"
    f.write_text("x")
    assert run(f, "send", "hi") == 2
    assert str(f) in capsys.readouterr().err
    gone = tmp_path / "nope" / "x"
    assert run(gone, "send", "hi") == 3
    assert str(gone) in capsys.readouterr().err


def test_delete_self(net, tmp_path, monkeypatch):
    pid = login(monkeypatch, tmp_path)
    answers(monkeypatch, "y")
    assert run(tmp_path, "delete", pa.id_hex(pid)[:6]) == 0
    assert pid not in net.peers and not os.path.exists(tmp_path / "devices.toml")


def test_delete_non_tty_needs_yes(net, tmp_path, monkeypatch, capsys):
    pid = login(monkeypatch, tmp_path)
    monkeypatch.setattr(sys, "stdin", Stdin(tty=False))
    assert run(tmp_path, "delete", pa.id_hex(pid)[:6]) == 2
    assert "Use --yes" in capsys.readouterr().err and pid in net.peers
    assert run(tmp_path, "delete", pa.id_hex(pid)[:6], "--yes") == 0
    assert pid not in net.peers


def test_send_too_long(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    assert run(tmp_path, "send", "x" * 2049) == 2
    assert "Too long (2049 / 2048 bytes)." in capsys.readouterr().err


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


# ---- damaged files: one line naming the file, exit 1, no traceback ----

def _logged_in(monkeypatch, tmp_path, net):
    cfg = tmp_path / "cfg"
    login(monkeypatch, cfg)
    return cfg


@pytest.mark.parametrize("rel", [os.path.join("keys", "private.toml"), "devices.toml", "settings.toml"])
@pytest.mark.parametrize("data", [b"\xff\xfe\x00bad\x80", b"not = [valid toml"])
def test_damaged_state_file_is_one_line_exit_1(monkeypatch, tmp_path, net, capsys, rel, data):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    path = cfg / rel
    path.write_bytes(data)
    path.chmod(0o600)
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", Stdin(tty=False, data=b"hi"))
    assert run(cfg, "send", "hi") == 1
    err = capsys.readouterr().err.strip()
    assert "\n" not in err and "Traceback" not in err
    assert str(path) in err


def test_wrong_key_length_is_damaged(monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    path = cfg / "keys" / "private.toml"
    d = pa.toml_loads(path.read_text())
    d["sign_key"] = pa.b64e(b"\x01" * 31)
    path.write_text(pa.KEY_HEADER + pa.toml_dumps(d))
    path.chmod(0o600)
    capsys.readouterr()
    assert run(cfg, "send", "hi") == 1
    err = capsys.readouterr().err.strip()
    assert err == "%s is damaged. Delete it and log in again." % path


def test_help_and_readme_list_every_exit_code(capsys):
    with pytest.raises(SystemExit) as e:
        pa.main(["--help"])
    assert e.value.code == 0
    out = capsys.readouterr().out
    readme = open(os.path.join(os.path.dirname(HERE), "README.md"), encoding="utf-8").read()
    assert len(pa.EXIT_CODES) == 8
    for code, text in pa.EXIT_CODES:
        assert "  %-3d %s" % (code, text) in out
        assert "| %d | %s |" % (code, text) in readme


# ---- crashes: every error is one line on stderr and a listed exit code ----

class BrokenOut:
    """stdout of listen | head -1 after head exits."""

    def write(self, s):
        raise BrokenPipeError(32, "Broken pipe")

    def flush(self):
        raise BrokenPipeError(32, "Broken pipe")


def test_unreadable_file_is_one_line(monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    os.unlink(cfg / "devices.toml")
    os.mkdir(cfg / "devices.toml")
    capsys.readouterr()
    assert run(cfg, "send", "hi") == 1
    err = capsys.readouterr().err
    assert err == "Cannot read or write %s: Is a directory.\n" % (cfg / "devices.toml")


def test_config_path_that_is_a_file_or_too_long(monkeypatch, tmp_path, capsys):
    f = tmp_path / "file"
    f.write_text("x")
    monkeypatch.setenv("PUSHARMOR_CONFIG", str(f))
    assert pa.main(["logout"]) == 1
    assert capsys.readouterr().err == "Cannot read or write %s: File exists.\n" % f
    monkeypatch.setenv("PUSHARMOR_CONFIG", str(tmp_path / ("a" * 5000)))
    assert pa.main(["logout"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("Cannot read or write ") and err.endswith(": File name too long.\n")


@pytest.mark.skipif(os.getuid() == 0, reason="root reads any file")
def test_file_without_permission(monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    (cfg / "devices.toml").chmod(0)
    capsys.readouterr()
    assert run(cfg, "send", "hi") == 1
    assert capsys.readouterr().err == "Cannot read or write %s: Permission denied.\n" % (cfg / "devices.toml")


def test_closed_output_exits_quietly(monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdout", BrokenOut())
    assert run(cfg, "pair") == 1
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("how", ["closed pipe", "full disk"])
def test_help_to_closed_or_full_output(how, tmp_path):
    import subprocess
    script = os.path.join(os.path.dirname(HERE), "pusharmor.py")
    if how == "full disk":
        if not os.path.exists("/dev/full"):
            pytest.skip("no /dev/full")
        with open("/dev/full", "w") as out:
            p = subprocess.run([sys.executable, script, "--help"], stdout=out, stderr=subprocess.PIPE)
        assert p.returncode == 1 and p.stderr == b"Cannot read or write a file on this device: No space left on device.\n"
        return
    p = subprocess.Popen([sys.executable, script, "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    p.stdout.close()
    err = p.stderr.read()
    assert p.wait() == 1 and err == b""


def test_unexpected_error_is_one_line_exit_70(monkeypatch, tmp_path, capsys):
    def boom(cx, args):
        raise TypeError("bad\nvalue")

    monkeypatch.setitem(pa.COMMANDS, "logout", (boom, "", []))
    assert run(tmp_path, "logout") == pa.EXIT_BUG == 70
    assert capsys.readouterr().err == ("PushArmor stopped on an unexpected error (TypeError: bad value). "
                                       "Please report it.\n")


def test_output_the_terminal_cannot_show(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(pa.COMMANDS, "logout", (lambda cx, args: print("caf\u00e9"), "", []))
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="ascii"))
    assert run(tmp_path, "logout") == 1
    assert "Use a UTF-8 locale" in capsys.readouterr().err


@contextlib.contextmanager
def local_http(reply):
    """A real HTTP server on 127.0.0.1; reply(handler) writes the raw reply."""
    import http.server

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            reply(self)

        def log_message(self, *a):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield "http://127.0.0.1:%d" % srv.server_address[1]
    finally:
        srv.shutdown()
        srv.server_close()


def test_cut_off_error_body_keeps_the_status():
    def reply(h):
        h.send_response(500)
        h.send_header("Content-Length", "1000")
        h.end_headers()
        h.wfile.write(b"{")
        h.close_connection = True

    with local_http(reply) as url:
        status, _, body = pa.http_request("GET", url + "/v1/peers", {}, None)
    assert (status, body) == (500, b"")

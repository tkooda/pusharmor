"""Command layer: parsing, files, HTTP rules, login, pair, send, and listen through a fake relay server."""

import contextlib
import io
import json
import os
import shutil
import stat
import sys
import threading
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pusharmor as pa  # noqa: E402
import fake_relay  # noqa: E402
import helpers  # noqa: E402
from fake_relay import Net  # noqa: E402

CODE = "A" * 22 + "bcd_-0123456"


class Stdin:
    def __init__(self, tty=True, data=b""):
        self.tty, self.buffer = tty, io.BytesIO(data)

    def isatty(self):
        return self.tty


@pytest.fixture(autouse=True)
def umask_022():
    """Files the tests write get mode 0644 whatever the umask of the shell; group-writable tests set the mode."""
    old = os.umask(0o022)
    yield
    os.umask(old)


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


def pair_two(monkeypatch, net, a, b, ids=None):
    """a runs pair b; once a's commit reached b, b runs pair a. Both approve. ids: both already logged in."""
    ida, idb = ids or (login(monkeypatch, a), login(monkeypatch, b))
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
    err = capsys.readouterr().err
    assert err.startswith("error: ") and err.count("\n") == 1


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


@pytest.fixture
def as_windows(monkeypatch):
    """Windows as the CLI sees it: a fake msvcrt that records its calls, and no fcntl, pwd, grp, getuid, or getgid."""
    from types import SimpleNamespace
    calls = []
    monkeypatch.setattr(pa.sys, "platform", "win32")
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(
        LK_LOCK=1, LK_UNLCK=0, locking=lambda fd, mode, n: calls.append((mode, n))))
    for name in ("fcntl", "pwd", "grp"):
        monkeypatch.setitem(sys.modules, name, None)  # import raises ImportError
    for name in ("getuid", "getgid"):
        monkeypatch.setattr(pa.os, name, lambda: pytest.fail("POSIX user id lookup on Windows"), raising=False)
    return calls


def test_windows_config_dir_is_appdata(as_windows, monkeypatch, tmp_path):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg")
    monkeypatch.delenv("PUSHARMOR_CONFIG", raising=False)
    assert pa.config_dir() == os.path.join(str(tmp_path), "PushArmor")
    monkeypatch.setenv("PUSHARMOR_CONFIG", str(tmp_path / "env"))
    assert pa.config_dir() == str(tmp_path / "env")
    assert pa.Store(pa.config_dir(str(tmp_path / "arg"))).keys_dir == os.path.join(str(tmp_path / "arg"), "keys")


def test_windows_runs_with_msvcrt_locks_and_no_posix_checks(as_windows, net, monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    answers(monkeypatch, CODE)
    assert pa.main(["login"]) == 0
    cfg = tmp_path / "PushArmor"
    assert (cfg / "keys" / "private.toml").is_file() and (cfg / "devices.toml").is_file()
    assert as_windows and as_windows[0] == (1, 1) and as_windows.count((1, 1)) == as_windows.count((0, 1))
    if os.name != "nt":
        for path in (cfg, cfg / "keys", cfg / "keys" / "private.toml", cfg / "devices.toml"):
            path.chmod(0o777)  # no mode check on Windows: the private profile folder protects the files
    capsys.readouterr()
    assert pa.main(["send", "hi"]) == 4
    assert capsys.readouterr().err.startswith("error: ")


def test_windows_config_dir_without_appdata_is_under_home(as_windows, monkeypatch, tmp_path):
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.delenv("PUSHARMOR_CONFIG", raising=False)
    monkeypatch.setattr(pa.Path, "home", lambda: tmp_path)
    assert pa.config_dir() == os.path.join(str(tmp_path), "AppData", "Roaming", "PushArmor")


def fake_locking(monkeypatch, fails):
    """msvcrt.locking that raises the OSErrors in fails (one per LK_LOCK call) before it locks."""
    from types import SimpleNamespace
    calls, fails = [], list(fails)

    def locking(fd, mode, n):
        calls.append(mode)
        if mode == 1 and fails:
            raise fails.pop(0)

    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(LK_LOCK=1, LK_UNLCK=0, locking=locking))
    return calls


def test_windows_lock_waits_on_after_the_10_second_lock_timeout(as_windows, monkeypatch, tmp_path):
    calls = fake_locking(monkeypatch, [OSError(pa.errno.EDEADLOCK, "Resource deadlock avoided")] * 2)
    with pa.Store(str(tmp_path)).locked():
        assert calls == [1, 1, 1]
    assert calls == [1, 1, 1, 0]


def test_windows_lock_is_released_when_the_body_raises(as_windows, monkeypatch, tmp_path):
    calls = fake_locking(monkeypatch, [])
    with pytest.raises(pa.Fail):
        with pa.Store(str(tmp_path)).locked():
            raise pa.Fail("x")
    assert calls == [1, 0]


def test_windows_lock_other_os_error_is_raised(as_windows, monkeypatch, tmp_path):
    calls = fake_locking(monkeypatch, [OSError(pa.errno.EACCES, "Permission denied")])
    with pytest.raises(OSError) as e:
        with pa.Store(str(tmp_path)).locked():
            pytest.fail("locked after an error that is not the lock timeout")
    assert e.value.errno == pa.errno.EACCES and calls == [1]


def test_windows_closed_pipe_exits_quietly(as_windows, tmp_path, monkeypatch, capsys):
    class ClosedPipe(io.StringIO):
        def flush(self):  # a write into a closed pipe on Windows fails with EINVAL, not EPIPE
            raise OSError(22, "Invalid argument")

    monkeypatch.setattr(sys, "stdout", ClosedPipe())
    assert run(tmp_path, "logout") == 1
    assert capsys.readouterr().err == ""


# ---- files ----

@pytest.mark.skipif(os.name == "nt", reason="Windows uses APPDATA")
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
    assert str(e.value).startswith("The file '%s' has a mistake (" % p) and str(e.value).endswith(
        "). Fix it or delete it.")


def make_keys(cfg, dmode=0o700, fmode=0o600):
    st = pa.Store(str(cfg))
    k = {"id": pa.b64e(bytes(30)), "auth": bytes(16)}
    for n in ("sign", "enc", "push"):
        k[n], k[n + "_pub"] = pa.new_key()
    st.save_keys(k)
    os.chmod(st.key_path, fmode)
    os.chmod(st.keys_dir, dmode)
    return st


@pytest.mark.skipif(os.name == "nt", reason="no POSIX modes or owners on Windows")
def test_permissions(tmp_path):
    st = make_keys(tmp_path)
    assert st.load_keys()["id"] == pa.b64e(bytes(30))
    with open(st.key_path) as f:
        assert f.read().startswith("# PushArmor private keys")
    for mode in (0o755, 0o775, 0o770, 0o701):  # any group or other bit: one hint that fixes all of them
        os.chmod(st.keys_dir, mode)
        with pytest.raises(pa.Fail) as e:
            st.load_keys()
        assert str(e.value) == "'%s' must not be readable by other users. Run: chmod 700 '%s'" % (
            st.keys_dir, st.keys_dir)
    os.chmod(st.keys_dir, 0o700)
    for mode in (0o644, 0o670, 0o602):
        os.chmod(st.key_path, mode)
        with pytest.raises(pa.Fail) as e:
            st.load_keys()
        assert str(e.value) == "'%s' must not be readable by other users. Run: chmod 600 '%s'" % (
            st.key_path, st.key_path)
    os.chmod(st.key_path, 0o600)
    uid = os.getuid()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(pa.os, "getuid", lambda: uid + 1)
        with pytest.raises(pa.Fail) as e:
            pa.check_private(st.key_path, 0o600)
    assert str(e.value) == "'%s' belongs to another user. Run: chown $(id -un) '%s'" % (st.key_path, st.key_path)


def test_version_refused(tmp_path):
    st = make_keys(tmp_path)
    with open(st.dev_path, "w") as f:
        f.write("version = 2\n")
    with pytest.raises(pa.Fail) as e:
        with st.state():
            pass
    assert str(e.value) == "The file '%s' was made by a newer PushArmor. Update PushArmor to continue." % st.dev_path
    with open(st.key_path, "w") as f:
        f.write('id = "x"\n')
    with pytest.raises(pa.Fail) as e:
        st.load_keys()
    assert "unusable" in str(e.value) and "version None" not in str(e.value)


def test_not_logged_in(tmp_path, capsys):
    assert pa.main(["--config", str(tmp_path), "send", "hi"]) == 3
    assert capsys.readouterr().err.splitlines() == ["error: " + pa.NOT_LOGGED_IN]


# ---- HTTP rules ----

def test_426_update(monkeypatch):
    monkeypatch.setattr(pa, "http_request", lambda *a: (426, {}, b'{"error":"update required"}'))
    with pytest.raises(pa.Fail) as e:
        pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers")
    assert str(e.value) == "This version of PushArmor is too old. Update PushArmor to continue." and e.value.code == 1


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
    assert pa.re.search(r"\n\n  https://pusharmor\.com/auth/cli#r[A-Za-z0-9_-]{22}\s", out.out)
    assert "after 3 tries" in out.err and net.log == []
    assert not os.path.exists(tmp_path / "keys")


def test_typed_text_that_is_not_utf8(net, tmp_path, monkeypatch, capsys):
    def bad(prompt=""):
        raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")

    monkeypatch.setattr(pa, "input", bad, raising=False)
    assert run(tmp_path / "a", "login") == 1
    assert "The code was not accepted after 3 tries. Run pusharmor login to get a new code." in capsys.readouterr().err
    me = login(monkeypatch, tmp_path / "b")
    monkeypatch.setattr(pa, "input", bad, raising=False)
    assert run(tmp_path / "b", "delete", pa.id_hex(me)[:8]) == 1
    assert "Nothing removed." in capsys.readouterr().out and me in net.peers


def test_login_registers_and_confirms(net, tmp_path, monkeypatch, capsys):
    pid = login(monkeypatch, tmp_path)
    p = net.peers[pid]
    assert p["push_ok"] and p["platform"] == "cli"
    d = state(tmp_path)
    assert d["reg"] == "registered" and d["push_ok"]
    assert pa.re.fullmatch(r"up[A-Za-z0-9]{12}", d["topic"])
    if os.name != "nt":  # no POSIX modes on Windows
        assert os.stat(tmp_path / "keys").st_mode & 0o777 == 0o700
        assert os.stat(tmp_path / "keys" / "private.toml").st_mode & 0o777 == 0o600
    out = capsys.readouterr().out
    assert "#r" + pa.b64e(pa.sha256(pa.b64d(p["sign_pub"]))[:16]) in out
    assert run(tmp_path, "login") == 0 and "already logged in" in capsys.readouterr().out


def test_login_that_cannot_save_removes_the_device(net, tmp_path, monkeypatch, capsys):
    (tmp_path / "devices.toml").mkdir()
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == 1
    assert net.peers == {} and not (tmp_path / "keys" / "private.toml").exists()
    assert "devices.toml' must be a file that you own." in capsys.readouterr().err
    (tmp_path / "devices.toml").rmdir()
    pid = login(monkeypatch, tmp_path)
    assert list(net.peers) == [pid]


@pytest.mark.skipif(os.name == "nt" or os.getuid() == 0, reason="root writes any folder; no folder modes on Windows")
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


def test_device_names_in_stdout_are_in_double_quotes(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida = login(monkeypatch, a)
    assert 'Logged in. This device is named "%s". Next:' % state(a)["name"] in capsys.readouterr().out
    idb = pair_two(monkeypatch, net, a, b, ids=(ida, login(monkeypatch, b)))[1]
    capsys.readouterr()
    assert run(a, "rename", "Desk") == 0
    assert capsys.readouterr().out == 'This device is now named "Desk".\n'
    name = state(a)["peers"][idb]["name"]
    prompts = []
    monkeypatch.setattr(pa, "input", lambda prompt="": prompts.append(prompt) or "y", raising=False)
    assert run(a, "delete", pa.id_hex(idb)[:6]) == 0
    assert prompts == ['Remove "%s" from your account? "%s" must log in again and pair with every device again. '
                       "[y/N] " % (name, name)]
    assert capsys.readouterr().out == 'Removed "%s".\n' % name


def test_ctrl_d_at_the_fingerprint_prompt_keeps_the_pairing(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    eof = [True]

    def inp(prompt=""):
        if threading.current_thread().name == "b" and eof[0]:
            eof[0] = False
            raise EOFError
        return "y"

    monkeypatch.setattr(pa, "input", inp, raising=False)
    codes = {}
    before = net.count(idb)
    ta = threading.Thread(target=lambda: codes.__setitem__("a", run(a, "pair", pa.id_hex(idb)[:6])))
    ta.start()
    end = time.time() + 10
    while net.count(idb) == before and time.time() < end:
        time.sleep(0.02)
    capsys.readouterr()
    tb = threading.Thread(target=lambda: codes.__setitem__("b", run(b, "pair", pa.id_hex(ida)[:8])), name="b")
    tb.start()
    tb.join(30)
    assert codes.get("b") == 1 and not eof[0]
    err = capsys.readouterr().err
    sid = err.split("Run pusharmor pair ")[1].split(" ")[0]
    assert "No answer was given. Run pusharmor pair %s again.\n" % sid in err and pa.id_hex(ida).startswith(sid)
    assert not any(m == "POST" and "/deny/" in path for m, path in net.log)
    sb = state(b)
    assert sb["pairs"][ida]["state"] == "shown" and sb["peers"][ida]["pinned"]
    tb = threading.Thread(target=lambda: codes.__setitem__("b", run(b, "pair", pa.id_hex(ida)[:8])), name="b")
    tb.start()
    tb.join(30)
    ta.join(30)
    assert codes == {"a": 0, "b": 0}


def test_abort_in_shown_drops_the_pin_and_keeps_the_ruling(net, tmp_path, monkeypatch, capsys):
    """a different c_N while X shows the fingerprint drops the pin X made."""
    a, b = tmp_path / "a", tmp_path / "b"
    ida, _ = login(monkeypatch, a), login(monkeypatch, b)
    cx = pa.Ctx(b)
    cx.setup()
    cx.refresh()
    with cx.store.state() as d:
        p = d["peers"][ida]
        pa.pin_peer(p, pa.b64d(p["sign_pub"]), pa.b64d(p["enc_pub"]), b"i" * 32)
        p["ruling"] = "denied"
        d["pairs"][ida] = pa.new_entry("X", "shown", b"r" * 32, b"c" * 32)
    pa.on_commit(cx, ida, b"d" * 32, "yes")
    p = state(b)["peers"][ida]
    assert state(b)["pairs"][ida]["c_N"] == pa.b64e(b"d" * 32)
    assert not p["pinned"] and p["pairing_id"] == "" and p["ruling"] == "none"  # the new request clears "denied"
    assert 'failed. Run: pusharmor pair %s to start again.' % pa.id_hex(ida)[:6] in capsys.readouterr().err


def pair_with_b_answer(monkeypatch, net, a, b, ida, idb, answer):
    """a confirms; b gets the fingerprint prompt and gives `answer`. Returns b's exit code."""
    monkeypatch.setattr(pa, "PAIR_WAIT_S", 8)

    def inp(prompt=""):
        return answer if threading.current_thread().name == "b" else "y"

    monkeypatch.setattr(pa, "input", inp, raising=False)
    codes = {}
    before = net.count(idb)
    ta = threading.Thread(target=lambda: codes.__setitem__("a", run(a, "pair", pa.id_hex(idb)[:6])), name="a")
    ta.start()
    end = time.time() + 10
    while net.count(idb) == before and time.time() < end:
        time.sleep(0.02)
    tb = threading.Thread(target=lambda: codes.__setitem__("b", run(b, "pair", pa.id_hex(ida)[:8])), name="b")
    tb.start()
    tb.join(30)
    ta.join(30)
    return codes["b"]


def test_failed_reject_says_could_not_reject(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    net.hooks[("POST", "deny")] = lambda *x: net.reply(500, {})
    capsys.readouterr()
    assert pair_with_b_answer(monkeypatch, net, a, b, ida, idb, "n") == pa.EXIT_TEMP
    name = pa.peer_label(state(b)["peers"][ida])
    assert 'error: Could not reject "%s". %s' % (name, pa.SERVER_DOWN) in capsys.readouterr().err.splitlines()


def test_failed_confirm_says_could_not_confirm(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    net.hooks[("POST", "approve")] = lambda *x: net.reply(200, {"r": "denied"})
    capsys.readouterr()
    assert pair_with_b_answer(monkeypatch, net, a, b, ida, idb, "y") == 1
    name = pa.peer_label(state(b)["peers"][ida])
    assert 'error: Could not confirm "%s". "%s" is not paired with this device.' % (name, name) \
        in capsys.readouterr().err.splitlines()


def test_rejected_device_is_hidden_until_it_asks_again_or_pair_id_runs(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    assert pair_with_b_answer(monkeypatch, net, a, b, ida, idb, "n") == 0
    assert state(b)["peers"][ida]["ruling"] == "denied"
    capsys.readouterr()
    assert run(b, "pair") == 0
    out = capsys.readouterr().out
    assert pa.id_hex(ida)[:6] not in out and "rejected" not in out and "this device" in out
    # pair ID still finds the hidden device and clears the denied state
    monkeypatch.setattr(pa, "PAIR_WAIT_S", 1)
    assert run(b, "pair", pa.id_hex(ida)[:8]) == 1
    assert state(b)["peers"][ida]["ruling"] == "none"
    capsys.readouterr()
    assert run(b, "pair") == 0
    assert pa.id_hex(ida)[:6] in capsys.readouterr().out


def test_incoming_request_shows_a_rejected_device_again(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = login(monkeypatch, a), login(monkeypatch, b)
    cx = pa.Ctx(b)
    cx.setup()
    cx.refresh()
    with cx.store.state() as d:
        d["peers"][ida]["ruling"] = "denied"
    capsys.readouterr()
    assert run(b, "pair") == 0
    assert pa.id_hex(ida)[:6] not in capsys.readouterr().out
    pa.on_commit(cx, ida, b"d" * 32, "yes")
    assert state(b)["peers"][ida]["ruling"] == "none"
    capsys.readouterr()
    assert run(b, "pair") == 0
    assert pa.id_hex(ida)[:6] in capsys.readouterr().out


def test_abort_then_decides_the_new_commit(net, tmp_path, monkeypatch, capsys):
    """a different c_N ends the old X entry; the new commit is then decided, not dropped."""
    a, b = tmp_path / "a", tmp_path / "b"
    ida, _ = login(monkeypatch, a), login(monkeypatch, b)
    cx = pa.Ctx(b)
    cx.setup()
    cx.refresh()
    with cx.store.state() as d:
        d["pairs"][ida] = pa.new_entry("X", "prompted", b"r" * 32, b"c" * 32)
    pa.on_commit(cx, ida, b"d" * 32, "yes")
    e = state(b)["pairs"][ida]
    assert e["role"] == "X" and e["c_N"] == pa.b64e(b"d" * 32)
    err = capsys.readouterr().err
    assert 'failed. Run: pusharmor pair %s to start again.' % pa.id_hex(ida)[:6] in err
    assert "wants to pair. Run: pusharmor pair %s" % pa.id_hex(ida)[:6] in err


def test_peer_list_opens_stored_remove_messages(net, tmp_path, monkeypatch, capsys):
    a, b, c = tmp_path / "a", tmp_path / "b", tmp_path / "c"
    ida, idb = pair_two(monkeypatch, net, a, b)
    idc = login(monkeypatch, c)
    pair_two(monkeypatch, net, b, c, (idb, idc))
    assert state(b)["peers"][idc]["ruling"] == "approved"
    # a removes c; the relay server keeps the remove for b, and b reads it from the peer list, not the push
    assert run(a, "pair") == 0  # a lists c
    answers(monkeypatch, "y")
    assert run(a, "delete", pa.id_hex(idc)[:6]) == 0
    m = net.peers[idb]["rm"].pop(idc)
    capsys.readouterr()
    # quiet drops: unreadable, and a remove that names another device; c stays, marked missing
    net.peers[idb]["rm"] = {idc: "x" * 50, ida: m}
    assert run(b, "pair") == 0
    assert state(b)["peers"][idc]["missing"] and net.peers[idb]["rm"] == {}
    err = capsys.readouterr().err
    assert "nvalid" not in err and "read" not in err
    # a fresh, valid remove(c) from a pinned peer applies
    net.peers[idb]["rm"] = {idc: m}
    assert run(b, "pair") == 0
    assert idc not in state(b)["peers"] and ida in state(b)["peers"]
    assert "\" was removed from your account.\n" in capsys.readouterr().err


@pytest.mark.skipif(os.name == "nt", reason="stdout is always UTF-8 on Windows")
def test_listen_keeps_a_message_it_could_not_show(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    assert run(a, "send", "caf\u00e9 one") == 0
    net.stop.set()
    capsys.readouterr()
    real = sys.stdout
    monkeypatch.setattr(sys, "stdout", BrokenOut())  # listen | head -0
    assert run(b, "listen", "--tsv") == 1
    raw = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(raw, encoding="ascii"))  # LANG=C
    assert run(b, "listen", "--tsv") == 130
    sys.stdout.flush()
    monkeypatch.setattr(sys, "stdout", real)
    assert raw.getvalue().decode().split("\t")[4] == "caf? one"
    assert capsys.readouterr().err.count("Listening.") == 2
    assert run(b, "listen", "--tsv") == 130
    assert capsys.readouterr().out == ""


@pytest.mark.skipif(os.name == "nt", reason="the notify program is a shell script")
def test_listen_exec_replaces_nul_and_lone_surrogates(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    orig = pa.msg_json
    monkeypatch.setattr(pa, "msg_json", lambda n, t, v: orig(n, t, "a\x00b\ud800" if v == "zz" else v))
    assert run(a, "send", "zz") == 0
    monkeypatch.setattr(pa, "msg_json", orig)
    out, prog = tmp_path / "out", tmp_path / "prog"
    prog.write_text('#!/bin/sh\nprintf %%s "$5" >> "%s"\n' % out)
    prog.chmod(0o755)
    net.stop.set()
    assert run(b, "listen", "--exec", str(prog)) == 130
    assert out.read_bytes().decode() == "a\ufffdb\ufffd"
    assert run(b, "listen", "--exec", str(prog)) == 130
    assert out.read_bytes().decode() == "a\ufffdb\ufffd"


@pytest.mark.skipif(os.name == "nt", reason="the notify program is a shell script")
def test_listen_exec_program_output_is_prefixed_line_by_line(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    assert run(a, "send", "one") == 0
    assert run(a, "send", "two") == 0
    prog, gate = tmp_path / "prog", tmp_path / "gate"
    # the first line must reach stdout before the program goes on: it waits for the test to see it
    prog.write_text('#!/bin/sh\necho "out $5"\ni=0\nwhile [ "$5" = one ] && [ ! -e "%s" ] && [ $i -lt 500 ]; do\n'
                    '  sleep 0.01; i=$((i + 1))\ndone\n[ -e "%s" ] || echo late\nprintf "err\\r\\nlast" >&2\n'
                    % (gate, gate))
    prog.chmod(0o755)
    seen = []

    class Out(io.StringIO):
        def write(self, s):
            if s.startswith("cmd: out one"):
                seen.append(s)
                gate.touch()
            return super().write(s)

    net.stop.set()
    capsys.readouterr()
    out = Out()
    monkeypatch.setattr(sys, "stdout", out)
    assert run(b, "listen", "--exec", str(prog)) == 130
    assert seen and out.getvalue() == "cmd: out one\ncmd: out two\n"
    err = capsys.readouterr().err.splitlines()
    assert [x for x in err if x.startswith("cmd: ")] == ["cmd: err", "cmd: last"] * 2
    assert all(x.startswith(("cmd: ", "info: ")) for x in err)


@pytest.mark.skipif(os.name == "nt", reason="the notify program is a shell script")
def test_listen_exec_silent_program_prints_nothing(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    assert run(a, "send", "one") == 0
    prog = tmp_path / "prog"
    prog.write_text("#!/bin/sh\nexit 0\n")
    prog.chmod(0o755)
    net.stop.set()
    capsys.readouterr()
    assert run(b, "listen", "--exec", str(prog)) == 130
    cap = capsys.readouterr()
    assert cap.out == "" and not any(x.startswith("cmd:") for x in cap.err.splitlines())


def test_send_reads_a_bounded_amount_of_stdin(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    big = Stdin(tty=False, data=b"x" * (3 << 20))
    monkeypatch.setattr(sys, "stdin", big)
    assert run(tmp_path, "send") == 2
    assert "The message is longer than 2048 characters." in capsys.readouterr().err
    assert big.buffer.tell() == pa.CONTENT_CAP * 4 + 1
    monkeypatch.setattr(sys, "stdin", Stdin(tty=False, data=b"y" * 100 + b"\n"))
    assert run(tmp_path, "send") == 4
    assert "No device is paired yet. Run pusharmor pair to pair one." in capsys.readouterr().err


def test_pair_timeouts_quote_the_device_name(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    login(monkeypatch, a)
    idb = login(monkeypatch, b)
    monkeypatch.setattr(pa, "PAIR_WAIT_S", 0.5)
    assert run(a, "pair", pa.id_hex(idb)[:6]) == 1
    d = state(a)
    d["peers"][idb].update(name="bee", pinned=True)
    d["pairs"][idb]["started"] -= 15 * 86400
    (a / "devices.toml").write_text(pa.toml_dumps(d))
    capsys.readouterr()
    assert run(a, "pair", pa.id_hex(idb)[:6]) == 1
    err = capsys.readouterr().err
    assert 'Pairing with "bee" timed out. Run: pusharmor pair %s to start again.\n' % pa.id_hex(idb)[:6] in err
    assert '"bee" has not answered yet. Run pusharmor pair %s again to continue.\n' % pa.id_hex(idb)[:6] in err


@pytest.mark.skipif(os.name == "nt", reason="no POSIX modes on Windows")
def test_chmod_hint_quotes_a_path_with_a_space(tmp_path):
    path = tmp_path / "my cfg"
    path.mkdir()
    path.chmod(0o777)
    with pytest.raises(pa.Fail) as e:
        pa.check_unshared(str(path), True)
    assert str(e.value) == "'%s' can be changed by other users. Run: chmod go-w '%s'" % (path, path)


def test_wipe_removes_temp_files(net, tmp_path, monkeypatch):
    login(monkeypatch, tmp_path)
    (tmp_path / "keys" / ".tmp-x").write_text("key")
    (tmp_path / ".tmp-y").write_text("state")
    pa.Store(str(tmp_path)).wipe()
    assert not (tmp_path / "keys").exists()
    assert [n for n in os.listdir(tmp_path) if n.startswith(".tmp-")] == []


def test_wipe_clears_the_target_of_a_symlinked_devices_toml(net, tmp_path, monkeypatch):
    root, other = tmp_path / "root", tmp_path / "other"
    other.mkdir()
    root.mkdir()
    login(monkeypatch, root)
    target = other / "real.toml"
    os.replace(root / "devices.toml", target)
    os.symlink(target, root / "devices.toml")
    assert target.read_text() != ""
    (other / ".tmp-z").write_text("state")
    pa.Store(str(root)).wipe()
    assert os.path.islink(root / "devices.toml")
    assert pa.read_toml(str(target)) == {"version": pa.STATE_VERSION}
    assert [n for n in os.listdir(other) if n.startswith(".tmp-")] == []
    login(monkeypatch, root)
    assert pa.read_toml(str(target))["version"] == pa.STATE_VERSION


def _group(monkeypatch, name, members):
    import grp
    import pwd
    from types import SimpleNamespace
    monkeypatch.setattr(pwd, "getpwuid", lambda uid: SimpleNamespace(pw_name="me", pw_dir=str(HERE)))
    monkeypatch.setattr(grp, "getgrgid", lambda gid: SimpleNamespace(gr_name=name, gr_mem=members))


@pytest.mark.skipif(os.name == "nt", reason="no POSIX modes or groups on Windows")
@pytest.mark.parametrize("name, members", [
    ("me", []), ("me", ["me"]), ("staff", []), ("me", ["other"]), ("me", ["me", "other"])])
def test_group_writable_is_refused_even_with_a_user_private_group(name, members, net, tmp_path, monkeypatch, capsys):
    cfg = tmp_path / "my cfg"
    login(monkeypatch, cfg)
    _group(monkeypatch, name, members)
    for path in (cfg, cfg / "devices.toml"):
        path.chmod(0o775 if path == cfg else 0o664)
        capsys.readouterr()
        assert run(cfg, "send", "hi") == 1
        assert capsys.readouterr().err == (
            "error: '%s' can be changed by other users. Run: chmod go-w '%s'\n" % (path, path))
        path.chmod(0o700 if path == cfg else 0o600)


@pytest.mark.skipif(os.name == "nt", reason="no POSIX modes on Windows")
def test_saving_keys_checks_the_config_folder(tmp_path):
    root = tmp_path / "cfg"
    root.mkdir()
    root.chmod(0o777)
    k = {"id": pa.b64e(b"i" * 30), "sign": b"s" * 32, "enc": b"e" * 32, "push": b"p" * 32, "auth": b"a" * 16}
    with pytest.raises(pa.Fail) as e:
        pa.Store(str(root)).save_keys(k)
    assert str(e.value) == "'%s' can be changed by other users. Run: chmod go-w '%s'" % (root, root)
    assert not (root / "keys").exists()


@pytest.mark.skipif(os.name == "nt", reason="no POSIX owners on Windows")
def test_a_config_file_owned_by_another_user_is_refused(tmp_path, monkeypatch):
    path = tmp_path / "devices.toml"
    path.write_text("")
    path.chmod(0o600)
    uid = os.getuid()
    monkeypatch.setattr(pa.os, "getuid", lambda: uid + 1)
    with pytest.raises(pa.Fail) as e:
        pa.check_unshared(str(path), False)
    assert str(e.value) == "'%s' must be a file that you own." % path


def test_wipe_waits_for_a_state_write_and_is_not_written_back(net, tmp_path, monkeypatch):
    login(monkeypatch, tmp_path)
    one, two = pa.Store(str(tmp_path)), pa.Store(str(tmp_path))
    with one.state() as d:
        t = threading.Thread(target=two.wipe)
        t.start()
        time.sleep(0.3)
        assert t.is_alive() and (tmp_path / "keys" / "private.toml").exists()
        d["name"] = "zz"
    t.join(5)
    assert not t.is_alive()
    assert not (tmp_path / "keys").exists() and not (tmp_path / "devices.toml").exists()
    assert (tmp_path / "devices.toml.lock").exists()
    with pytest.raises(pa.Fail) as e:
        with one.state() as d:
            d["name"] = "yy"
    assert str(e.value) == pa.NOT_LOGGED_IN and e.value.code == pa.EXIT_LOGIN
    assert not (tmp_path / "devices.toml").exists()
    assert [n for n in os.listdir(tmp_path) if n.startswith(".tmp-")] == []


@pytest.mark.skipif(os.name == "nt", reason="no POSIX modes on Windows")
def test_config_folder_and_state_files_others_can_change_are_refused(net, tmp_path, monkeypatch, capsys):
    cfg = tmp_path / "cfg"
    old = os.umask(0)
    try:
        login(monkeypatch, cfg)
    finally:
        os.umask(old)
    assert stat.S_IMODE(os.stat(cfg).st_mode) == 0o700
    capsys.readouterr()
    cfg.chmod(0o777)
    assert run(cfg, "send", "hi") == 1
    assert capsys.readouterr().err == (
        "error: '%s' can be changed by other users. Run: chmod go-w '%s'\n" % (cfg, cfg))
    _group(monkeypatch, "me", [])
    cfg.chmod(0o775)  # group-writable, even with the user's own private primary group: refused
    assert run(cfg, "send", "hi") == 1
    assert "can be changed by other users" in capsys.readouterr().err
    cfg.chmod(0o700)
    for name in ("devices.toml", "settings.toml"):
        path = cfg / name
        if not path.exists():
            path.write_text("")
        path.chmod(0o666)
        capsys.readouterr()
        assert run(cfg, "send", "hi") == 1
        assert capsys.readouterr().err == (
            "error: '%s' can be changed by other users. Run: chmod go-w '%s'\n" % (path, path))
        path.chmod(0o644)
    assert run(cfg, "send", "hi") == 4


@pytest.mark.skipif(os.name == "nt", reason="checks POSIX modes of link targets")
def test_symlinked_config_folder_files_and_chains_are_followed(net, tmp_path, monkeypatch, capsys):
    real = tmp_path / "dotfiles" / "pusharmor"
    login(monkeypatch, real)
    store = tmp_path / "store"
    store.mkdir(mode=0o700)
    os.replace(real / "devices.toml", store / "devices.toml")
    os.replace(real / "keys", store / "keys")
    (store / "settings.toml").write_text("")
    (store / "settings.toml").chmod(0o600)
    (real / "keys").symlink_to(store / "keys")
    (real / "settings.toml").symlink_to(store / "settings.toml")
    (store / "devices-link").symlink_to(store / "devices.toml")
    (real / "devices.toml").symlink_to(store / "devices-link")  # a chain of two links
    cfg = tmp_path / "cfg"
    cfg.symlink_to(real)
    top = tmp_path / "top"
    top.symlink_to(cfg)  # the folder through a chain of two links
    capsys.readouterr()
    assert run(top, "send", "hi") == 4
    assert run(top, "rename", "zz") == 0
    assert os.path.islink(real / "devices.toml") and state(store)["name"] == "zz"
    assert [n for n in os.listdir(real) if n.startswith(".tmp-")] == []
    for name in ("devices.toml", "settings.toml"):  # the target gets the same check as a file
        (store / name).chmod(0o666)
        capsys.readouterr()
        assert run(top, "send", "hi") == 1
        assert capsys.readouterr().err == "error: '%s' can be changed by other users. Run: chmod go-w '%s'\n" % (
            top / name, top / name)
        (store / name).chmod(0o600)
    real.chmod(0o777)
    assert run(top, "send", "hi") == 1
    assert "can be changed by other users" in capsys.readouterr().err
    real.chmod(0o700)
    assert run(top, "send", "hi") == 4


def test_unsupported_toml_value_is_damaged(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    path = tmp_path / "devices.toml"
    path.write_text("x = 1.5\n" + path.read_text())
    capsys.readouterr()
    assert run(tmp_path, "send", "hi") == 1
    assert capsys.readouterr().err == "error: The file '%s' is damaged. Delete it and log in again.\n" % path


@pytest.mark.parametrize("prog", ["/nonexistent/notify", "pusharmor-no-such-notify", pytest.param(
    "NOEXEC", marks=pytest.mark.skipif(os.name == "nt", reason="no execute bit on Windows"))])
def test_listen_exec_missing_program_keeps_the_message(net, tmp_path, monkeypatch, capsys, prog):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    if prog == "NOEXEC":
        prog = str(tmp_path / "noexec")
        open(prog, "w").close()
    assert run(a, "send", "keep me") == 0
    net.stop.set()
    since = state(b).get("since", "")
    capsys.readouterr()
    assert run(b, "listen", "--exec", prog) == 2
    assert capsys.readouterr().err == 'error: The notify program "%s" was not found or cannot be run.\n' % prog
    assert state(b).get("since", "") == since
    assert run(b, "listen", "--json") == 130
    assert [json.loads(x)["body"] for x in capsys.readouterr().out.splitlines()] == ["keep me"]


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


def test_closed_stdin(net, tmp_path, monkeypatch, capsys):
    me = login(monkeypatch, tmp_path)
    monkeypatch.setattr(sys, "stdin", None)  # pusharmor ... <&-
    assert run(tmp_path, "send") == 2 and run(tmp_path, "send", "-") == 2
    assert run(tmp_path, "pair", "abcdef") == 2 and run(tmp_path / "new", "login") == 2
    assert run(tmp_path, "delete", pa.id_hex(me)[:8]) == 2
    assert "Traceback" not in capsys.readouterr().err


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
    assert "Removing needs your answer in a terminal. Add --yes to remove without asking." in capsys.readouterr().err
    assert pid in net.peers
    assert run(tmp_path, "delete", pa.id_hex(pid)[:6], "--yes") == 0
    assert pid not in net.peers


def test_send_failures_are_sentences(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = pair_two(monkeypatch, net, a, b)
    capsys.readouterr()
    for word, text in [("failed:net", pa.SEND_FAILED), ("logged out", pa.SEND_WHY["logged out"])]:
        net.hooks[("POST", "send")] = lambda m, p, h, body, w=word: net.reply(200, {"r": {idb: w}})
        assert run(a, "send", "hi") == 4
        err = capsys.readouterr().err
        assert "error: " + text % pa.peer_label(state(a)["peers"][idb]) + "\n" in err and ": " + word not in err


def test_relay_error_text_is_cleaned_and_short(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = pair_two(monkeypatch, net, a, b)
    capsys.readouterr()
    for status, word in ((400, "\x1b]0;x\x07bad\u202e"), (401, "w" * 200)):
        net.hooks[("POST", "send")] = lambda m, p, h, body, s=status, w=word: net.reply(s, {"error": w})
        assert run(a, "send", "hi") == 1
        err = capsys.readouterr().err
        assert "\x1b" not in err and "\x07" not in err and "\u202e" not in err
        assert "bad" not in err and "www" not in err
        assert err.splitlines() == ["error: " + pa.REFUSED]
    net.hooks.clear()
    e = pa.ApiError(400, "\x1b[2Jbad", {})
    assert e.error == "?[2Jbad"


def test_send_too_long(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    assert run(tmp_path, "send", "x" * 2049) == 2
    assert capsys.readouterr().err.splitlines() == ["error: The message is longer than 2048 characters."]


# ---- listen output ----

REC = {"from": "ab" * 21, "name": "Pixel", "platform": "android", "type": "text", "body": "a\tb\nc\\d\x1b",
       "date": "2026-10-30T12:00:00Z"}


def test_format_json_and_tsv():
    assert json.loads(pa.format_record(REC, "json")) == REC
    assert pa.format_record(REC, "tsv") == "\t".join(["ab" * 21, "Pixel", "android", "text", "a\\tb\\nc\\\\d\\u001b",
                                                       "2026-10-30T12:00:00Z"])


def test_tsv_escapes_controls_and_json_is_ascii():
    for raw, esc in (("a\u2028b", "a\\u2028b"), ("\x9b", "\\u009b"), ("\x7f", "\\u007f"),
                     ("\u202e", "\\u202e"), ("\u2069\u061c", "\\u2069\\u061c"), ("\u00e9", "\u00e9")):
        assert pa.format_record(dict(REC, body=raw), "tsv").split("\t")[4] == esc
    line = pa.format_record(dict(REC, body="\u00e9\u202e"), "json")
    assert "\\u00e9" in line and all(ord(c) < 128 for c in line)
    assert json.loads(line)["body"] == "\u00e9\u202e"
    seen = []

    def popen(argv, **kw):
        seen.append(argv)
        raise OSError(2, "No such file or directory")

    with pytest.MonkeyPatch.context() as m:
        m.setattr(pa.subprocess, "Popen", popen)
        pa.run_exec("prog", dict(REC, body="\u00e9\u202e\x1b"))
    assert seen[0][-1] == "\u00e9\u202e\x1b"


def test_format_blocks():
    out = pa.format_record(REC, "blocks").splitlines()
    assert out[0] == "From: ababab Pixel" and out[1] == "Platform: Android" and out[2] == "Type: text"
    assert out[3].startswith("Date: ") and out[4] == "Body: a\tb" and out[5] == " c\\d?"


def test_format_blocks_drops_bidi_and_line_separators():
    rec = dict(REC, body="a\u202eb\u2066c\u2028d\u061ce")
    out = pa.format_record(rec, "blocks")
    for ch in ("\u202e", "\u2066", "\u2028", "\u061c"):
        assert ch not in out
    assert "Body: a?b?c?d?e" in out


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
    assert "Traceback" not in err
    if rel == os.path.join("keys", "private.toml"):
        assert err.splitlines() == ["error: This device's keys have become unusable. Delete '%s', then log in again. "
                                    "You will then pair with all your devices again." % (cfg / "keys")]
        assert path.read_bytes() == data
    else:
        assert len(err.splitlines()) == 1 and "Unable" not in err and str(path) in err


@pytest.mark.parametrize("change", [
    lambda d: d.pop("name"), lambda d: d.pop("topic"), lambda d: d.update(peers=[]), lambda d: d.update(ntfy=1),
    lambda d: d.update(my_allow=[1]), lambda d: d.update(since=5), lambda d: d.update(peers={"x": 1}),
    lambda d: d.update(peers={"x": {"pinned": True}}), lambda d: d.update(pairs={"x": {"role": "N"}})])
def test_damaged_state_shape_is_one_line_exit_1(change, monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    path = cfg / "devices.toml"
    d = pa.toml_loads(path.read_text())
    change(d)
    path.write_text(pa.toml_dumps(d))
    capsys.readouterr()
    for argv in (["send", "hi"], ["pair"], ["listen"], ["rename", "zz"], ["logout"]):
        assert run(cfg, *argv) == 1
        assert capsys.readouterr().err == "error: The file '%s' is damaged. Delete it and log in again.\n" % path


def test_a_new_login_replaces_a_damaged_devices_file_and_never_removes_the_device(net, tmp_path, monkeypatch, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    shutil.rmtree(cfg / "keys")
    (cfg / "devices.toml").write_bytes(b"not = [valid toml")
    n = len(net.log)
    login(monkeypatch, cfg)
    assert [m for m, _ in net.log[n:] if m == "DELETE"] == []
    assert state(cfg)["reg"] == "registered"


@pytest.mark.skipif(os.name == "nt", reason="runs the hint in a POSIX shell")
@pytest.mark.parametrize("change", [
    lambda d: d.update(sign_key=pa.b64e(b"\x01" * 31)), lambda d: d.update(enc_key="not*base64"),
    lambda d: d.pop("version")])
def test_unusable_keys_are_one_line_and_kept(change, monkeypatch, tmp_path, net, capsys):
    cfg = tmp_path / "my cfg"
    login(monkeypatch, cfg)
    d0 = state(cfg)
    d0["name"] = "stale"
    (cfg / "devices.toml").write_text(pa.toml_dumps(d0))
    path = cfg / "keys" / "private.toml"
    d = pa.toml_loads(path.read_text())
    change(d)
    path.write_text(pa.KEY_HEADER + pa.toml_dumps(d))
    path.chmod(0o600)
    before = path.read_bytes()
    capsys.readouterr()
    assert run(cfg, "send", "hi") == 1
    err = capsys.readouterr().err
    assert err == (
        "error: This device's keys have become unusable. Delete '%s', then log in again. "
        "You will then pair with all your devices again.\n" % (cfg / "keys"))
    assert path.read_bytes() == before
    import subprocess
    subprocess.run(["sh", "-c", "rm -r " + err.split("Delete ")[1].split(", then")[0]], check=True)
    assert sorted(os.listdir(cfg)) == ["devices.toml", "devices.toml.lock"]
    answers(monkeypatch, "x", "x", "x")  # a login that fails leaves the old devices.toml as it is
    assert run(cfg, "login") == 1 and state(cfg)["name"] == "stale"
    login(monkeypatch, cfg)  # the new login replaces it
    assert state(cfg)["name"] != "stale" and state(cfg)["reg"] == "registered"


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
    assert err == "error: '%s' must be a file that you own.\n" % (cfg / "devices.toml")


@pytest.mark.skipif(os.name == "nt", reason="Windows words these OS errors differently")
def test_config_path_that_is_a_file_or_too_long(monkeypatch, tmp_path, capsys):
    f = tmp_path / "file"
    f.write_text("x")
    monkeypatch.setenv("PUSHARMOR_CONFIG", str(f))
    assert pa.main(["logout"]) == 1
    assert capsys.readouterr().err == "error: Cannot read or write '%s': File exists.\n" % f
    monkeypatch.setenv("PUSHARMOR_CONFIG", str(tmp_path / ("a" * 5000)))
    assert pa.main(["logout"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("error: Cannot read or write '") and err.endswith(": File name too long.\n")


@pytest.mark.skipif(os.name == "nt" or os.getuid() == 0, reason="root reads any file; no file modes on Windows")
def test_file_without_permission(monkeypatch, tmp_path, net, capsys):
    cfg = _logged_in(monkeypatch, tmp_path, net)
    (cfg / "devices.toml").chmod(0)
    capsys.readouterr()
    assert run(cfg, "send", "hi") == 1
    assert capsys.readouterr().err == "error: Cannot read or write '%s': Permission denied.\n" % (
        cfg / "devices.toml")


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
        assert p.returncode == 1 and p.stderr == b"error: Storage is full. Free some space and try again.\n"
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
    assert capsys.readouterr().err == "error: PushArmor stopped on an unexpected error (TypeError: bad value).\n"


@pytest.mark.skipif(os.name == "nt", reason="stdout is always UTF-8 on Windows")
def test_output_the_terminal_cannot_show(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(pa.COMMANDS, "logout", (lambda cx, args: print("caf\u00e9"), "", []))
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="ascii"))
    assert run(tmp_path, "logout") == 1
    assert "This terminal cannot show some characters. Set LANG=C.UTF-8 and try again." in capsys.readouterr().err


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


def test_cut_off_success_body_is_a_network_failure():
    def reply(h):
        h.send_response(200)
        h.send_header("Content-Length", "1000")
        h.end_headers()
        h.wfile.write(b"{")
        h.close_connection = True

    with local_http(reply) as url:
        with pytest.raises(OSError):
            pa.http_request("GET", url + "/v1/peers", {}, None)


@pytest.mark.parametrize("code", [200, 500])
def test_huge_reply_is_a_network_failure(code):
    def reply(h):
        h.send_response(code)
        h.send_header("Content-Length", str(2 << 20))
        h.end_headers()
        with contextlib.suppress(OSError):
            h.wfile.write(b" " * (2 << 20))

    with local_http(reply) as url:
        with pytest.raises(OSError):
            pa.http_request("GET", url + "/v1/peers", {}, None)


def test_error_body_is_read_with_a_size_bound(monkeypatch):
    import urllib.error
    sizes = []

    class Body(io.BytesIO):
        def read(self, n=-1):
            sizes.append(n)
            return super().read(n)

    class Opener:
        def open(self, req, timeout):
            raise urllib.error.HTTPError(req.full_url, 500, "x", {}, Body(b" " * (pa.MAX_REPLY + 10)))

    monkeypatch.setattr(pa, "_OPENER", Opener())
    with pytest.raises(OSError):
        pa.http_request("GET", "https://h/v1/peers", {}, None)
    assert sizes == [pa.MAX_REPLY + 1]


def test_redirect_is_not_followed():
    hits = []

    def target(h):
        hits.append(h.path)
        h.send_response(200)
        h.send_header("Content-Length", "2")
        h.end_headers()
        h.wfile.write(b"{}")

    with local_http(target) as other:
        def reply(h):
            h.send_response(302)
            h.send_header("Location", other + "/v1/peers")
            h.send_header("Content-Length", "0")
            h.end_headers()

        with local_http(reply) as url:
            status, _, _ = pa.http_request("GET", url + "/v1/peers", {"PA-Sig": "x"}, None)
    assert status == 302 and hits == []


@pytest.mark.parametrize("server", ["http://[::1", "http://a..b", "https://" + "a" * 64 + ".com", "https://h:99999",
                                    "https://\\u0080"])
def test_bad_server_setting(tmp_path, server, capsys):
    (tmp_path / "settings.toml").write_text('server = "%s"\n' % server)
    assert run(tmp_path, "send", "hi") == 1
    assert capsys.readouterr().err == ('error: The setting "server" in \'%s\' must be a web address that starts with '
                                       "https://, such as https://example.com.\n" % (tmp_path / "settings.toml"))


@pytest.mark.parametrize("key", ["server", "ntfy"])
def test_plain_http_only_for_loopback(tmp_path, key, capsys):
    path = tmp_path / "settings.toml"
    for url in ("http://example.com", "http://10.0.0.1:8080", "http://localhost.example.com"):
        path.write_text('%s = "%s"\n' % (key, url))
        with pytest.raises(pa.Fail) as e:
            pa.Store(str(tmp_path)).settings()
        assert str(e.value) == ('The setting "%s" in \'%s\' must be a web address that starts with https://, '
                                "such as https://example.com." % (key, path))
    for url in ("http://127.0.0.1:8080", "http://[::1]:1", "http://localhost:9", "https://example.com"):
        path.write_text('%s = "%s"\n' % (key, url))
        assert pa.Store(str(tmp_path)).settings()[key] == url


@pytest.mark.parametrize("url", ["http://192.168.1.5", "http://10.0.0.1:8080", "http://172.16.0.1", "http://[fc00::1]"])
def test_plain_http_ntfy_on_a_private_network_is_refused(url, tmp_path):
    path = tmp_path / "settings.toml"
    for key in ("ntfy", "server"):
        path.write_text('%s = "%s"\n' % (key, url))
        with pytest.raises(pa.Fail):
            pa.Store(str(tmp_path)).settings()
    path.write_text('ntfy = "http://127.0.0.1:8080"\n')
    assert pa.Store(str(tmp_path)).settings()["ntfy"] == "http://127.0.0.1:8080"


def test_bad_redirect_is_a_network_error():
    def reply(h):
        h.send_response(302)
        h.send_header("Location", "http://[::1")
        h.send_header("Content-Length", "0")
        h.end_headers()

    with local_http(reply) as url:
        with pytest.raises(OSError):
            pa.http_request("GET", url + "/v1/peers", {}, None)
        with pytest.raises(OSError):
            pa.ntfy_open(url + "/up0/json", 5)


def test_too_deep_nesting(monkeypatch, tmp_path, capsys):
    deep = b"[" * 100000 + b"]" * 100000
    monkeypatch.setattr(pa, "http_request", lambda *a: (200, {}, deep))
    assert pa.Api("https://r.example", {"id": "x", "sign": pa.new_key()[0]}).call("GET", "/v1/peers") == {}
    with contextlib.suppress(ValueError):  # newer Pythons parse it; older ones must not raise RecursionError
        pa.parse_strict(b'{"a":' + deep + b"}")

    class Lines:
        def __init__(self, lines):
            self.lines = lines

        def readline(self, *limit):
            return self.lines.pop(0) if self.lines else b""

        def close(self):
            pass

    s = pa.Stream("https://ntfy.example", "up0", {}, "", 5, poll=True)
    monkeypatch.setattr(s, "connect", lambda: setattr(s, "resp", Lines([b'{"a":' + deep + b"}\n"])))
    assert s.next(time.time() + 5) is None
    (tmp_path / "settings.toml").write_text("a = " + "[" * 100000)
    assert run(tmp_path, "send", "hi") == 1
    assert capsys.readouterr().err == "error: The file '%s' has a mistake (nested too deeply). Fix it or delete it.\n" % (
        tmp_path / "settings.toml")


@pytest.mark.parametrize("allow", [None, 5, "x", {"a": 1}])
def test_odd_peer_list_from_the_relay_server(allow, net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    s, e = pa.new_key()[1], pa.new_key()[1]
    pid = pa.b64e(helpers.peer_id(fake_relay.ID_SECRET, fake_relay.ACCOUNT, pa.keyhash(s, e)))
    peers = [{"id": pid, "sign_pub": pa.b64e(s), "enc_pub": pa.b64e(e), "platform": "ios", "created": 10 ** 18}]
    body = json.dumps({"my_allow": allow, "peers": peers}).encode()
    net.hooks[("GET", "peers")] = lambda *a: (200, {}, body)
    capsys.readouterr()
    assert run(tmp_path, "pair") == 0
    assert "iPhone device added Jan 1" in capsys.readouterr().out
    assert pa.gmtime(-10 ** 18).tm_year == 1970


def test_ntfy_line_over_the_cap_is_skipped(monkeypatch, capsys):
    ok = b'{"event":"message","id":"ok","message":"x"}\n'
    big = b'{"event":"message","id":"big","message":"' + b"a" * 300000 + b'"}\n'
    s = pa.Stream("https://ntfy.example", "up0", {}, "", 5, poll=True)
    monkeypatch.setattr(s, "connect", lambda: setattr(s, "resp", io.BytesIO(ok + big + big)))
    assert s.next(time.time() + 5) is None
    assert s.since == "ok"


def test_counter_n_limits():
    assert pa.counter_n(pa._Num("1" * 5000)) is None
    assert pa.counter_n(pa._Num("9007199254740991")) == 2 ** 53 - 1
    assert pa.counter_n(pa._Num("9007199254740992")) is None


def test_non_string_peer_id_from_the_relay_server(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    body = json.dumps({"my_allow": [], "peers": [{"id": []}, {"id": 5}]}).encode()
    net.hooks[("GET", "peers")] = lambda *a: (200, {}, body)
    capsys.readouterr()
    assert run(tmp_path, "pair") == 0


def test_odd_strings_from_the_relay_server_are_dropped(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    s, e = pa.new_key()[1], pa.new_key()[1]
    pid = pa.b64e(helpers.peer_id(fake_relay.ID_SECRET, fake_relay.ACCOUNT, pa.keyhash(s, e)))
    peers = [{"id": pid, "sign_pub": pa.b64e(s), "enc_pub": pa.b64e(e), "platform": "\ud800", "created": 10}]
    body = json.dumps({"my_allow": ["a b", "\ud800", 5, "/../x", pid, pid], "peers": peers}).encode()
    net.hooks[("GET", "peers")] = lambda *a: (200, {}, body)
    capsys.readouterr()
    assert run(tmp_path, "pair") == 0
    assert "Traceback" not in capsys.readouterr().err
    assert pa._ids(["a b", "\ud800", 5, pid, pid]) == [pid]
    assert (tmp_path / "devices.toml").exists()


def test_choose_evict_ignores_unicode_digits(monkeypatch, capsys):
    rows = [{"id": "A" * 40, "platform": "ios", "created": 10}]
    monkeypatch.setattr(pa, "ask", lambda prompt="": "\u00b2 \u0663")
    with pytest.raises(pa.Fail):
        pa.choose_evict(rows)


def test_bad_id_in_register_reply(net, tmp_path, monkeypatch, capsys):
    net.hooks[("POST", "peers")] = lambda *a: net.reply(200, {"id": "!!"})
    answers(monkeypatch, "  `" + CODE + "`  ")
    capsys.readouterr()
    assert run(tmp_path, "login") == 1
    assert "The relay server sent a reply this device cannot use." in capsys.readouterr().err


def test_log_with_closed_stderr_writes_nothing(monkeypatch, capsys):
    monkeypatch.setattr(sys, "stderr", None)
    pa.log("info", "a note")
    assert capsys.readouterr().out == ""


def test_stream_socket_timeout_reconnects_without_delay(monkeypatch):
    class Timeout(OSError):
        """Stands for socket.timeout on Python 3.9, where it is not TimeoutError."""

    class Resp:
        def readline(self, cap):
            raise Timeout("timed out")

        def close(self):
            pass

    monkeypatch.setattr(pa.socket, "timeout", Timeout)
    s = pa.Stream("https://ntfy.example", "up0", {}, "", 5, poll=True)
    seen = []
    orig = s.close
    monkeypatch.setattr(s, "connect", lambda: setattr(s, "resp", Resp()))
    monkeypatch.setattr(s, "close", lambda delay: (seen.append(delay), orig(delay)))
    s.next(time.time() + 0.2)
    assert seen and set(seen) == {False}


@pytest.mark.skipif(os.name == "nt", reason="Windows uses APPDATA")
def test_config_dir_with_empty_home(monkeypatch):
    monkeypatch.setenv("HOME", "")
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.delenv("PUSHARMOR_CONFIG", raising=False)
    d = pa.config_dir()
    assert d.endswith("/.config/pusharmor") and d != "/.config/pusharmor"


@pytest.mark.skipif(os.name == "nt", reason="no directory fsync on Windows")
def test_write_file_syncs_the_directory(monkeypatch, tmp_path):
    kinds = []
    real = os.fsync
    monkeypatch.setattr(os, "fsync", lambda fd: (kinds.append(stat.S_ISDIR(os.fstat(fd).st_mode)), real(fd)))
    pa.write_file(str(tmp_path / "f"), "x")
    assert kinds == [False, True]


def test_sweep_expires_pairings_after_14_days(tmp_path):
    import types
    cx = types.SimpleNamespace(store=pa.Store(str(tmp_path)))
    (tmp_path / "keys").mkdir()
    (tmp_path / "keys" / "private.toml").write_text("")
    now = int(time.time())
    with cx.store.state() as d:
        for name, started in (("old", now - 15 * 86400), ("young", now - 13 * 86400), ("future", now + 40 * 86400)):
            d["pairs"][name] = pa.new_entry("X", "shown", b"r" * 32, b"c" * 32)
            d["pairs"][name]["started"] = started
    pa.sweep(cx)
    with cx.store.state(write=False) as d:
        assert sorted(d["pairs"]) == ["future", "young"]
        assert now <= d["pairs"]["future"]["started"] <= int(time.time())
    assert pa.PAIR_TIMEOUT_DAYS == 14


def test_login_after_remote_removal_drops_the_keys_and_registers_fresh(net, tmp_path, monkeypatch, capsys):
    me = login(monkeypatch, tmp_path)
    answers(monkeypatch)
    assert run(tmp_path, "logout") == 0 and state(tmp_path)["reg"] == "logged_out"
    del net.peers[me]  # removed from another device while logged out
    capsys.readouterr()
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == pa.EXIT_LOGIN
    assert pa.REMOVED in capsys.readouterr().err
    assert not os.path.exists(tmp_path / "keys" / "private.toml")
    n = len(net.log)
    answers(monkeypatch, CODE)
    assert run(tmp_path, "login") == 0 and state(tmp_path)["reg"] == "registered"
    assert ("POST", "/v1/peers") in net.log[n:]


def _down(*a):
    raise OSError("network down")


@pytest.mark.parametrize("check, code, kept", [
    (None, pa.EXIT_TEMP, True),  # the relay server still lists this device
    ("unknown peer", pa.EXIT_LOGIN, False),
    (_down, pa.EXIT_TEMP, True),
])
def test_unknown_device_is_confirmed_before_the_keys_are_deleted(check, code, kept, net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    net.hooks[("PATCH", "peers")] = lambda *a: net.reply(401, {"error": "unknown peer"})
    if check == "unknown peer":
        net.hooks[("GET", "peers")] = lambda *a: net.reply(401, {"error": "unknown peer"})
    elif check:
        net.hooks[("GET", "peers")] = check
    capsys.readouterr()
    n = len(net.log)
    assert run(tmp_path, "rename", "zz") == code
    assert ("GET", "/v1/peers") in net.log[n:]
    err = capsys.readouterr().err
    assert os.path.exists(tmp_path / "keys" / "private.toml") == kept
    if kept:
        net.hooks.clear()
        assert pa.Store(str(tmp_path)).load_keys()["id"]
        assert err == (
            "error: The relay server did not confirm this device yet. Try again.\n" if check is None else
            "error: The relay server could not be reached. Check your internet connection and try again.\n")
    else:
        assert err == "error: " + pa.REMOVED + "\n"


@pytest.mark.parametrize("second, wiped", [
    ((401, {"error": "logged out"}), False), ((401, {"error": "clock skew"}), False), ((403, {"error": "banned"}), False),
    ((404, {"error": "not found"}), False), ((500, {"error": "internal"}), False), (_down, False),
    ((401, {"error": "unknown peer"}), True),
])
def test_keys_are_deleted_only_when_one_more_get_says_unknown(second, wiped, net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    net.hooks[("PATCH", "peers")] = lambda *a: net.reply(401, {"error": "unknown peer"})
    net.hooks[("GET", "peers")] = second if callable(second) else lambda *a: net.reply(*second)
    n = len(net.log)
    run(tmp_path, "rename", "zz")
    assert net.log[n:].count(("GET", "/v1/peers")) >= 1
    assert os.path.exists(tmp_path / "keys" / "private.toml") == (not wiped)


def test_bad_id_never_deletes_the_keys(net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    net.hooks[("PATCH", "peers")] = lambda *a: net.reply(401, {"error": "bad id"})
    n = len(net.log)
    assert run(tmp_path, "rename", "zz") == 1
    assert net.log[n:] == [("PATCH", net.log[-1][1])]
    assert os.path.exists(tmp_path / "keys" / "private.toml")


def test_remove_message_for_this_device_is_confirmed_first(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = pair_two(monkeypatch, net, a, b)
    got = {}

    def keep(method, path, headers, body):  # a removes b; the relay server never does it
        got.update(json.loads(body)["m"])
        return net.reply(200, {"r": {}})

    net.hooks[("DELETE", "peers")] = keep
    answers(monkeypatch, "y")
    assert run(a, "delete", pa.id_hex(idb)[:6]) == 0
    net.hooks.clear()
    net.deliver(idb, got[idb])
    net.stop.set()
    capsys.readouterr()
    assert run(b, "listen") == 130
    err = capsys.readouterr().err
    assert "could not be reached" not in err and pa.REMOVED not in err  # the relay server still lists b
    assert os.path.exists(b / "keys" / "private.toml") and ida in state(b)["peers"]
    # the same message again is not acted on twice
    net.deliver(idb, got[idb])
    capsys.readouterr()
    assert run(b, "listen") == 130
    assert "could not be reached" not in capsys.readouterr().err


# ---- error text: one line that says why, with no line naming what failed ----


def _offline(*a):
    raise OSError("network down")


@pytest.mark.parametrize("reply, code, reason", [
    (_offline, pa.EXIT_TEMP, "The relay server could not be reached. Check your internet connection and try again."),
    ((503, {"error": "unavailable"}), pa.EXIT_TEMP, "The relay server is not working right now. Try again later."),
    ((429, {"error": "rate limited", "retry_after": 120}), pa.EXIT_TEMP, "Too many tries. Try again in 2 minutes."),
    ((429, {"error": "rate limited", "retry_after": 30}), pa.EXIT_TEMP, "Too many tries. Try again in 30 seconds."),
    ((426, {"error": "update required"}), pa.EXIT_ERR,
     "This version of PushArmor is too old. Update PushArmor to continue."),
    ((401, {"error": "clock skew"}), pa.EXIT_ERR,
     "This device's clock is off by more than 5 minutes. Fix the clock and try again."),
    ((401, {"error": "logged out"}), pa.EXIT_LOGIN, "This device is logged out. Log in to resume."),
    ((403, {"error": "banned"}), pa.EXIT_ERR, "This account is blocked."),
    ((502, {"error": "email send failed"}), pa.EXIT_TEMP, "The relay server is not working right now. Try again later."),
    ((400, {"error": "bad x"}), pa.EXIT_ERR,
     "The relay server did not accept the request. Update PushArmor and try again."),
])
def test_error_is_one_line_reason(reply, code, reason, net, tmp_path, monkeypatch, capsys):
    login(monkeypatch, tmp_path)
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    net.hooks[("GET", "peers")] = reply if callable(reply) else lambda *a: net.reply(*reply)
    capsys.readouterr()
    assert run(tmp_path, "pair") == code
    assert capsys.readouterr().err.splitlines() == ["error: " + reason]


def test_unknown_device_error_is_one_line(net, tmp_path, monkeypatch, capsys):
    me = login(monkeypatch, tmp_path)
    del net.peers[me]
    capsys.readouterr()
    assert run(tmp_path, "rename", "zz") == pa.EXIT_LOGIN
    assert capsys.readouterr().err.splitlines() == ["error: This device was removed from the account. Log in again."]


def test_not_logged_in_is_one_line(tmp_path, capsys):
    (tmp_path / "c").mkdir(mode=0o700)
    assert run(tmp_path / "c", "send", "hi") == pa.EXIT_LOGIN
    assert capsys.readouterr().err.splitlines() == ["error: This device is not logged in. Run: pusharmor login"]


@pytest.mark.parametrize("word, line", [
    ("gone", '"%s" needs attention. Open PushArmor on it to resolve.'),
    ("logged out", '"%s" is logged out. Log in on it to receive messages.'),
    ("not listening", '"%s" is set to send only. It does not receive messages.'),
    ("unapproved", '"%s" is not paired with this device. Pair with it to send it messages.'),
    ("denied", '"%s" is not paired with this device.'),
    ("unknown", '"%s" is no longer on this account.'),
    ("failed:net", 'The push service of "%s" did not accept the message. Try again later.'),
    ("failed", '"%s" has not finished turning on notifications. Open PushArmor on it.'),
    ("other", '"%s" has not finished turning on notifications. Open PushArmor on it.'),
])
def test_send_per_device_error_is_one_line(word, line, net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    ida, idb = pair_two(monkeypatch, net, a, b)
    name = pa.peer_label(state(a)["peers"][idb])
    net.hooks[("POST", "send")] = lambda *x: net.reply(200, {"r": {idb: word}})
    capsys.readouterr()
    assert run(a, "send", "hi") == pa.EXIT_SEND
    cap = capsys.readouterr()
    assert cap.err.splitlines() == ["error: " + line % name] and cap.out == "Sent to 0 of 1 device.\n"


def test_pair_result_word_is_never_shown_raw(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    login(monkeypatch, a)
    idb = login(monkeypatch, b)
    net.hooks[("POST", "pair")] = lambda *x: net.reply(200, {"r": "denied"})
    capsys.readouterr()
    assert run(a, "pair", pa.id_hex(idb)[:6]) == 1
    name = pa.peer_label(state(a)["peers"][idb])
    err = capsys.readouterr().err.splitlines()
    assert err[-1] == 'error: "%s" is not paired with this device.' % name and not any("Unable" in x for x in err)


@pytest.mark.skipif(os.name == "nt", reason="the notify program is a shell script")
def test_notify_program_that_fails_is_one_line(tmp_path, capsys):
    prog = tmp_path / "notify"
    prog.write_text("#!/bin/sh\nexit 3\n")
    prog.chmod(0o755)
    pa.run_exec(str(prog), REC)
    pa.run_exec(str(tmp_path / "gone"), REC)
    assert capsys.readouterr().err.splitlines() == [
        'warning: The notify program "%s" exited with status 3. Listening continues.' % prog,
        'warning: The notify program "%s" could not be run: No such file or directory. Listening continues.'
        % (tmp_path / "gone")]


def test_listen_error_is_one_line_and_listening_continues(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    pair_two(monkeypatch, net, a, b)
    assert run(a, "send", "hi") == 0
    net.stop.set()

    def offline(cx, pt, src="push"):
        raise pa.TempFail(pa.UNREACHABLE, 0)

    monkeypatch.setattr(pa, "receive", offline)
    capsys.readouterr()
    assert run(b, "listen") == 130
    err = capsys.readouterr().err.splitlines()
    assert "warning: " + pa.UNREACHABLE + " Listening continues." in err and not any("Unable" in x for x in err)


def test_command_texts_are_the_approved_sentences(net, tmp_path, monkeypatch, capsys):
    def err_of(code, *argv):
        capsys.readouterr()
        assert run(tmp_path, *argv) == code
        return capsys.readouterr().err

    me = login(monkeypatch, tmp_path)
    assert err_of(2, "send") == "error: There is no message to send. Give a message, or pipe text into pusharmor send.\n"
    assert err_of(2, "send", "   ") == "error: The message is empty.\n"
    assert err_of(1, "send", "--to", "abcdef", "hi") == (
        'error: No device matches "abcdef". Run pusharmor pair to see your devices.\n')
    assert err_of(2, "rename", 'bad "name"') == (
        "error: The name must be 1 to 32 plain ASCII characters, with no double quote.\n")
    assert err_of(1, "pair", pa.id_hex(me)[:6]) == "error: This is the device you are using. Choose another device.\n"
    monkeypatch.setattr(pa, "ntfy_open", lambda url, timeout: (_ for _ in ()).throw(OSError("down")))
    assert err_of(pa.EXIT_TEMP, "listen") == (
        "error: The push service at ntfy.sh could not be reached. Check your internet connection and try again.\n")
    with pytest.raises(SystemExit):
        run(tmp_path, "listen", "--json", "--tsv")
    assert "error: Use only one of --json, --tsv, and --exec.\n" in capsys.readouterr().err
    answers(monkeypatch, "")
    with pytest.raises(pa.Fail) as e:
        pa.choose_evict([])
    assert str(e.value) == (
        "No devices were chosen to remove, so you are not logged in. Run pusharmor login to try again.")
    net.hooks[("POST", "peers")] = lambda *a: net.reply(503, {})
    monkeypatch.setattr(pa.time, "sleep", lambda s: None)
    assert err_of(0, "logout") == (
        "warning: The relay server could not be reached yet. PushArmor will try again the next time it runs.\n")


def test_login_ctrl_d_at_the_code_prompt(net, tmp_path, monkeypatch, capsys):
    def eof(prompt=""):
        raise EOFError

    monkeypatch.setattr(pa, "input", eof, raising=False)
    assert run(tmp_path, "login") == 1
    assert capsys.readouterr().err == "error: No code was entered. Run pusharmor login again.\n"


def test_every_stderr_line_has_a_severity_prefix(net, tmp_path, monkeypatch, capsys):
    a, b = tmp_path / "a", tmp_path / "b"
    capsys.readouterr()
    pair_two(monkeypatch, net, a, b)
    assert run(a, "send", "hi") == 0
    net.stop.set()
    assert run(b, "listen", "--json") == 130
    cap = capsys.readouterr()
    lines = cap.err.splitlines()
    assert lines and all(x.startswith(("error: ", "warning: ", "info: ")) for x in lines)
    assert "info: Listening. Press Ctrl+C to stop." in lines and "info: Stopped." in lines
    assert "Sent to 1 of 1 device." in cap.out.splitlines() and not any("Sent to" in x for x in lines)
    assert any(x.startswith('info: Waiting for "') for x in lines)
    assert not any(x.startswith(("error: ", "warning: ", "info: ")) for x in cap.out.splitlines())


def test_login_link_too_old_says_the_code_expired(net, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(pa, "LINK_LIFE_S", -1)
    it = iter([CODE])

    def code_then_eof(prompt=""):
        for x in it:
            return x
        raise EOFError

    monkeypatch.setattr(pa, "input", code_then_eof, raising=False)
    assert run(tmp_path, "login") == 1
    out = capsys.readouterr().out
    assert "The code expired. Open the link to get a new code:\n\n  %s/auth/cli#" % pa.SITE in out


def test_rename_to_the_same_name_makes_no_network_call(net, tmp_path, monkeypatch, capsys):
    a = tmp_path / "a"
    login(monkeypatch, a)
    name = state(a)["name"]
    capsys.readouterr()
    before = len(net.log)
    assert run(a, "rename", name) == 0
    assert capsys.readouterr().out == 'This device is already named "%s".\n' % name
    assert len(net.log) == before and state(a)["name"] == name

"""Line 2 of pusharmor.py, the version comment, matches VERSION (release/tag.mjs stamps both)."""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pusharmor as pa  # noqa: E402


def test_version_comment_matches_version():
    with open(os.path.join(os.path.dirname(HERE), "pusharmor.py"), encoding="utf-8") as f:
        lines = f.read().split("\n")
    assert lines[0] == "#!/usr/bin/env python3"
    assert lines[1] == "# PushArmor command-line client, version " + pa.VERSION


def test_old_python_exits_2_with_message(capsys):
    import pytest
    import pusharmor as pa
    with pytest.raises(SystemExit) as e:
        pa.check_python((3, 8, 10))
    assert e.value.code == 2
    assert capsys.readouterr().err == "PushArmor needs Python 3.9 or later.\n"
    pa.check_python((3, 9, 0))


def test_check_runs_before_other_imports():
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pusharmor.py")).read()
    assert src.index("\ncheck_python()\n") < src.index("import tomllib")
    assert src.index("\ncheck_python()\n") < src.index("from cryptography")


def test_broken_cryptography_exits_1_with_one_line(tmp_path):
    import subprocess
    fake = tmp_path / "cryptography"
    fake.mkdir()
    (fake / "__init__.py").write_text("raise ModuleNotFoundError(\"No module named '_cffi_backend'\")\n")
    env = dict(os.environ, PYTHONPATH=str(tmp_path))
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(HERE), "pusharmor.py"), "--help"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 1 and r.stdout == ""
    assert r.stderr == pa.CRYPTO_MISSING + "\n"
    assert r.stderr == ("PushArmor needs the Python cryptography package. Install it with: "
                        "python3 -m pip install --user cryptography (or: pipx install PushArmor).\n")

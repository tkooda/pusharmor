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

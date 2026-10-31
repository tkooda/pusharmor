# PushArmor command-line client

Send links and text to your own devices from a terminal. Everything is
end-to-end encrypted: the relay server only passes on data it cannot read.

See https://pusharmor.com for the apps and the full guide.

## Install

With pipx:

    pipx install pusharmor

Or download `pusharmor.py` from the GitHub release, check its SHA-256 against
`pusharmor.py.sha256` from the same release, and run it with Python:

    sha256sum -c pusharmor.py.sha256
    python3 pusharmor.py --help

## Commands

- `login`
- `logout`
- `pair`
- `listen`
- `send`
- `rename`
- `delete`

Run `pusharmor COMMAND --help` for details.

## Needs

- Linux or macOS. Windows is not supported yet.
- Python 3.11 or newer.
- The `cryptography` package (version 3.4 or newer). pipx installs it for you.

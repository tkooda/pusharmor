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

- `pusharmor login` - log in this device (open the link it shows, then paste the code).
- `pusharmor pair` - list your devices; `pusharmor pair ID` pairs with one: compare the
  fingerprint on both devices, then approve.
- `pusharmor send TEXT` - send a link or text to all paired devices; `--to ID` for one,
  `--text` to send a link as plain text. With `-` or piped input it reads stdin.
- `pusharmor listen` - print messages as they arrive; `--json`, `--tsv`, or
  `--exec PROG` (runs PROG ID NAME PLATFORM TYPE BODY per message).
- `pusharmor rename NAME` - change the name your other devices show.
- `pusharmor logout` - log out; keys and paired devices stay on this device.
- `pusharmor delete ID` - remove a device from your account (this device too). It asks
  first; without a terminal it needs `--yes`.

Run `pusharmor COMMAND --help` for details. Files live in `~/.config/pusharmor`
(or `$XDG_CONFIG_HOME/pusharmor`, `$PUSHARMOR_CONFIG`, or `--config DIR`).

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | error: a failed request, or a damaged or unreadable file on this device |
| 2 | wrong command line, or the command needs a terminal |
| 3 | not logged in, logged out, or this device was removed |
| 4 | send failed for at least one device, or there is no device to send to |
| 75 | the relay server is busy or unreachable; try again later |
| 130 | stopped with Ctrl-C |

## Needs

- Linux or macOS. Windows is not supported yet.
- Python 3.11 or newer.
- The `cryptography` package (version 3.4 or newer). pipx installs it for you.

# PushArmor command-line client

Send URLs, text, and small files to your own devices from a terminal. Everything is
end-to-end encrypted: the relay server only passes on data it cannot read.

See https://pusharmor.com for the apps and the full guide.

## Install

We recommend pipx. It installs the `cryptography` package for you:

    pipx install pusharmor

Or download `pusharmor.py` from the GitHub release, check its SHA-256 against
`pusharmor.py.sha256` from the same release, and run it with Python:

    sha256sum -c pusharmor.py.sha256
    python3 pusharmor.py --help

Also compare the hash with the one on https://pusharmor.com/download.

The single file needs the `cryptography` package. Install it from your
distribution:

    sudo apt install python3-cryptography    # Debian and Ubuntu
    sudo dnf install python3-cryptography    # RHEL, Fedora, and related

## Commands

- `pusharmor login` - log in this device (open the URL it shows, then paste the code).
  On a device that is already logged in, it does nothing and exits with 0.
- `pusharmor devices` - list your devices and their pairing status. `--json` (one object
  per line) or `--tsv` (id, added, platform, status, code, name; no header) is for scripts.
  The status is one of `this_device`, `paired`, `logged_out`, `not_listening`,
  `compare_code` (with the pairing code), `awaiting_confirmation`, `wants_to_pair`,
  `pairing`, `not_paired`, or `rejected`. A name not known yet is `null` in `--json` and
  `{UNKNOWN}` elsewhere.
- `pusharmor pair ID` - pair with a device (ID from `pusharmor devices`): compare the
  fingerprint on both devices, then confirm or reject.
- `pusharmor send TEXT` - send a URL or text to all paired devices; `-d ID` for one,
  `--text` to send a URL as plain text. With `-` or piped input it reads stdin.
- `pusharmor send --file PATH` (`-f`) - send a small file to all paired devices (`-d ID` for one). It is
  end-to-end encrypted and expires on the relay server at the time shown after the send.
- `pusharmor listen` - print messages as they arrive; `--json`, `--tsv`, `--quiet` (print
  nothing to stdout, for example with `--files DIR`), or
  `--exec PROG` (runs PROG ID PLATFORM TYPE NAME BODY per message; NAME and BODY are
  passed as separate arguments; quote them in shell scripts). `--json` escapes
  every non-ASCII character as `\uXXXX`. `--tsv` writes `\\`, `\t`, `\n`, and `\r` for
  backslash, tab, newline, and carriage return, and `\uXXXX` for other control
  characters, line and paragraph separators, and bidi controls.
  A received file is not downloaded unless you give `--files DIR`: then every file is
  saved in DIR (mode 0600, never replacing a file: `name (1).ext` and so on) and is never
  written to the output. `--json` carries the saved path in a `file` field (empty when
  none), `--tsv` puts it in the body column (the file name when not saved), and `--exec`
  gets the file's name in DIR as BODY. A file that cannot be saved prints one `warning:` line,
  and `--json` adds an `error` field.
- `pusharmor rename NAME` - change the name your other devices show.
- `pusharmor logout` - log out; keys and paired devices stay on this device. On a device
  that is not logged in, it does nothing and exits with 0.
- `pusharmor delete ID` - remove a device from your account. It asks
  first; without a terminal it needs `--yes`.

Only `devices` and `listen` write to stdout, and only their data. Prompts, messages,
hints, and errors go to stderr. The output of an `--exec` program passes through
unchanged. Without `--files DIR`, a received file shows `File: not downloaded`, and
listen prints the hint to use `--files DIR` once on stderr.

Run `pusharmor COMMAND --help` for details. Files live in `~/.config/pusharmor`
(or `$XDG_CONFIG_HOME/pusharmor`, `$PUSHARMOR_CONFIG`, or `--config DIR`).
On Windows they live in `%APPDATA%\PushArmor` (or `%PUSHARMOR_CONFIG%`, or `--config DIR`).

Do not restore the config directory (the one holding `keys/` and `devices.toml`) from a backup, copy it to another machine, or delete `devices.toml` alone. Your other devices will reject the messages it sends. Instead, run `pusharmor logout` and `pusharmor login`, then pair again with `pusharmor pair`.

## Exit codes

`pusharmor --help` lists the exit codes and their meaning.

## Needs

- Linux, macOS, or Windows.
- Python 3.9 or newer.
- The `cryptography` package (version 3.3.2 or newer). pipx installs it for you.

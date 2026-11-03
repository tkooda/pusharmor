# Golden cross-platform vectors

`golden-v1.json` is the normative cross-platform contract for PushArmor
protocol v1. Every component runs it through its own production code:

- Worker (TypeScript, vitest in workerd)
- webext shared code (TypeScript, Node test runner)
- Android `:crypto` and `:protocol` (JVM unit tests, plus the Keystore
  instrumented test)
- iOS crypto package (`swift test`)

`ref/` is a small reference implementation in plain Node.js (ESM, no npm
dependencies; `node:crypto` and `node:zlib` only). It writes the file and
checks it. It is not production code.

## Commands

Run from this directory (Node 24):

    node --test ref/check.mjs     # assert every section (also: npm test)
    node ref/gen.mjs              # rewrite golden-v1.json (also: npm run gen)

The generator is deterministic: ECDSA signatures use RFC 6979 deterministic
k, HPKE ephemeral keys come from `DeriveKeyPair(ikmE)`, and every test key,
r value and ikmE is derived from a fixed label. Two runs give the same bytes.
`check.mjs` also regenerates the file in memory and fails if it differs from
the committed file.

The file is written once and committed. CI never regenerates it. Any change
to it (or to `ref/`) is a reviewed change, and every leg must pass the new
file before it lands. The deflate bytes come from the zlib build in Node; if a
different Node version produces different deflate output, the
reproducibility test fails. In that case keep the committed file (any valid
deflate stream is correct) unless the change is intended.

## Format

- Top level: `"version": 1`, a `"description"`, and one object per section.
  Every section has a `"description"` that says what each leg must assert.
- JSON is pretty-printed with sorted keys and is pure ASCII (non-ASCII text
  is written as `\uXXXX` escapes).
- Binary values are strict b64url (RFC 4648 URL alphabet, no `=`). Two
  exceptions: `b64url.cases[].hex` (decoded bytes as hex, so the codec is not
  tested with itself) and `rfc9180` (hex, as in its source).
- Peer ids are 40-char b64url strings; "raw id" means the decoded 30 bytes.
  Pairing ids are 11-char b64url strings.
- Times are unix seconds. The counter key in inner messages and name entries
  is `"n"`, never `"t"`.
- Other sections refer to test peers by name (`N`, `X`, `O`, `Z`, `S`);
  look them up in `keys.peers`.

## Sections

Each section's `"description"` says what it holds and what each leg asserts.

### Receiver state in message cases

`messages`, `padded_messages` and `must_fail` cases of kind `message` carry
the receiver state the pipeline runs against:

- `receiver`: the receiving peer (its `enc_priv`, `id` and `account`).
- `pin`: the pinned sender (`id`, `sign_pub`, `enc_pub`, `pairing_id`,
  `ruling` = `approved` | `unruled` | `denied`), or null when the sender is not
  pinned.
- `window`: `h` and `seen` (the n values whose bit is set, high to low).
- `history`: n values that have a History row for this sender and pairing id.

### must_fail outcomes

- `invalid`: a replay (a seen n of url/text/tel with no History row, or
  n <= h - 100). The client drops it with the "Invalid message received"
  notice and History event.
- `unreadable`: every other case. The client drops it under the Notice rule
  (generic "could not read"); for `request` (Worker: 401) and `peer_entry`
  (client drops the list entry) it only means rejected.

For kind `pair`, the received kind must equal `expected_kind`, and an open
must match `stored_c_N`.

## Not covered here

Per-platform state machine tests (re-send while "Waiting for $X", the allow
reconcile, countdown formatting, persistence across restarts) and the
Worker-side withdraw test live with each component, as listed in the CI
design. Stage 2 cross seal/open between legs is a CI job, not a file.

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

| Section | Content | Each leg asserts |
|---|---|---|
| `keys` | test `id_secret`; peers N, X, O (account A), Z (account B), S (sign_pub = enc_pub); raw private scalars, 65-byte SEC1 publics, account, keyhash, id | publics from scalars; account, keyhash, id byte for byte |
| `email_hash` | normalization cases (trim ASCII whitespace, reject non-ASCII, ASCII lowercase); `normalized` null = 400 "bad email" | normalized, email_hash, account |
| `id_order` | id pairs and the lower side (unsigned byte compare) | `lower` |
| `oauth_nonce` | k and nonce per purpose | k, nonce |
| `cli_code` | command line login link and 34-char code per purpose (test token_secret) | k16, link, code (Worker and command line client only) |
| `my_push_sha256` | push objects of every type | my_push_sha256 |
| `b64url` | strict accept/reject strings | decoded hex, or reject |
| `pairing` | r_N, r_X, c_N, fingerprint hash and chars, pairing_id, pk, the three pair messages, `fingerprint_cases` (every Crockford symbol) | deterministic values byte for byte; open each pair message, compare plaintext, check the open against c_N |
| `pair_decide` | pure decision on a commit push (rules 3a-3e) | all four output fields |
| `pair_timeout` | timeout decision for a pairing row (step 8) | output |
| `pair_hint` | N-side hint line in state committed | output |
| `request_sig` | PA-Sig cases with the exact signed bytes | signed_bytes from the fields; sig verifies |
| `name_entries` | PA-NAME1 entries with signed string, entry JSON and ciphertext | signed string; open; verify; name rules |
| `messages` | one full inner message per type (X -> N) with every intermediate | open, compare plaintext, verify before inflate, inflate, run the receive pipeline, compare `expect` |
| `padded_messages` | one text message per padding bucket (512, 1024, 2048, 3800) | as messages; length equals the bucket |
| `padding` | bucket math | unpadded_chars, bucket (null = refuse), padded length |
| `content_cap` | 2048-byte UTF-8 cap and the cut on a code point boundary | utf8_bytes, ok, truncated |
| `inflate` | deflate-raw streams with the 16384-byte cap | ok, length and sha256 of the output |
| `replay_window` | window state, n, type, History row | outcome, state_after |
| `url_parse` | received url cases: shape rules, encode sets, IDN hosts | url, href, host, auto_open |
| `phone` | phone detection cases | phone |
| `must_decode` | inputs with unknown extra keys (inner messages, name entries) that must decode; type is the first known key in order | receive pipeline outcome, name entry result |
| `must_fail` | inputs every client must reject (kinds message, pair, name_entry, request, peer_entry) | rejected, with the given `outcome` |
| `rfc9180` | HPKE suite vector (P-256, HKDF-SHA256, AES-256-GCM, base mode) | DeriveKeyPair, key schedule, seal and open |
| `rfc8291` | RFC 8291 section 5 example with Appendix A values | every intermediate, body, and decrypt |

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

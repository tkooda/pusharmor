// Device name rule (reference). All lengths and positions count Unicode code points.
// Allowed: ASCII 32..126 except backtick, backslash, double quote, { } < > | ! $ ; ?.
// Only the ASCII space (0x20) counts as a space for trimming and collapsing.

const BAD = new Set(['`', '\\', '"', '{', '}', '<', '>', '|', '!', '$', ';', '?']);

const allowed = (ch) => {
  const c = ch.codePointAt(0);
  return c >= 0x20 && c <= 0x7e && !BAD.has(ch);
};

// Trim leading and trailing spaces and collapse each run of spaces to one.
const squeeze = (s) => s.replace(/ +/g, ' ').replace(/^ | $/g, '');

// Typed name (setup and rename): spaces are trimmed and collapsed first; the result
// is the name to save. Returns { error, name }: error null and the saved name when
// valid, else the error text and name null. Longer than 32 code points (after the
// space cleanup) is "Name too long" and "Use 32 characters or fewer" on two lines
// (the input field stops typing at 32).
export function checkInput(s) {
  const name = squeeze(s);
  const cps = [...name];
  if (cps.length === 0) return { error: 'Name too short', name: null };
  if (cps.length > 32) return { error: 'Name too long\nUse 32 characters or fewer', name: null };
  if (cps.some((ch) => !allowed(ch)) || cps[0] === '-') return { error: 'Invalid characters', name: null };
  return { error: null, name };
}

// Setup default from the system name: curly apostrophes -> ', other disallowed -> ?,
// trim and collapse spaces, leading '-' -> ?, keep at most 32 code points, trim a
// trailing space left by the cut. An empty result falls back to a platform name, so
// it is not in the vectors.
export function setupDefault(s) {
  const mapped = [...s].map((ch) => {
    if (ch === '\u2018' || ch === '\u2019') return "'";
    return allowed(ch) ? ch : '?';
  }).join('');
  const cps = [...squeeze(mapped)];
  if (cps[0] === '-') cps[0] = '?';
  return squeeze(cps.slice(0, 32).join(''));
}

// Display of any received or stored name: disallowed -> ?, trim and collapse spaces,
// leading '-' -> ?, empty -> '?'. No padding, no truncation.
export function display(s) {
  const cps = [...squeeze([...s].map((ch) => (allowed(ch) ? ch : '?')).join(''))];
  if (cps.length === 0) return '?';
  if (cps[0] === '-') cps[0] = '?';
  return cps.join('');
}

// Setup default that clashes with another device's name (equal ignoring ASCII case):
// N = smallest number >= 2 whose result is free; suffix ' (N)'; the base is cut to
// 32 - suffix length code points and trailing spaces trimmed before the suffix.
// base is a setupDefault result; taken lists the other devices' names.
export function uniqueDefault(base, taken) {
  const fold = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const used = new Set(taken.map(fold));
  if (!used.has(fold(base))) return base;
  for (let n = 2; ; n++) {
    const suffix = ' (' + n + ')';
    const name = [...base].slice(0, 32 - suffix.length).join('').replace(/ +$/, '') + suffix;
    if (!used.has(fold(name))) return name;
  }
}

// Strict JSON for inner messages and name entries: invalid UTF-8, a
// duplicate key, or trailing data throws. Numbers keep their raw token so
// "n" can be checked on the token, not on the parsed value (catalog r10,
// Encodings: ^[1-9][0-9]*$ and 1 .. 2^53 - 1).
export class JNum {
  constructor(raw) { this.raw = raw; }
}

const MAX_N = 2n ** 53n - 1n;

// Returns the counter as a Number, or null when the token is not a valid n.
export function counterN(v) {
  if (!(v instanceof JNum) || !/^[1-9][0-9]*$/.test(v.raw)) return null;
  const b = BigInt(v.raw);
  return b <= MAX_N ? Number(b) : null;
}

export function parseStrict(bytes) {
  const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let i = 0;
  const ws = () => { while (i < s.length && ' \t\n\r'.includes(s[i])) i++; };
  const fail = (m) => { throw new Error('json: ' + m + ' at ' + i); };
  function value() {
    ws();
    const c = s[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === 't' && s.startsWith('true', i)) { i += 4; return true; }
    if (c === 'f' && s.startsWith('false', i)) { i += 5; return false; }
    if (c === 'n' && s.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(i));
    if (!m || m[0] === '' || m[0] === '-') fail('value');
    i += m[0].length;
    return new JNum(m[0]);
  }
  function object() {
    i++;
    const o = new Map();
    ws();
    if (s[i] === '}') { i++; return o; }
    for (;;) {
      ws();
      if (s[i] !== '"') fail('key');
      const k = string();
      if (o.has(k)) fail('duplicate key');
      ws();
      if (s[i] !== ':') fail('colon');
      i++;
      o.set(k, value());
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === '}') { i++; return o; }
      fail('object');
    }
  }
  function array() {
    i++;
    const a = [];
    ws();
    if (s[i] === ']') { i++; return a; }
    for (;;) {
      a.push(value());
      ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === ']') { i++; return a; }
      fail('array');
    }
  }
  function string() {
    i++;
    let out = '';
    for (;;) {
      if (i >= s.length) fail('unterminated string');
      const c = s[i++];
      if (c === '"') return out;
      if (c < ' ') fail('control char');
      if (c !== '\\') { out += c; continue; }
      const e = s[i++];
      const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (e in map) out += map[e];
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i, i + 4))) { out += String.fromCharCode(parseInt(s.slice(i, i + 4), 16)); i += 4; }
      else fail('escape');
    }
  }
  const v = value();
  ws();
  if (i !== s.length) fail('trailing data');
  return v;
}

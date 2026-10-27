// Strict JSON parser: rejects duplicate keys at any depth and keeps the raw
// token of every number, so integer rules are checked on the raw token
// (catalog Encodings: n must match ^[1-9][0-9]*$ and be in 1 .. 2^53 - 1).

export class JNum {
  readonly raw: string;
  constructor(raw: string) {
    this.raw = raw;
  }
}

export type JValue = string | JNum | boolean | null | JValue[] | JObject;
export interface JObject {
  [k: string]: JValue;
}

export class JsonError extends Error {}

export function parseStrictJson(text: string): JValue {
  let i = 0;
  const ws = () => {
    while (i < text.length) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") i++;
      else break;
    }
  };
  const fail = (m: string): never => {
    throw new JsonError(m + " at " + i);
  };
  const str = (): string => {
    if (text[i] !== '"') fail("expected string");
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      if (c < 0x20) fail("control char");
      if (c === 0x5c) {
        i++;
        const e = text[i];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.substr(i + 1, 4))) fail("bad escape");
          i += 5;
          continue;
        }
        if (e === undefined || '"\\/bfnrt'.indexOf(e) < 0) fail("bad escape");
      }
      i++;
    }
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const num = (): JNum => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) fail("bad number");
    i += m![0].length;
    return new JNum(m![0]);
  };
  const lit = (w: string, v: JValue): JValue => {
    if (text.startsWith(w, i)) {
      i += w.length;
      return v;
    }
    return fail("bad literal");
  };
  const value = (depth: number): JValue => {
    if (depth > 32) fail("too deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: JObject = Object.create(null) as JObject;
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = str();
        if (Object.prototype.hasOwnProperty.call(obj, k)) fail("duplicate key");
        ws();
        if (text[i] !== ":") fail("expected colon");
        i++;
        obj[k] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("expected , or }");
      }
    }
    if (c === "[") {
      i++;
      const arr: JValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("expected , or ]");
      }
    }
    if (c === '"') return str();
    if (c === "t") return lit("true", true);
    if (c === "f") return lit("false", false);
    if (c === "n") return lit("null", null);
    return num();
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail("trailing data");
  return v;
}

export function isObject(v: JValue | undefined): v is JObject {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof JNum);
}

/** Counter n rule: raw token ^[1-9][0-9]*$ and value in 1 .. 2^53 - 1. Returns null otherwise. */
export function counterN(v: JValue | undefined): number | null {
  if (!(v instanceof JNum)) return null;
  if (!/^[1-9][0-9]*$/.test(v.raw) || v.raw.length > 16) return null;
  const n = Number(v.raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return n;
}

/** Minimal decimal ASCII for a counter n. */
export function nStr(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("bad n");
  return String(n);
}

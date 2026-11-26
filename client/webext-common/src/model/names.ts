// Device name rule (golden vectors "device_name"): allowed are ASCII 32..126 except
// backtick, backslash, double quote, { } < > | ! $ ; ?; 1 to 32 characters; no leading '-'.
// Only the ASCII space counts as a space for trimming and collapsing.

const BAD = new Set(["`", "\\", '"', "{", "}", "<", ">", "|", "!", "$", ";", "?"]);

const allowed = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return c >= 0x20 && c <= 0x7e && !BAD.has(ch);
};

/** Trim leading and trailing spaces and collapse each run of spaces to one. */
const squeeze = (s: string): string => s.replace(/ +/g, " ").replace(/^ | $/g, "");

/** A typed name (rename): the cleaned name to save, or the error to show (no period). */
export function checkName(s: string): { error: string; name: null } | { error: null; name: string } {
  const name = squeeze(s);
  const cps = [...name];
  if (cps.length === 0) return { error: "Name too short", name: null };
  if (cps.some((ch) => !allowed(ch)) || cps[0] === "-" || cps.length > 32) return { error: "Invalid characters", name: null };
  return { error: null, name };
}

/** The setup default from a system name: curly apostrophes become ', other disallowed characters '?', at most 32 characters. */
export function defaultName(s: string): string {
  const mapped = [...s].map((ch) => (ch === "\u2018" || ch === "\u2019" ? "'" : allowed(ch) ? ch : "?")).join("");
  const cps = [...squeeze(mapped)];
  if (cps[0] === "-") cps[0] = "?";
  return squeeze(cps.slice(0, 32).join(""));
}

/** A setup default that another device already uses (ignoring ASCII case) gets the first free " (N)", N >= 2. */
export function uniqueDefault(base: string, taken: string[]): string {
  const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const used = new Set(taken.map(fold));
  if (!used.has(fold(base))) return base;
  for (let n = 2; ; n++) {
    const suffix = " (" + n + ")";
    const name = [...base].slice(0, 32 - suffix.length).join("").replace(/ +$/, "") + suffix;
    if (!used.has(fold(name))) return name;
  }
}

/** Any received or stored name as shown: disallowed characters become '?', spaces cleaned, never empty. */
export function displayName(s: string): string {
  const cps = [...squeeze([...s].map((ch) => (allowed(ch) ? ch : "?")).join(""))];
  if (cps.length === 0) return "?";
  if (cps[0] === "-") cps[0] = "?";
  return cps.join("");
}

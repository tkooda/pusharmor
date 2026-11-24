// File names, applied by sender and receiver alike: an ASCII allow-list, a
// fallback name, reserved device names, and "base (N).ext" on a collision.

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((i) => ["COM" + i, "LPT" + i])]);

/** [base, ".ext"] when the text after the last dot is 1-10 ASCII letters or digits, else [name, ""]. */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  if (i >= 0 && /^[A-Za-z0-9]{1,10}$/.test(name.slice(i + 1))) return [name.slice(0, i), name.slice(i)];
  return [name, ""];
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The file name rule. time: Unix seconds for a fallback name (send time, or receive time on a receiver). */
export function sanitizeName(input: string, time: number, image: boolean): string {
  const parts = input.split(/[/\\]/);
  let name = "";
  for (const ch of parts[parts.length - 1]!) name += /^[A-Za-z0-9 ._()-]$/.test(ch) ? ch : "_";
  name = name.replace(/_+/g, "_").replace(/ +/g, " ").replace(/^[ .]+|[ .]+$/g, "");
  let [base, ext] = splitExt(name);
  if (!/[A-Za-z0-9]/.test(base) || base.length > 64) {
    const d = new Date(time * 1000);
    base =
      (image ? "image-" : "file-") +
      d.getUTCFullYear() +
      pad2(d.getUTCMonth() + 1) +
      pad2(d.getUTCDate()) +
      "-" +
      pad2(d.getUTCHours()) +
      pad2(d.getUTCMinutes()) +
      pad2(d.getUTCSeconds());
  }
  name = (base + ext).slice(0, 100);
  if (RESERVED.has(name.split(".")[0]!.replace(/ +$/, "").toUpperCase())) name = "_" + name;
  return name;
}

/** name, or "base (N).ext" with the smallest free N >= 1. Names match ignoring ASCII case. */
export function collide(name: string, existing: Iterable<string>): string {
  const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const taken = new Set([...existing].map(lower));
  if (!taken.has(lower(name))) return name;
  const [base, ext] = splitExt(name);
  for (let n = 1; ; n++) {
    const c = base + " (" + n + ")" + ext;
    if (!taken.has(lower(c))) return c;
  }
}

// Phone number detection and received-URL rules (catalog Phone number
// detection, One http(s) URL, Auto-open).

const PHONE = /^\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*$/;
const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;
const DATE = /^([0-9]{4}([-. ])[0-9]{2}\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\3[0-9]{4})$/;

/** Trim ASCII whitespace and NBSP. */
export function trimPhoneInput(s: string): string {
  return s.replace(/^[\t\n\f\r \u00a0]+|[\t\n\f\r \u00a0]+$/g, "");
}

/** Rule 1-3: trim, strip a leading "tel:", then the phone pattern minus IPv4 and date shapes. */
export function isPhone(input: string): boolean {
  let s = trimPhoneInput(input);
  if (s.startsWith("tel:")) s = s.slice(4);
  return PHONE.test(s) && !IPV4.test(s) && !DATE.test(s);
}

// Shape rules shared with every platform (golden url_parse): no C0 control or DEL, no
// leading or trailing space; "http(s)://" not followed by "/" or "\\"; no "@" or "%" in the
// authority; non-ASCII host code points only from HOST_CHARS; a numeric host only as a dotted quad.
const HOST_CHARS = /^[\u00df-\u00f6\u00f8-\u00ff\u03b1-\u03c9\u0430-\u045f\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff\uac00-\ud7a3]$/;
const QUAD = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;

function shapeOk(s: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) return false;
  const m = /^https?:\/\/(?![/\\])([^/?#\\]*)/i.exec(s);
  if (!m) return false;
  const auth = m[1]!;
  if (auth.includes("@") || auth.includes("%")) return false;
  if (auth.startsWith("[")) return true;
  const raw = auth.split(":")[0]!;
  for (const ch of raw) if (ch.codePointAt(0)! >= 0x80 && !HOST_CHARS.test(ch)) return false;
  const host = raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const labels = host.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  const last = labels[labels.length - 1]!;
  const endsInNumber = /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
  return !endsInNumber || QUAD.test(host);
}

/** One http(s) URL: shape rules, then strict URL() parse, scheme http/https, non-empty host, no userinfo. */
export function parseHttpUrl(s: string): URL | null {
  if (!shapeOk(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.username !== "" || u.password !== "") return null;
  return u;
}

export type SendType = "url" | "text" | "tel";

/** Precedence: tel: URI > one http(s) URL > phone pattern > text. */
export function detectType(input: string): SendType {
  const s = trimPhoneInput(input);
  if (s.startsWith("tel:") && isPhone(s)) return "tel";
  if (parseHttpUrl(s)) return "url";
  if (isPhone(s)) return "tel";
  return "text";
}

/** Auto-open host rule (Q163 B): https, DNS hostname, no IP literal, no port, no localhost / .local, not single-label. */
export function autoOpenAllowed(u: URL): boolean {
  if (u.protocol !== "https:" || u.port !== "") return false;
  let host = u.hostname;
  if (host.startsWith("[")) return false;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || /^[0-9.]+$/.test(host) || /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(host)) return false;
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2 || labels.some((l) => l === "")) return false;
  const last = labels[labels.length - 1]!;
  if (last === "localhost" || last === "local") return false;
  return true;
}

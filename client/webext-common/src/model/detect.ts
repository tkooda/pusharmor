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
// authority; a numeric host only as a dotted quad. Then a non-ASCII host goes through idnHost.
const QUAD = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;

function shapeOk(s: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(s) || s.startsWith(" ") || s.endsWith(" ")) return false;
  const m = /^https?:\/\/(?![/\\])([^/?#\\]*)/i.exec(s);
  if (!m) return false;
  const auth = m[1]!;
  if (auth.includes("@") || auth.includes("%")) return false;
  if (auth.startsWith("[")) return true;
  const raw = auth.split(":")[0]!;
  const host = raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const labels = host.split(".");
  if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
  const last = labels[labels.length - 1]!;
  const endsInNumber = /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
  return !endsInNumber || QUAD.test(host);
}

// Shared IDN conversion (golden url_parse): each host code point to lowercase on its own
// (ASCII A-Z, else the Unicode full lowercase mapping), then each label with a non-ASCII
// code point becomes "xn--" + RFC 3492 punycode. No other UTS 46 mapping or check.
function idnHost(s: string): string {
  const m = /^(https?:\/\/)([^/?#\\:]*)/i.exec(s);
  if (!m || m[2]!.startsWith("[") || !/[^\u0000-\u007f]/.test(m[2]!)) return s;
  let lower = "";
  for (const ch of m[2]!) lower += ch.codePointAt(0)! < 0x80 ? ch.replace(/[A-Z]/, (c) => c.toLowerCase()) : ch.toLowerCase();
  const host = lower
    .split(".")
    .map((l) => (/^[\u0000-\u007f]*$/.test(l) ? l : "xn--" + punycode(l)))
    .join(".");
  return m[1]! + host + s.slice(m[0].length);
}

/** RFC 3492 punycode encoder for one label. */
function punycode(label: string): string {
  const cps = [...label].map((c) => c.codePointAt(0)!);
  let out = cps.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join("");
  const b = out.length;
  let h = b;
  if (b > 0) out += "-";
  let n = 0x80;
  let delta = 0;
  let bias = 72;
  const digit = (d: number) => String.fromCharCode(d < 26 ? d + 97 : d + 22);
  const adapt = (d0: number, num: number, first: boolean) => {
    let d = first ? Math.floor(d0 / 700) : d0 >> 1;
    d += Math.floor(d / num);
    let k = 0;
    while (d > 455) {
      d = Math.floor(d / 35);
      k += 36;
    }
    return k + Math.floor((36 * d) / (d + 38));
  };
  while (h < cps.length) {
    const m = Math.min(...cps.filter((c) => c >= n));
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = 36; ; k += 36) {
          const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (36 - t)));
          q = Math.floor((q - t) / (36 - t));
        }
        out += digit(q);
        bias = adapt(delta, h + 1, h === b);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

/** One http(s) URL: shape rules, then strict URL() parse, scheme http/https, non-empty host, no userinfo. */
export function parseHttpUrl(s: string): URL | null {
  if (!shapeOk(s)) return null;
  let u: URL;
  try {
    u = new URL(idnHost(s));
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

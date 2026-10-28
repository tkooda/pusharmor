// Received-URL rules and phone number detection (catalog r10: Receiver
// acceptance "One http(s) URL" and Auto-open; Phone number detection).

// -> { url: false } or { url: true, href, host, auto_open }
export function parseReceivedUrl(s) {
  if (!shapeOk(s)) return { url: false };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { url: false };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: false };
  if (u.hostname === '' || u.username !== '' || u.password !== '') return { url: false };
  return { url: true, href: u.href, host: u.hostname, auto_open: autoOpen(u) };
}

const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

// Shape rules applied before the WHATWG parse on every platform, so that a hand parser
// gives the same result as URL() for every accepted input:
// - no C0 control or DEL anywhere, no leading or trailing space (URL() would strip them);
// - "http://" or "https://" (any case) not followed by another "/" or "\\";
// - no "@" or "%" in the authority (no userinfo, no percent-decoded host);
// - a non-ASCII host code point only from HOST_CHARS (UTS 46 leaves these as they are,
//   so the host is lowercase ASCII plus punycode per label);
// - a host that ends in a number (WHATWG) only as a plain dotted quad, 0-255, no leading zero.
const HOST_CHARS = /^[\u00df-\u00f6\u00f8-\u00ff\u03b1-\u03c9\u0430-\u045f\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff\uac00-\ud7a3]$/;
const QUAD = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;

function shapeOk(s) {
  if (/[\u0000-\u001f\u007f]/.test(s) || s.startsWith(' ') || s.endsWith(' ')) return false;
  const m = /^https?:\/\/(?![/\\])([^/?#\\]*)/i.exec(s);
  if (!m) return false;
  const auth = m[1];
  if (auth.includes('@') || auth.includes('%')) return false;
  if (auth.startsWith('[')) return true;
  const raw = auth.split(':')[0];
  for (const ch of raw) if (ch.codePointAt(0) >= 0x80 && !HOST_CHARS.test(ch)) return false;
  const host = raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const labels = host.split('.');
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
  const last = labels[labels.length - 1];
  const endsInNumber = /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
  return !endsInNumber || QUAD.test(host);
}

function autoOpen(u) {
  if (u.protocol !== 'https:' || u.port !== '') return false;
  let h = u.hostname;
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') || IPV4.test(h)) return false;
  const labels = h.split('.');
  if (labels.length < 2 || labels.includes('')) return false;
  const last = labels[labels.length - 1];
  return h !== 'localhost' && last !== 'localhost' && last !== 'local';
}

// Trim ASCII whitespace (TAB, LF, FF, CR, SPACE) and NBSP, strip one leading "tel:".
export function phoneInput(s) {
  const t = s.replace(/^[\t\n\f\r \u00a0]+|[\t\n\f\r \u00a0]+$/g, '');
  return t.startsWith('tel:') ? t.slice(4) : t;
}

const PHONE = /^\+?(?:[ ().-]*[0-9]){7,15}[ ().-]*$/;
const DATE = /^([0-9]{4}([-. ])[0-9]{2}\2[0-9]{2}|[0-9]{2}([-. ])[0-9]{2}\3[0-9]{4})$/;

export function isPhone(s) {
  const t = phoneInput(s);
  return PHONE.test(t) && !IPV4.test(t) && !DATE.test(t);
}

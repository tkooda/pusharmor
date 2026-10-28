// Received-URL rules and phone number detection (catalog r10: Receiver
// acceptance "One http(s) URL" and Auto-open; Phone number detection).

// -> { url: false } or { url: true, href, host, auto_open }
export function parseReceivedUrl(s) {
  if (!shapeOk(s)) return { url: false };
  let u;
  try {
    u = new URL(idnHost(s));
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
// - a host that ends in a number (WHATWG) only as a plain dotted quad, 0-255, no leading zero.
// Then a non-ASCII host goes through the shared IDN conversion (idnHost) before the parse.
const QUAD = /^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$/;

function shapeOk(s) {
  if (/[\u0000-\u001f\u007f]/.test(s) || s.startsWith(' ') || s.endsWith(' ')) return false;
  const m = /^https?:\/\/(?![/\\])([^/?#\\]*)/i.exec(s);
  if (!m) return false;
  const auth = m[1];
  if (auth.includes('@') || auth.includes('%')) return false;
  if (auth.startsWith('[')) return true;
  const raw = auth.split(':')[0];
  const host = raw.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const labels = host.split('.');
  if (labels.length > 1 && labels[labels.length - 1] === '') labels.pop();
  const last = labels[labels.length - 1];
  const endsInNumber = /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
  return !endsInNumber || QUAD.test(host);
}

// Shared IDN conversion (every platform): each host code point to lowercase on its own
// (ASCII A-Z, else the Unicode full lowercase mapping), then each label with a non-ASCII
// code point becomes "xn--" + RFC 3492 punycode. No other UTS 46 mapping or check.
function idnHost(s) {
  const m = /^(https?:\/\/)([^/?#\\:]*)/i.exec(s);
  if (!m || m[2].startsWith('[') || !/[^\u0000-\u007f]/.test(m[2])) return s;
  let lower = '';
  for (const ch of m[2]) lower += ch.codePointAt(0) < 0x80 ? ch.replace(/[A-Z]/, (c) => c.toLowerCase()) : ch.toLowerCase();
  const host = lower
    .split('.')
    .map((l) => (/^[\u0000-\u007f]*$/.test(l) ? l : 'xn--' + punycode(l)))
    .join('.');
  return m[1] + host + s.slice(m[0].length);
}

// RFC 3492 punycode encoder for one label.
function punycode(label) {
  const cps = [...label].map((c) => c.codePointAt(0));
  let out = cps.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join('');
  const b = out.length;
  let h = b;
  if (b > 0) out += '-';
  let n = 0x80, delta = 0, bias = 72;
  const digit = (d) => String.fromCharCode(d < 26 ? d + 97 : d + 22);
  const adapt = (d0, num, first) => {
    let d = first ? Math.floor(d0 / 700) : d0 >> 1;
    d += Math.floor(d / num);
    let k = 0;
    while (d > 455) { d = Math.floor(d / 35); k += 36; }
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

// Received-URL rules and phone number detection (catalog r10: Receiver
// acceptance "One http(s) URL" and Auto-open; Phone number detection).

// -> { url: false } or { url: true, href, host, auto_open }
export function parseReceivedUrl(s) {
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

function autoOpen(u) {
  if (u.protocol !== 'https:' || u.port !== '') return false;
  let h = u.hostname;
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('[') || IPV4.test(h)) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
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

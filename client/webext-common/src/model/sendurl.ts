// Send view: the "Send as URL" checkbox (same likely-URL rule on all four clients).

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** Likely URL: trimmed, no whitespace; http(s):// plus anything, or else a dotted host, optional :port, then /, ? or #. */
export function isLikelyUrl(text: string): boolean {
  const t = text.trim();
  if (t === "" || /\s/.test(t)) return false;
  if (/^https?:\/\/./i.test(t)) return true;
  const m = /^([^/?#:]*)(:[0-9]+)?(?:[/?#]|$)/.exec(t);
  if (!m) return false;
  const labels = m[1]!.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const last = labels[labels.length - 1]!;
  return /^[A-Za-z]{2,}$/.test(last) || /^xn--/i.test(last);
}

/** The URL sent when the box is ticked: the trimmed text, with "https://" when it has no scheme. */
export function urlToSend(text: string): string {
  const t = text.trim();
  return /^https?:\/\//i.test(t) ? t : "https://" + t;
}

/** Checkbox state: enabled for a likely URL, ticked unless the user unticked it for this message. */
export function sendAsUrlBox(text: string, userOff: boolean): { enabled: boolean; checked: boolean } {
  const enabled = isLikelyUrl(text);
  return { enabled, checked: enabled && !userOff };
}

/** userOff after an edit: an empty field goes back to auto. */
export function userOffAfterEdit(text: string, userOff: boolean): boolean {
  return text === "" ? false : userOff;
}

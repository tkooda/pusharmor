// Send view: which devices stay ticked between sends (storage.local).
export const SEND_SEL_KEY = "sendSel";

/**
 * Remembered ids that still exist and can receive, or null when none apply
 * (the caller then keeps its default selection).
 */
export function rememberedSelection(saved: unknown, sendable: string[]): string[] | null {
  if (!Array.isArray(saved)) return null;
  const ok = sendable.filter((id) => saved.includes(id));
  return ok.length ? ok : null;
}

/** Header above the device chips: "Send to (6 of 9)". */
export function sendToHeader(picked: number, total: number): string {
  return "Send to (" + picked + " of " + total + ")";
}

/** The "All" chip shows only with 2 or more devices (one device is preselected instead). */
export function showAllChip(setting: boolean, devices: number): boolean {
  return setting && devices > 1;
}

/** The byte counter shows only from 90 percent of the cap (and over it, as "Too long"). */
export function showCounter(bytes: number, cap: number): boolean {
  return bytes * 10 >= cap * 9;
}

/** A device can take a send now only if it is sendable and not greyed (signed out, unreachable). */
export function canReceiveNow(p: { sendable: boolean; greyed: string | null }): boolean {
  return p.sendable && p.greyed === null;
}

/** Send is off for empty or over-cap text, and with no device selected. */
export function sendDisabled(bytes: number, cap: number, selected: number): boolean {
  return bytes === 0 || bytes > cap || selected === 0;
}

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

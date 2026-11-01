/** I622: which buttons a History message shows, the default name of a saved file, and notification text. */
export type MsgAction = "read" | "copy" | "open" | "share" | "save";

/** Links and phone numbers: Copy, Open, Share. Plain text: Read, Copy, Share, Save. */
export function msgActions(type: string): MsgAction[] {
  return type === "url" || type === "tel" ? ["copy", "open", "share"] : ["read", "copy", "share", "save"];
}

const two = (n: number): string => String(n).padStart(2, "0");

/** YYYY-MM-DD_HHMMSS_message.txt in local time. */
export function saveFilename(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}_message.txt`;
}

/** Cut to at most max characters, ending in an ellipsis when cut. */
export function ellipsize(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

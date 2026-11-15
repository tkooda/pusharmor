// The step a long action is on (storage.session, key BUSY): the UI shows it as a caption under
// its progress bar. done and total make the bar determinate; without them it is indeterminate.

export const BUSY = "busy";

export interface Busy {
  cap: string;
  done?: number;
  total?: number;
}

export const DEL_CAP = {
  other: (done: number, total: number) => "Deleting on your other devices (" + done + " of " + total + ")",
  retry: (attempt: number, of: number) => "Trying again (attempt " + attempt + " of " + of + ")",
  local: "Deleting on this device",
};

/** The captions of the other long actions (the page sets the first one of each). */
export const STEP = {
  sendingCode: "Sending the code",
  checkingCode: "Checking the code",
  setUp: "Setting up this device",
  loading: "Loading your devices",
  removing: (names: string[]) => "Removing " + quoteList(names),
  loggingIn: "Logging in",
  loggingOut: "Logging out",
  updating: "Updating devices",
  deletingAccount: "Deleting your account",
  encryptingFor: (names: string[]) => "Encrypting for " + quoteList(names),
  sendingTo: (names: string[]) => "Sending to " + quoteList(names),
};

/** The Send popup caption: the content type as the Send screen names it, then the devices (several are listed apart, one per line). */
export function sendingCaption(type: string, names: string[]): string {
  const what = "Sending " + (type === "url" ? "URL" : type === "tel" ? "phone number" : "text") + " to";
  return names.length > 1 ? what + ":" : what + " " + quoteList(names) + "...";
}

/** "A", "A" and "B", or "A", "B", and "C" (each in double quotes). */
export function quoteList(names: string[]): string {
  const q = names.map((x) => '"' + x + '"');
  return q.length < 3 ? q.join(" and ") : q.slice(0, -1).join(", ") + ", and " + q.at(-1);
}

/** The Busy value in storage, or null when it is not one. */
export function readBusy(v: unknown): Busy | null {
  const b = v as Partial<Busy> | null | undefined;
  if (!b || typeof b.cap !== "string") return null;
  const out: Busy = { cap: b.cap };
  if (typeof b.done === "number" && typeof b.total === "number" && b.total > 0) {
    out.done = b.done;
    out.total = b.total;
  }
  return out;
}

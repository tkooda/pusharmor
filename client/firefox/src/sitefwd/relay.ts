// Content script to background page relay: the page may not be awake yet, so a
// rejected send (no receiving end) is tried again. A reply is never retried.
export const RELAY_TRIES = 10;
export const RELAY_WAIT_MS = 1000;

export async function relayRetry(send: () => Promise<unknown>, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  for (let i = 0; i < RELAY_TRIES; i++) {
    try {
      return await send();
    } catch {
      if (i < RELAY_TRIES - 1) await sleep(RELAY_WAIT_MS);
    }
  }
  return undefined;
}

// Interface the two shells implement (component-webext section 2). Shared
// code never touches chrome.* or browser.* directly.
import type { PushFields } from "./crypto/labels.ts";

export type { PushFields };

export interface KV {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface MenuPeer {
  id: string;
  name: string;
}

export interface Platform {
  platformName: "chrome" | "firefox";
  isAndroid: boolean;
  pushSubscribe(vapidPub: Uint8Array): Promise<PushFields>;
  pushCurrent(): Promise<PushFields | null>;
  pushUnsubscribe(): Promise<void>;
  /** Basic notification; re-creating the same id replaces it. */
  notify(id: string, title: string, body: string): void;
  clearNotification(id: string): void;
  clearAllNotifications(): Promise<void>;
  /** Opens a tab; resolves to its id when known. */
  openTab(url: string, active: boolean): Promise<number | null>;
  closeTab(tabId: number): void;
  /** Chrome: identity.launchWebAuthFlow; resolves to the final redirect URL. Firefox: null (tab flow). */
  authFlow(url: string): Promise<string | null>;
  /** Auto-open in the last focused normal window; false when no window exists. */
  autoOpenTab(url: string): Promise<boolean>;
  menusRebuild(peers: MenuPeer[], showAll: boolean): void;
  setBadge(text: string): void;
  storageLocal: KV;
  storageSession: KV;
  /** Persisted alarm (chrome.alarms / browser.alarms). */
  alarmAt(name: string, whenMs: number): void;
  clearAlarm(name: string): void;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
}

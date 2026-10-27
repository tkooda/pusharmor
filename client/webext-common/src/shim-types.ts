// Types for the small part of the WebExtension "browser" namespace the shells
// use (Chrome MV3 and Firefox both return promises). Types only: shared code
// never touches the globals; each shell resolves them in its shim.ts.

export interface StorageArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface Tab {
  id?: number;
  url?: string;
  windowId?: number;
}

export interface MessageSender {
  tab?: Tab;
  id?: string;
  url?: string;
}

export interface Event<F> {
  addListener(f: F): void;
}

export interface MenuInfo {
  menuItemId: string | number;
  parentMenuItemId?: string | number;
  linkUrl?: string;
  pageUrl?: string;
  selectionText?: string;
  contexts?: string[];
}

export interface Browser {
  runtime: {
    id: string;
    getURL(path: string): string;
    sendMessage(msg: unknown): Promise<unknown>;
    onMessage: Event<(msg: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void | Promise<unknown>>;
    onStartup: Event<() => void>;
    onInstalled: Event<(d: { reason: string }) => void>;
    getPlatformInfo(): Promise<{ os: string }>;
  };
  storage: { local: StorageArea; session: StorageArea };
  notifications: {
    create(id: string, opts: { type: "basic"; iconUrl?: string; title: string; message: string }): Promise<string>;
    clear(id: string): Promise<boolean>;
    getAll(): Promise<Record<string, unknown>>;
    onClicked: Event<(id: string) => void>;
  };
  tabs: {
    create(p: { url: string; active?: boolean; windowId?: number }): Promise<Tab>;
    query(q: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    remove(id: number): Promise<void>;
  };
  windows?: {
    getLastFocused(q: { windowTypes: string[] }): Promise<{ id?: number }>;
  };
  alarms: {
    create(name: string, info: { when?: number; delayInMinutes?: number }): void;
    clear(name: string): Promise<boolean>;
    onAlarm: Event<(a: { name: string }) => void>;
  };
  action?: { setBadgeText(d: { text: string }): Promise<void> };
  browserAction?: { setBadgeText(d: { text: string }): Promise<void> };
  contextMenus?: MenusApi;
  menus?: MenusApi & {
    onShown: Event<(info: MenuInfo, tab: Tab) => void>;
    refresh(): Promise<void>;
  };
  identity?: { launchWebAuthFlow(d: { url: string; interactive: boolean }): Promise<string>; getRedirectURL(): string };
  scripting?: {
    executeScript(d: { target: { tabId: number }; func: () => unknown }): Promise<{ result: unknown }[]>;
  };
  webRequest?: {
    onBeforeRequest: {
      addListener(
        f: (d: WebRequestDetails) => { cancel?: boolean } | Record<string, never>,
        filter: { urls: string[] },
        extra: string[],
      ): void;
    };
  };
}

export interface MenusApi {
  create(p: { id: string; parentId?: string; title: string; contexts?: string[] }): void;
  update(id: string, p: { title: string }): Promise<void>;
  removeAll(): Promise<void>;
  onClicked: Event<(info: MenuInfo, tab?: Tab) => void>;
}

export interface WebRequestDetails {
  url: string;
  method: string;
  tabId: number;
  type: string;
  originUrl?: string;
  requestBody?: { raw?: { bytes?: ArrayBuffer }[] };
}

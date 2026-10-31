// Theme setting (System / Light / Dark). The choice lives in storage.local key
// "uiTheme" (never synced); a copy in localStorage lets theme.js (a blocking
// script in the page head) set it before the first paint, so dark never flashes white.
export type ThemePref = "system" | "light" | "dark";
export const THEME_KEY = "uiTheme";
export const THEME_CHOICES: [ThemePref, string][] = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];

/** Stored value to a choice; anything unknown or absent is "light" (the extensions default to Light). */
export function parseTheme(v: unknown): ThemePref {
  return v === "dark" || v === "system" ? v : "light";
}

/** Sets data-theme on the root element ("system" removes it, so prefers-color-scheme applies). */
export function applyTheme(root: { dataset: DOMStringMap }, pref: ThemePref): void {
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

/** Storage for the choice (shell: storage.local; screenshots: memory). */
export interface ThemeStore {
  get(): Promise<unknown>;
  set(pref: ThemePref): Promise<void>;
  onChange(cb: (v: unknown) => void): void;
}

function show(pref: ThemePref): void {
  applyTheme(document.documentElement, pref);
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // no localStorage: storage.local still applies after load
  }
}

let watching = false;

/** Applies the stored choice and follows later changes (other popup or tab). */
export async function startTheme(store: ThemeStore): Promise<void> {
  show(parseTheme(await store.get().catch(() => undefined)));
  if (watching) return;
  watching = true;
  store.onChange((v) => show(parseTheme(v)));
}

/** Saves and applies a new choice. */
export async function setTheme(store: ThemeStore, pref: ThemePref): Promise<void> {
  show(pref);
  await store.set(pref);
}

/** In-memory store (screenshot pages): starts at the given value. */
export function memoryThemeStore(initial: unknown): ThemeStore {
  let v = initial;
  return { get: async () => v, set: async (p) => void (v = p), onChange: () => undefined };
}

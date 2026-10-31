// theme.js: a classic script in the page head, run before the first paint. It sets
// the saved theme from the localStorage copy; theme.ts then checks storage.local.
// Default Light: only a saved "system" follows prefers-color-scheme, so no dark first paint.
let t: string | null = null;
try {
  t = localStorage.getItem("uiTheme");
} catch {
  // no localStorage: Light until storage.local is read
}
if (t !== "system") document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
export {};

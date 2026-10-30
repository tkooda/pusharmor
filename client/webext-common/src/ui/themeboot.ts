// theme.js: a classic script in the page head, run before the first paint. It sets
// the saved theme from the localStorage copy; theme.ts then checks storage.local.
try {
  const t = localStorage.getItem("uiTheme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  // no localStorage: the page follows the system until storage.local is read
}
export {};

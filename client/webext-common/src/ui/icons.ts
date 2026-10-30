// Inline SVG icons (Material Symbols Rounded paths, 24 unit box), the brand
// shield and tile, and the empty-state illustrations. Built with DOM calls:
// no remote resources and no innerHTML.

const NS = "http://www.w3.org/2000/svg";

const P = {
  send: "M2.01 21L23 12 2.01 3 2 10l15 2-15 2z",
  devices: "M4 6h18V4H4c-1.1 0-2 .9-2 2v11H0v3h14v-3H4V6zm19 2h-6c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h6c.55 0 1-.45 1-1V9c0-.55-.45-1-1-1zm-1 9h-4v-7h4v7z",
  phone: "M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z",
  laptop: "M20 18c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2H0v2h24v-2h-4zM4 6h16v10H4V6z",
  desktop: "M21 2H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H3V4h18v12z",
  tablet: "M18 0H6C4.34 0 3 1.34 3 3v18c0 1.66 1.34 3 3 3h12c1.66 0 3-1.34 3-3V3c0-1.66-1.34-3-3-3zm-4 22h-4v-1h4v1zm5.25-3H4.75V3h14.5v16z",
  refresh: "M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  more: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
  link: "M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z",
  notes: "M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z",
  call: "M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z",
  copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
  open: "M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  received: "M20 5.41L18.59 4 7 15.59V9H5v10h10v-2H8.41z",
  sent: "M9 5v2h6.59L4 18.59 5.41 20 17 8.41V15h2V5z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  error: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  history: "M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2.1 5l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z",
} as const;

export type IconName = keyof typeof P;

// Brand shield with the up-arrow cutout (brand/pusharmor-icon-*.svg geometry).
const SHIELD = "M256 108 L376 150 V250 C376 330 322 382 256 406 C190 382 136 330 136 250 V150 Z M256 168 L318 236 H280 V334 H232 V236 H194 Z";

function el(tag: string, attrs: Record<string, string | number> = {}, ...kids: SVGElement[]): SVGElement {
  const e = document.createElementNS(NS, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

function svg(viewBox: string, size: number | [number, number], cls: string, ...kids: SVGElement[]): SVGElement {
  const [w, h] = typeof size === "number" ? [size, size] : size;
  return el("svg", { viewBox, width: w, height: h, class: cls, "aria-hidden": "true", focusable: "false" }, ...kids);
}

/** A 24-unit icon in currentColor. */
export function icon(name: IconName, size = 20): SVGElement {
  return svg("0 0 24 24", size, "ic", el("path", { d: P[name], fill: "currentColor" }));
}

/** Platform glyph for a peer row. */
export function platformIcon(platform: string, size = 18): SVGElement {
  return icon(platform === "chrome" ? "laptop" : platform === "firefox" ? "desktop" : "phone", size);
}

/** Monochrome shield silhouette (hero watermark, fingerprint label). */
export function shield(size: number): SVGElement {
  return svg("120 96 272 324", size, "shield", el("path", { d: SHIELD, fill: "currentColor", "fill-rule": "evenodd" }));
}

function tileKids(large: boolean): SVGElement[] {
  const mark = el("path", { d: SHIELD, fill: "#34C77B", "fill-rule": "evenodd" });
  return [
    el("rect", { width: 512, height: 512, rx: 112, fill: "#1F3A5F" }),
    large ? el("g", { transform: "translate(256 257) scale(1.22) translate(-256 -257)" }, mark) : mark,
  ];
}

/** The app tile (navy rounded square, green shield); large geometry at 40 px and up. */
export function tile(size: number): SVGElement {
  return svg("0 0 512 512", size, "tile", ...tileKids(size >= 40));
}

/** Peers empty state: brand tile, dashed orbit, three waiting devices. */
export function devicesArt(size = 160): SVGElement {
  const sat = (cx: number, cy: number, name: IconName): SVGElement[] => [
    el("circle", { class: "i-sat", cx, cy, r: 19 }),
    el("g", { transform: "translate(" + (cx - 9) + " " + (cy - 9) + ") scale(.75)" }, el("path", { class: "i-glyph", d: P[name] })),
  ];
  return svg(
    "0 0 200 200", size, "illo",
    el("circle", { class: "i-disc", cx: 100, cy: 100, r: 60 }),
    el("circle", { class: "i-orbit", cx: 100, cy: 100, r: 88 }),
    ...sat(100, 12, "phone"), ...sat(176.2, 144, "laptop"), ...sat(23.8, 144, "tablet"),
    el("svg", { x: 72, y: 72, width: 56, height: 56, viewBox: "0 0 512 512" }, ...tileKids(true)),
  );
}

/** History empty state: three stacked message cards, the front one with a link chip. */
export function messagesArt(): SVGElement {
  return svg(
    "0 0 200 170", [170, 145], "illo",
    el("circle", { class: "i-fill", cx: 100, cy: 88, r: 74 }),
    el("rect", { class: "i-card", x: 52, y: 26, width: 96, height: 40, rx: 10, opacity: ".55" }),
    el("rect", { class: "i-card", x: 40, y: 48, width: 120, height: 46, rx: 12, opacity: ".8" }),
    el("rect", { class: "i-card", x: 26, y: 76, width: 148, height: 62, rx: 14 }),
    el("rect", { class: "i-chip", x: 40, y: 91, width: 32, height: 32, rx: 9 }),
    el("g", { transform: "translate(46 97) scale(.85)" }, el("path", { class: "i-glyph", d: P.link })),
    el("rect", { class: "i-bar", x: 82, y: 96, width: 76, height: 8, rx: 4 }),
    el("rect", { class: "i-bar", x: 82, y: 111, width: 50, height: 8, rx: 4 }),
  );
}

/** Full-colour Google G (sign-in button). */
export function googleLogo(): SVGElement {
  const parts: [string, string][] = [
    ["#EA4335", "M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"],
    ["#4285F4", "M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"],
    ["#FBBC05", "M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"],
    ["#34A853", "M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"],
  ];
  return svg("0 0 48 48", 18, "logo", ...parts.map(([fill, d]) => el("path", { fill, d })));
}

/** Apple logo in currentColor (sign-in button). */
export function appleLogo(): SVGElement {
  return svg(
    "0 0 384 512", [16, 18], "logo",
    el("path", {
      fill: "currentColor",
      d: "M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z",
    }),
  );
}

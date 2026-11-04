// A small fake DOM for UI tests that only need elements, text, and the body.
export class N {
  tag: string;
  attrs: Record<string, string> = {};
  kids: N[] = [];
  parent: N | null = null;
  on: Record<string, ((ev: unknown) => void)[]> = {};
  text = "";
  cls = new Set<string>();
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k: string, f: (ev: unknown) => void) {
    (this.on[k] ??= []).push(f);
  }
  removeEventListener(k: string, f: (ev: unknown) => void) {
    this.on[k] = (this.on[k] ?? []).filter((x) => x !== f);
  }
  append(...xs: (N | string | null)[]) {
    for (const x of xs) {
      if (x === null) continue;
      const n = typeof x === "string" ? Object.assign(new N("#text"), { text: x }) : x;
      n.parent = this;
      this.kids.push(n);
    }
  }
  get children(): N[] {
    return this.kids;
  }
  get firstChild(): N | null {
    return this.kids[0] ?? null;
  }
  prepend(x: N) {
    this.append(x);
    this.kids.unshift(this.kids.pop()!);
  }
  replaceChildren(...xs: (N | string)[]) {
    this.kids = [];
    this.append(...xs);
  }
  removeChild(n: N) {
    n.remove();
  }
  remove() {
    if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
    this.parent = null;
  }
  contains(n: N | null): boolean {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  focus() {}
  get parentElement(): N | null {
    return this.parent;
  }
  /** class selectors only (".a.b"): descendants that carry every class. */
  querySelectorAll(sel: string): N[] {
    const want = sel.split(".").filter(Boolean);
    const has = (n: N, c: string) => n.cls.has(c) || (n.attrs.class ?? "").split(" ").includes(c);
    const out: N[] = [];
    const walk = (n: N) => {
      for (const k of n.kids) {
        if (want.every((c) => has(k, c))) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out;
  }
  querySelector() {
    return null;
  }
  get textContent(): string {
    return this.tag === "#text" ? this.text : this.text + this.kids.map((k) => k.textContent).join("");
  }
  set textContent(v: string) {
    this.kids = [];
    this.text = v;
  }
  get classList() {
    return { add: (c: string) => void this.cls.add(c), remove: (c: string) => void this.cls.delete(c), contains: (c: string) => this.cls.has(c), toggle: (c: string, on: boolean) => void (on ? this.cls.add(c) : this.cls.delete(c)) };
  }
}

export const body = new N("body");
const doc = new N("#document");
(globalThis as unknown as { document: unknown }).document = {
  body,
  documentElement: new N("html"),
  createElement: (t: string) => new N(t),
  createTextNode: (s: string) => Object.assign(new N("#text"), { text: s }),
  createElementNS: (_: string, t: string) => new N(t),
  querySelector: () => null,
  addEventListener: doc.addEventListener.bind(doc),
  removeEventListener: doc.removeEventListener.bind(doc),
};

export const toastEl = () => body.kids.find((k) => k.attrs.class?.startsWith("toast"));

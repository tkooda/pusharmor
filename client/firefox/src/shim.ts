// The "browser" namespace for Firefox (promise-returning browser.*).
import type { Browser } from "../../webext-common/src/shim-types.ts";

export const browser = (globalThis as unknown as { browser: Browser }).browser;

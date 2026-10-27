// The "browser" namespace for Chrome MV3 (promise-returning chrome.*).
import type { Browser } from "../../webext-common/src/shim-types.ts";

export const browser = (globalThis as unknown as { chrome: Browser }).chrome;

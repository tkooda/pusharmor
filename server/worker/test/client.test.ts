import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMinClient, minFloors, parseClient } from "../src/pipeline/client";

const floors = (min: string | undefined) => Object.fromEntries(minFloors(min));
const blocked = (h: string | null, min: string | undefined, signed = true) => {
  try {
    checkMinClient(parseClient(h), min, signed);
    return false;
  } catch {
    return true;
  }
};

describe("PA_MIN_CLIENT resolver", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a per-platform list; an unlisted platform has no floor", () => {
    const min = "ios/0.0.47 cli/0.0.42 android/0.0.28";
    expect(floors(min)).toEqual({ ios: [0, 0, 47], cli: [0, 0, 42], android: [0, 0, 28] });
    expect(blocked("ios/0.0.46", min)).toBe(true);
    expect(blocked("ios/0.0.47", min)).toBe(false);
    expect(blocked("android/0.0.27", min)).toBe(true);
    expect(blocked("chrome/0.0.1", min)).toBe(false);
    expect(blocked("web/0.0.1", min)).toBe(false);
  });

  it("accepts spaces and/or commas as separators", () => {
    expect(floors(" ios/0.0.47,cli/0.0.42 ,  android/0.0.28,,\tweb/0.1.0 ")).toEqual({
      ios: [0, 0, 47], cli: [0, 0, 42], android: [0, 0, 28], web: [0, 1, 0],
    });
  });

  it("a platform listed twice takes its highest floor", () => {
    expect(floors("ios/0.0.50 ios/0.0.47")).toEqual({ ios: [0, 0, 50] });
    expect(floors("ios/0.0.47 ios/0.1.0")).toEqual({ ios: [0, 1, 0] });
  });

  it("skips malformed entries, a bare version, and the old = form, warning once each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const min = "0.0.28 ios=0.0.47 mac/1.0.0 android/0.0 cli/0.0.42 cli/x";
    expect(floors(min)).toEqual({ cli: [0, 0, 42] });
    expect(blocked("ios/0.0.1", min)).toBe(false);
    expect(blocked("android/0.0.1", min)).toBe(false);
    expect(blocked("cli/0.0.41", min)).toBe(true);
    const skipped = warn.mock.calls.map((c) => String(c[0]));
    for (const e of ["0.0.28", "ios=0.0.47", "mac/1.0.0", "android/0.0", "cli/x"]) {
      expect(skipped.filter((s) => s.includes(`"${e}"`)), e).toHaveLength(1);
    }
    // Only malformed entries: no floor, so nothing is blocked.
    expect(blocked(null, "0.0.28")).toBe(false);
    expect(blocked("ios/0.0.1", "ios=0.0.47")).toBe(false);
  });

  it("empty or unset never blocks", () => {
    for (const min of [undefined, "", " , "]) {
      expect(floors(min)).toEqual({});
      expect(blocked("ios/0.0.1", min)).toBe(false);
      expect(blocked(null, min)).toBe(false);
    }
  });

  it("a missing or malformed header blocks only a signed request, and only with a floor set", () => {
    expect(blocked(null, "ios/0.0.47")).toBe(true);
    expect(blocked("ios/0.1", "ios/0.0.47")).toBe(true);
    expect(blocked(null, "ios/0.0.47", false)).toBe(false);
  });
});

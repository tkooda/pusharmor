/// <reference types="vite/client" />
// Shard readiness (I448): one D1 access point; bucket by account id; still one database.
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlEncode } from "../src/codec/b64url";
import { allDbs, BUCKETS, bucketOf, dbFor, globalDb, SHARD_MAP } from "../src/db/shard";
import { testEnv } from "./helpers";

const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("D1 access goes through src/db/shard.ts (I448)", () => {
  it("no other source file touches the DB binding", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const bad = Object.entries(sources)
      .filter(([f]) => !f.endsWith("/db/shard.ts") && !f.endsWith("/env.ts"))
      .filter(([, src]) => /\benv\.DB\b|\.DB\./.test(src))
      .map(([f]) => f);
    expect(bad).toEqual([]);
  });

  it("bucket = first 8 bits of the decoded account id; every bucket maps to the one database", async () => {
    expect(BUCKETS).toBe(256);
    expect(SHARD_MAP).toHaveLength(BUCKETS);
    for (let b = 0; b < 256; b++) {
      const raw = new Uint8Array(9);
      raw[0] = b;
      crypto.getRandomValues(raw.subarray(1));
      expect(bucketOf(b64urlEncode(raw))).toBe(b);
    }
    expect(() => bucketOf("short")).toThrow();
    const e = await testEnv();
    expect(dbFor(e, "AAAAAAAAAAAA")).toBe(e.DB);
    expect(dbFor(e, "____________")).toBe(e.DB);
    expect(globalDb(e)).toBe(e.DB);
    expect(allDbs(e)).toEqual([e.DB]);
    expect(env.DB).toBeTruthy();
  });
});

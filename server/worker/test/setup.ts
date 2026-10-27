import { applyD1Migrations, env } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import { recordHealth, type VendorName } from "../src/push/results";
import { clearJwks } from "../src/auth/jwks";
import { captured, installVendorMock, scrubViolations } from "./helpers";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    captured.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    captured.push(a.map(String).join(" "));
  });
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM peers"), env.DB.prepare("DELETE FROM accounts")]);
  // Fresh vendor health through public behavior: a record for hour 0 replaces each vendor's
  // current-hour counts, so no current hour carries counts from an earlier test.
  for (const v of ["fcm", "apns", "wp", "up"] as VendorName[]) recordHealth(v, false, false, 0);
  clearJwks();
  installVendorMock(); // a new transport: empty token cache (deps.transportScoped)
});

// Log scrub: no fixture secret, email, email_hash, token, endpoint, message, code or ticket
// may appear in any captured log line.
afterAll(() => {
  if (scrubViolations(captured) > 0) throw new Error("log scrub: a sensitive fixture string appeared in the log output");
});

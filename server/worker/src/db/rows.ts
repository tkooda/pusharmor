// Row -> API object mapping and the relay filter.
import { pushSha256 } from "../codec/validate";

// False only for a cli peer whose push endpoint failed (ntfy 507) since its last listen report.
export function isListening(platform: string, pushFailed: number | null): boolean {
  return platform !== "cli" || pushFailed === null;
}

export interface ListRow {
  id: string;
  sign_pub: string;
  enc_pub: string;
  platform: string;
  push_type: number | null;
  created: number;
  allow: string;
  push_failed: number | null;
  approves_me: number;
  denies_me: number;
  reachable: number;
  logged_out: number;
  my_push: string | null;
  name_for_me: string | null;
}

export interface CtxRow {
  id: string;
  sign_pub: string;
  enc_pub: string;
  platform: string;
  push_failed: number | null;
  push_type: number | null;
  push: string | null;
  push_verified_at: number | null;
  logged_out: number;
  approves_me: number;
  denies_me: number;
  my_allow: string | null;
  seen?: number | null;
}

function allowKeys(allow: string | null): string[] {
  if (!allow) return [];
  try {
    const o = JSON.parse(allow);
    return o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : [];
  } catch {
    return [];
  }
}

export function myAllowKeys(myAllow: string | null): string[] {
  return allowKeys(myAllow);
}

// GET /peers body (also POST /peers reply).
export async function listBody(rows: ListRow[], me: string): Promise<Record<string, unknown>> {
  const allows = new Map(rows.map((r) => [r.id, new Set(allowKeys(r.allow))]));
  const self = rows.find((r) => r.id === me);
  let myPush: string | null = null;
  if (self && self.my_push) myPush = await pushSha256(JSON.parse(self.my_push) as Record<string, unknown>);
  const peers = rows.map((r) => {
    let approvedBy = 0;
    for (const s of allows.values()) if (s.has(r.id)) approvedBy++;
    return {
      id: r.id,
      sign_pub: r.sign_pub,
      enc_pub: r.enc_pub,
      platform: r.platform,
      created: r.created,
      logged_out: r.logged_out === 1,
      approves: allows.get(r.id)!.size,
      approved_by: approvedBy,
      approves_me: r.approves_me === 1,
      denies_me: r.denies_me === 1,
      reachable: r.reachable === 1,
      name_for_me: r.name_for_me ?? null,
      ...(r.platform === "cli" ? { listening: isListening(r.platform, r.push_failed) } : {}),
    };
  });
  return { my_push_sha256: myPush, my_allow: self ? allowKeys(self.allow) : [], peers };
}

// 409 "peer limit" list entries.
export function limitPeers(rows: ListRow[]): Record<string, unknown>[] {
  const allows = new Map(rows.map((r) => [r.id, new Set(allowKeys(r.allow))]));
  return rows.map((r) => {
    let approvedBy = 0;
    for (const s of allows.values()) if (s.has(r.id)) approvedBy++;
    return {
      id: r.id,
      sign_pub: r.sign_pub,
      enc_pub: r.enc_pub,
      platform: r.platform,
      created: r.created,
      approves: allows.get(r.id)!.size,
      approved_by: approvedBy,
      reachable: r.reachable === 1,
      logged_out: r.logged_out === 1,
    };
  });
}

export function isUnconfirmedUp(pushType: number | null, verifiedAt: number | null): boolean {
  return pushType === 6 && verifiedAt === null;
}

export interface RelayRow {
  approves_me: boolean;
  denies_me: boolean;
  logged_out: boolean;
  listening: boolean;
  push_type: number | null;
  push: string | null;
  push_verified_at: number | null;
}

// Relay filter, /send order: unknown, denied, unapproved, logged out, not listening, gone,
// unconfirmed type 6.
// Returns a result word, or null when the message goes to the vendor.
export function relayFilter(row: RelayRow | undefined): string | null {
  if (!row) return "unknown";
  if (row.denies_me) return "denied";
  if (!row.approves_me) return "unapproved";
  if (row.logged_out) return "logged out";
  if (!row.listening) return "not listening";
  if (row.push === null || row.push_type === null) return "gone";
  if (isUnconfirmedUp(row.push_type, row.push_verified_at)) return "failed";
  return null;
}

export function ctxRelayRow(r: CtxRow | undefined): RelayRow | undefined {
  return (
    r && {
      approves_me: r.approves_me === 1,
      denies_me: r.denies_me === 1,
      logged_out: r.logged_out === 1,
      listening: isListening(r.platform, r.push_failed),
      push_type: r.push_type,
      push: r.push,
      push_verified_at: r.push_verified_at,
    }
  );
}

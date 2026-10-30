// D1 cost step (I251): meta.rows_read / rows_written per endpoint, measured on local D1,
// must equal the committed fixture test/d1-cost.json. No test reads the catalog table.
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { b64urlEncode } from "../src/codec/b64url";
import { probeCode } from "../src/routes/common";
import fixture from "./d1-cost.json";
import { call, captured, initP256, keys, message, newPeer, pushFor, randomEmail, register, setAllow, ticketFor, type CallResult, type Peer } from "./helpers";
import { TEST_SECRETS as S } from "./secrets";

beforeAll(initP256);

interface Entry {
  endpoint: string;
  n: number;
  k: number;
  q: number;
  rows_read: number;
  rows_written: number;
}

async function account(n: number, platform = "android"): Promise<Peer[]> {
  const email = randomEmail();
  const out: Peer[] = [];
  for (let i = 0; i < n; i++) out.push(await newPeer(email, platform));
  return out;
}

// Approved both ways between me and every other peer.
async function allApproved(ps: Peer[]): Promise<void> {
  for (const p of ps) await setAllow(p, ps.filter((x) => x.id !== p.id).map((x) => x.id));
}

// q pending entries in me's row (approves stored for q other peers).
async function pending(me: Peer, others: Peer[], q: number): Promise<void> {
  const o: Record<string, string> = {};
  for (const x of others.slice(0, q)) o[x.id] = message(1024);
  await env.DB.prepare("UPDATE peers SET pending = ?1 WHERE id = ?2").bind(JSON.stringify(o), me.id).run();
}

async function measured(run: () => Promise<CallResult>): Promise<{ rows_read: number; rows_written: number; status: number }> {
  const before = captured.length;
  const r = await run();
  const lines = captured.slice(before).map((l) => JSON.parse(l)).filter((o) => o.route && o.route !== "cron");
  const last = lines[lines.length - 1];
  return { rows_read: last.rows_read ?? 0, rows_written: last.rows_written ?? 0, status: r.status };
}

const ghost = (p: Peer) => p.acct + b64urlEncode(crypto.getRandomValues(new Uint8Array(21)));
const mOf = (ps: Peer[]) => Object.fromEntries(ps.map((p) => [p.id, message(512)]));

type Scenario = { endpoint: string; n: number; k: number; q: number; run: () => Promise<{ rows_read: number; rows_written: number; status: number }> };

const NS = [1, 5, 10];
const scenarios: Scenario[] = [];
for (const n of NS) {
  scenarios.push({
    endpoint: "POST /peers (new)", n, k: 0, q: 0,
    run: async () => {
      const ps = n > 1 ? await account(n - 1) : [];
      const email = ps[0]?.email ?? randomEmail();
      return measured(async () => (await register(email, "android")).r);
    },
  });
  scenarios.push({
    endpoint: "POST /peers (re-register)", n, k: 0, q: 0,
    run: async () => {
      const ps = await account(n);
      const me = ps[0];
      const body = { ticket: await ticketFor(me.email, me.signPub, "register"), sign_pub: me.signPub, enc_pub: me.encPub, platform: "android", push: pushFor("android") };
      return measured(() => call("POST", "/v1/peers", body, { sign: me.sign }));
    },
  });
  scenarios.push({ endpoint: "GET /peers", n, k: 0, q: 0, run: async () => { const ps = await account(n); return measured(() => call("GET", "/v1/peers", undefined, { peer: ps[0] })); } });
  scenarios.push({ endpoint: "PATCH push", n, k: 0, q: 0, run: async () => { const ps = await account(n); return measured(() => call("PATCH", "/v1/peers/" + ps[0].id, { push: pushFor("android") }, { peer: ps[0] })); } });
  scenarios.push({
    endpoint: "PATCH rename", n, k: n - 1, q: 0,
    run: async () => {
      const ps = await account(n);
      await allApproved(ps);
      const others = ps.slice(1);
      const name = Object.fromEntries(others.map((p) => [p.id, message(200)]));
      return measured(() => call("PATCH", "/v1/peers/" + ps[0].id, { name, m: mOf(others) }, { peer: ps[0] }));
    },
  });
  scenarios.push({
    endpoint: "POST logout", n, k: n - 1, q: 0,
    run: async () => {
      const ps = await account(n);
      await allApproved(ps);
      return measured(() => call("POST", `/v1/peers/${ps[0].id}/logout`, { m: mOf(ps.slice(1)) }, { peer: ps[0] }));
    },
  });
  scenarios.push({
    endpoint: "DELETE /peers/$id", n, k: 0, q: 0,
    run: async () => {
      const ps = await account(n);
      await allApproved(ps);
      const target = ps[ps.length - 1];
      return measured(() => call("DELETE", "/v1/peers/" + target.id, { m: {} }, { peer: ps[0] }));
    },
  });
  scenarios.push({
    endpoint: "DELETE /account", n, k: 0, q: 0,
    run: async () => {
      const ps = await account(n);
      const me = ps[0];
      return measured(async () => call("DELETE", "/v1/account", { ticket: await ticketFor(me.email, me.signPub, "delete-account"), sign_pub: me.signPub, m: {} }, { sign: me.sign }));
    },
  });
  scenarios.push({
    endpoint: "POST /send", n, k: n - 1, q: 0,
    run: async () => {
      const ps = await account(n);
      await allApproved(ps);
      return measured(() => call("POST", "/v1/send", { v: 1, m: mOf(ps.slice(1)) }, { peer: ps[0] }));
    },
  });
  scenarios.push({
    endpoint: "POST /deny/$X (withdraw)", n, k: 0, q: 0,
    run: async () => {
      const ps = await account(n);
      const x = n > 1 ? ps[1].id : ghost(ps[0]);
      return measured(() => call("POST", "/v1/deny/" + x, { withdraw: 1 }, { peer: ps[0] }));
    },
  });
}
// Pair, approve, deny: n >= 2 has a real X; n = 1 is the X-unknown path. q <= n - 1.
const GRID: [number, number][] = [[1, 0], [5, 4], [10, 0], [10, 9]];
for (const [n, q] of GRID) {
  const setup = async () => {
    const ps = await account(n);
    const me = ps[0];
    const x = n > 1 ? ps[1].id : ghost(me);
    await pending(me, ps.slice(1), q);
    return { ps, me, x };
  };
  scenarios.push({ endpoint: "POST /approve/$X (stored)", n, k: 1, q, run: async () => { const { me, x } = await setup(); return measured(() => call("POST", "/v1/approve/" + x, { c: message(1024), name: message(200) }, { peer: me })); } });
  scenarios.push({
    endpoint: "POST /approve/$X (relay)", n, k: 1, q,
    run: async () => {
      const { ps, me, x } = await setup();
      if (n > 1) await setAllow(ps[1], [me.id]);
      return measured(() => call("POST", "/v1/approve/" + x, { c: message(1024), name: message(200) }, { peer: me }));
    },
  });
  scenarios.push({
    endpoint: "POST /deny/$X", n, k: 1, q,
    run: async () => {
      const { ps, me, x } = await setup();
      if (n > 1) await setAllow(ps[1], [me.id]);
      return measured(() => call("POST", "/v1/deny/" + x, { c: message(512) }, { peer: me }));
    },
  });
  if (q === 0) scenarios.push({ endpoint: "POST /pair/$X", n, k: 1, q, run: async () => { const { me, x } = await setup(); return measured(() => call("POST", "/v1/pair/" + x, { k: "commit", c: message(364) + "AA" }, { peer: me })); } });
}
scenarios.push({
  endpoint: "POST /peers (409)", n: 10, k: 0, q: 0,
  run: async () => {
    const ps = await account(10);
    return measured(async () => (await register(ps[0].email, "android")).r);
  },
});
scenarios.push({
  endpoint: "POST /peers (evict 1)", n: 10, k: 0, q: 0,
  run: async () => {
    const ps = await account(10);
    await allApproved(ps);
    return measured(async () => (await register(ps[0].email, "android", undefined, { evict: [ps[9].id] })).r);
  },
});
scenarios.push({
  endpoint: "POST login", n: 5, k: 4, q: 0,
  run: async () => {
    const ps = await account(5);
    await allApproved(ps);
    await env.DB.prepare("UPDATE peers SET logged_out = 1 WHERE id = ?1").bind(ps[0].id).run();
    return measured(async () => call("POST", `/v1/peers/${ps[0].id}/login`, { ticket: await ticketFor(ps[0].email, ps[0].signPub, "login"), m: mOf(ps.slice(1)) }, { peer: ps[0] }));
  },
});
scenarios.push({
  endpoint: "POST confirm", n: 1, k: 0, q: 0,
  run: async () => {
    const [p] = await account(1, "android");
    const push = pushFor("android", "unifiedpush");
    await env.DB.prepare("UPDATE peers SET push = ?1, push_type = 6 WHERE id = ?2").bind(JSON.stringify(push), p.id).run();
    const code = await probeCode(S.PA_CONFIRM_SECRET, p.id, push, Math.floor(Date.now() / 1000 / 300));
    return measured(() => call("POST", `/v1/peers/${p.id}/confirm`, { code }, { peer: p }));
  },
});

describe("D1 cost per endpoint (fixture test/d1-cost.json)", () => {
  const fx = fixture as Entry[];
  for (const s of scenarios) {
    it(`${s.endpoint} n=${s.n} k=${s.k} q=${s.q}`, async () => {
      const m = await s.run();
      expect(m.status).toBeLessThan(500);
      const got: Entry = { endpoint: s.endpoint, n: s.n, k: s.k, q: s.q, rows_read: m.rows_read, rows_written: m.rows_written };
      const want = fx.find((e) => e.endpoint === s.endpoint && e.n === s.n && e.k === s.k && e.q === s.q);
      if (!want || want.rows_read !== got.rows_read || want.rows_written !== got.rows_written) console.warn("D1COST " + JSON.stringify(got));
      expect(got).toEqual(want);
      // Ceilings against an accidental full scan of the account (I274): 6 + q + n (approve)
      // and 4 + q + n (deny).
      if (s.endpoint.startsWith("POST /approve")) expect(m.rows_read).toBeLessThanOrEqual(6 + s.q + s.n);
      if (s.endpoint === "POST /deny/$X") expect(m.rows_read).toBeLessThanOrEqual(4 + s.q + s.n);
    });
  }
  it("fixture has no stale entries", () => {
    expect(fx.length).toBe(scenarios.length);
  });
  it("keys helper sanity", async () => {
    expect((await keys()).signPub).toHaveLength(87);
  });
});

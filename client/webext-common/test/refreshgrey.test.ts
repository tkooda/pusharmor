import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { N } from "./fakedom.ts";
import { renderPeers } from "../src/ui/peersview.ts";
import type { UiEnv } from "../src/ui/dom.ts";

const all = (n: N): N[] => [n, ...n.kids.flatMap(all)];

test("Refresh: after a click it keeps its label and is greyed for 10 s, with no countdown", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  try {
    const ops: string[] = [];
    const env = { call: async (req: { op: string }) => (ops.push(req.op), { ok: true, data: req.op === "peers" ? { peers: [] } : null }) } as unknown as UiEnv;
    const root = new N("div");
    await renderPeers(env, root as unknown as HTMLElement, false);
    const btn = () => all(root).find((n) => n.tag === "button" && n.textContent === "Refresh") as unknown as HTMLButtonElement & N;
    assert.ok(btn() && !btn().disabled);
    for (const f of btn().on.click!) f({});
    for (let i = 0; i < 10 && ops.filter((o) => o === "peers").length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.ok(ops.includes("refresh"));
    // the list was drawn again: the new button is greyed with the plain label
    assert.ok(btn(), "label stays Refresh");
    assert.equal(btn().disabled, true);
    mock.timers.tick(5_000);
    assert.equal(btn().textContent, "Refresh");
    assert.equal(btn().disabled, true);
    mock.timers.tick(5_000);
    assert.equal(btn().disabled, false);
    assert.equal(btn().textContent, "Refresh");
  } finally {
    mock.timers.reset();
  }
});

test("Devices: a pairing that completes by push shows at once in a list with paired devices; Refresh stays clickable", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 5_000_000 });
  try {
    const row = (id: string, label: string, paired: boolean) => ({ id, label, platform: "android", lines: paired ? [] : ["Waiting for " + label], actions: ["remove"], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: paired, approvesMe: paired, paired });
    let peers = [row("a", "Laptop", true), row("b", "Phone", false)];
    const env = { call: async (req: { op: string }) => ({ ok: true, data: req.op === "peers" ? { peers } : null }) } as unknown as UiEnv;
    const root = Object.assign(new N("div"), { isConnected: true });
    await renderPeers(env, root as unknown as HTMLElement, false);
    assert.match(root.textContent, /Waiting for Phone/);
    peers = [row("a", "Laptop", true), row("b", "Phone", true)]; // the other device approved: the push updated the local list
    mock.timers.tick(3000);
    for (let i = 0; i < 10 && /Waiting for Phone/.test(root.textContent); i++) await new Promise((r) => setImmediate(r));
    assert.doesNotMatch(root.textContent, /Waiting for Phone/);
    const btn = all(root).find((n) => n.tag === "button" && n.textContent === "Refresh") as unknown as HTMLButtonElement;
    assert.equal(btn.disabled, undefined); // never set: not greyed
    root.isConnected = false;
    mock.timers.tick(3000);
  } finally {
    mock.timers.reset();
  }
});

test("Try again: after a click it is greyed for 10 s across redraws, then clickable again", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 2_000_000 });
  try {
    const ops: string[] = [];
    const row = { id: "b", label: "Phone", platform: "android", lines: ['No reply from "Phone"', "Check that notifications are on for PushArmor on both devices, then try again"], actions: ["try_again", "cancel"], countdown: null, fingerprint: null, pk: null, greyed: null, hidden: false, sendable: false, approvesMe: null, paired: false };
    const env = { call: async (req: { op: string }) => (ops.push(req.op), { ok: true, data: req.op === "peers" ? { peers: [row] } : null }) } as unknown as UiEnv;
    const root = new N("div");
    await renderPeers(env, root as unknown as HTMLElement, false);
    const btn = () => all(root).find((n) => n.tag === "button" && n.textContent === "Try again") as unknown as HTMLButtonElement & N;
    assert.ok(btn() && !btn().disabled);
    for (const f of btn().on.click!) f({});
    for (let i = 0; i < 10 && ops.filter((o) => o === "peers").length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.equal(ops.filter((o) => o === "tryAgain").length, 1);
    // the list was drawn again: the new button is still greyed
    assert.equal(btn().disabled, true);
    mock.timers.tick(9_000);
    assert.equal(btn().disabled, true);
    mock.timers.tick(1_000);
    assert.equal(btn().disabled, false);
  } finally {
    mock.timers.reset();
  }
});

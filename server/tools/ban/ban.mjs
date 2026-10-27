#!/usr/bin/env node
// Operator ban script. Usage: node ban.mjs <email>
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  normalizeEmail,
  emailHash,
  accountId,
  assertAccountId,
  banSql,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workerDir = path.resolve(here, "../../worker");
const wrangler =
  process.env.WRANGLER || path.join(workerDir, "node_modules/.bin/wrangler");

const email = process.argv[2];
if (!email || process.argv.length !== 3) {
  console.error("usage: node ban.mjs <email>");
  process.exit(2);
}
const secret = process.env.PA_ID_SECRET;
if (!secret) {
  console.error("PA_ID_SECRET is not set");
  process.exit(2);
}

let id;
try {
  id = await accountId(secret, await emailHash(normalizeEmail(email)));
  assertAccountId(id);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const sql = banSql(id, Math.floor(Date.now() / 1000));
console.log("account id: " + id);
console.log(sql);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question("type the account id to confirm: ");
rl.close();
if (answer.trim() !== id) {
  console.error("not confirmed; nothing done");
  process.exit(1);
}

const r = spawnSync(
  wrangler,
  ["d1", "execute", "pusharmor", "--remote", "--command", sql],
  { cwd: workerDir, stdio: "inherit" },
);
process.exit(r.status === null ? 1 : r.status);

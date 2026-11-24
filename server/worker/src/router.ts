// Static route table: exact segment match. ":id" segments must be valid ids, ":file" segments
// file ids (expiry minute + "-" + 32 lowercase hex).
import type { Ctx } from "./context";
import { ApiError } from "./errors";
import { isId } from "./codec/validate";
import * as email from "./auth/email";
import * as google from "./auth/google";
import * as apple from "./auth/apple";
import * as peers from "./routes/peers";
import { deleteAccount } from "./routes/account";
import { approve, deny } from "./routes/approve";
import { pair } from "./routes/pair";
import { send } from "./routes/send";
import { health } from "./routes/health";
import { deleteFile, uploadFile } from "./routes/file";

export type Handler = (c: Ctx) => Promise<Response>;

interface Route {
  method: string;
  path: string; // template, ":id" for an id segment, ":file" for a file id segment
  handler: Handler | "preflight";
  stream?: true; // the handler reads req.body itself; no capped body read
}

export const ROUTES: Route[] = [
  { method: "POST", path: "/v1/auth/email", handler: email.start },
  { method: "POST", path: "/v1/auth/email/verify", handler: email.verify },
  { method: "GET", path: "/v1/auth/google", handler: google.start },
  { method: "GET", path: "/v1/auth/google/callback", handler: google.callback },
  { method: "POST", path: "/v1/auth/google/token", handler: google.token },
  { method: "GET", path: "/v1/auth/apple", handler: apple.start },
  { method: "POST", path: "/v1/auth/apple/callback", handler: apple.callback },
  { method: "POST", path: "/v1/auth/apple/token", handler: apple.token },
  { method: "POST", path: "/v1/peers", handler: peers.register },
  { method: "GET", path: "/v1/peers", handler: peers.list },
  { method: "PATCH", path: "/v1/peers/:id", handler: peers.patch },
  { method: "DELETE", path: "/v1/peers/:id", handler: peers.remove },
  { method: "POST", path: "/v1/peers/:id/logout", handler: peers.logout },
  { method: "POST", path: "/v1/peers/:id/login", handler: peers.login },
  { method: "POST", path: "/v1/peers/:id/confirm", handler: peers.confirm },
  { method: "POST", path: "/v1/peers/:id/check", handler: peers.check },
  { method: "DELETE", path: "/v1/account", handler: deleteAccount },
  { method: "POST", path: "/v1/approve/:id", handler: approve },
  { method: "POST", path: "/v1/deny/:id", handler: deny },
  { method: "POST", path: "/v1/pair/:id", handler: pair },
  { method: "POST", path: "/v1/send", handler: send },
  { method: "POST", path: "/v1/file", handler: uploadFile, stream: true },
  { method: "DELETE", path: "/v1/file/:file", handler: deleteFile },
  { method: "GET", path: "/v1/health", handler: health },
  { method: "OPTIONS", path: "/v1/auth/email", handler: "preflight" },
  { method: "OPTIONS", path: "/v1/auth/email/verify", handler: "preflight" },
  { method: "OPTIONS", path: "/v1/account", handler: "preflight" },
];

const FILE_ID = /^[0-9]{12}-[0-9a-f]{32}$/;

// Returns the segment values and whether every one is well formed.
function matchPath(template: string, path: string): { params: string[]; valid: boolean } | null {
  const t = template.split("/");
  const p = path.split("/");
  if (t.length !== p.length) return null;
  const params: string[] = [];
  let valid = true;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ":id" || t[i] === ":file") {
      params.push(p[i]);
      if (!(t[i] === ":id" ? isId(p[i]) : FILE_ID.test(p[i]))) valid = false;
    } else if (t[i] !== p[i]) return null;
  }
  return { params, valid };
}

export interface Match {
  template: string;
  handler: Handler | "preflight";
  params: string[];
  stream: boolean;
}

// Unknown path -> 404, known path with another method -> 405, bad id segment -> 400.
export function route(method: string, path: string): Match {
  let pathKnown = false;
  for (const r of ROUTES) {
    const m = matchPath(r.path, path);
    if (!m) continue;
    pathKnown = true;
    if (r.method !== method) continue;
    if (!m.valid) throw new ApiError(400, "bad request");
    return { template: `${r.method} ${r.path}`, handler: r.handler, params: m.params, stream: r.stream === true };
  }
  throw pathKnown ? new ApiError(405, "method not allowed") : new ApiError(404, "not found");
}

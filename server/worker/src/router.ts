// Static route table: exact segment match, no regex. ":id" segments must be valid ids.
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

export type Handler = (c: Ctx) => Promise<Response>;

interface Route {
  method: string;
  path: string; // template, ":id" for an id segment
  handler: Handler | "preflight";
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
  { method: "DELETE", path: "/v1/account", handler: deleteAccount },
  { method: "POST", path: "/v1/approve/:id", handler: approve },
  { method: "POST", path: "/v1/deny/:id", handler: deny },
  { method: "POST", path: "/v1/pair/:id", handler: pair },
  { method: "POST", path: "/v1/send", handler: send },
  { method: "OPTIONS", path: "/v1/auth/email", handler: "preflight" },
  { method: "OPTIONS", path: "/v1/auth/email/verify", handler: "preflight" },
  { method: "OPTIONS", path: "/v1/account", handler: "preflight" },
];

function matchPath(template: string, path: string): string[] | null {
  const t = template.split("/");
  const p = path.split("/");
  if (t.length !== p.length) return null;
  const params: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === ":id") params.push(p[i]);
    else if (t[i] !== p[i]) return null;
  }
  return params;
}

export interface Match {
  template: string;
  handler: Handler | "preflight";
  params: string[];
}

// Unknown path -> 404, known path with another method -> 405, bad id segment -> 400.
export function route(method: string, path: string): Match {
  let pathKnown = false;
  for (const r of ROUTES) {
    const params = matchPath(r.path, path);
    if (!params) continue;
    pathKnown = true;
    if (r.method !== method) continue;
    if (!params.every(isId)) throw new ApiError(400, "bad request");
    return { template: `${r.method} ${r.path}`, handler: r.handler, params };
  }
  throw pathKnown ? new ApiError(405, "method not allowed") : new ApiError(404, "not found");
}

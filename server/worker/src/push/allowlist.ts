// Web push endpoint allow-list (PA_ALLOWED_PUSH_ENDPOINTS) and the UnifiedPush
// (type 6) endpoint rules (PA_ALLOWED_UP_HOSTS). No regex on URLs; parse with URL().
export type EndpointReject = { host?: string; prefix_len?: number; reason?: string };

// Raw authority of an https URL string, or null.
function rawAuthority(s: string): string | null {
  if (!/^https:\/\//i.test(s)) return null;
  const rest = s.slice(8);
  const end = rest.search(/[/?#]/);
  return end < 0 ? rest : rest.slice(0, end);
}

function parse(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

export function prefixes(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// One Web push rule: an exact "host" or a "suffix" that starts with a dot (matched on a label
// boundary), and the path prefixes accepted on that host.
export type EndpointRule = { host?: string; suffix?: string; paths: string[] };

export function endpointRules(raw: string): EndpointRule[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is EndpointRule =>
        !!r &&
        typeof r === "object" &&
        (typeof r.host === "string" ? r.suffix === undefined : typeof r.suffix === "string" && r.suffix.startsWith(".") && r.suffix.length > 1) &&
        Array.isArray(r.paths) &&
        r.paths.every((x: unknown) => typeof x === "string" && x.startsWith("/")),
    );
  } catch {
    return [];
  }
}

function ruleHost(r: EndpointRule, host: string): boolean {
  if (r.host !== undefined) return host === r.host.toLowerCase();
  return host.endsWith(r.suffix!.toLowerCase());
}

// Returns the matched rule, or a reject record (host + longest matched path prefix length on a matched host).
// https only, no userinfo, no explicit port, a DNS name (not an IP literal, no empty label, no trailing dot).
export function checkWebpushEndpoint(endpoint: string, rules: EndpointRule[]): { rule: EndpointRule } | { reject: EndpointReject } {
  const u = parse(endpoint);
  const auth = rawAuthority(endpoint);
  if (!u || u.protocol !== "https:" || auth === null || auth.includes("@") || auth.includes(":") || u.username || u.password || u.port !== "") {
    return { reject: { host: u && u.protocol === "https:" ? u.hostname : undefined, prefix_len: 0 } };
  }
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || IPV4.test(host) || IPV4.test(auth.toLowerCase().replace(/\.$/, "")) || host.split(".").some((l) => l === "")) {
    return { reject: { host, prefix_len: 0, reason: "host" } };
  }
  let best = 0;
  for (const r of rules) {
    if (!ruleHost(r, host)) continue;
    for (const p of r.paths) {
      if (u.pathname.startsWith(p)) return { rule: r };
      best = Math.max(best, commonPrefix(u.pathname, p));
    }
  }
  return { reject: { host, prefix_len: best } };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const IPV4 = /^[0-9]+(\.[0-9]+){3}$/;

// UnifiedPush rule: https, port 443, no userinfo, DNS hostname with a dot, not in the reject list,
// host in the allow-list. Returns null when accepted, else a reason word (logged instead of the host).
export function checkUnifiedPushEndpoint(endpoint: string, hosts: string[]): string | null {
  const auth = rawAuthority(endpoint);
  const u = parse(endpoint);
  if (auth === null || !u || u.protocol !== "https:") return "scheme";
  if (auth.includes("@") || u.username || u.password) return "userinfo";
  if (auth.startsWith("[") || u.hostname.startsWith("[")) return "ip-literal";
  const colon = auth.lastIndexOf(":");
  if (colon >= 0 && auth.slice(colon + 1) !== "443") return "port";
  if (u.port !== "" && u.port !== "443") return "port";
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.split(".").some((l) => l === "")) return "label";
  if (!host.includes(".")) return "label"; // single-label names are not public DNS names
  if (IPV4.test(host)) return "ip-literal";
  const rawHost = (colon >= 0 ? auth.slice(0, colon) : auth).toLowerCase().replace(/\.$/, "");
  if (IPV4.test(rawHost)) return "ip-literal";
  if (host === "localhost" || /\.(localhost|local|internal|arpa)$/.test(host)) return "local";
  if (host === "pusharmor.com" || host.endsWith(".pusharmor.com") || host === "workers.dev" || host.endsWith(".workers.dev")) return "zone";
  if (!hosts.includes(host)) return "host";
  return null;
}

// UnifiedPush endpoints (cli and android): exactly https://<allowed host>/up<12 b64url chars>?up=1 (checked after
// checkUnifiedPushEndpoint). ntfy then charges the topic's subscriber, not the Worker.
export function cliTopicOk(endpoint: string): boolean {
  return /^https:\/\/[a-z0-9.-]+\/up[A-Za-z0-9_-]{12}\?up=1$/.test(endpoint);
}

// Sunup (android only): a Mozilla autopush v2 endpoint, bound to our VAPID key, so only the Worker can push to it.
export const SUNUP_PREFIX = "https://updates.push.services.mozilla.com/wpush/v2/";

const MOZILLA_HOST = "updates.push.services.mozilla.com";

// UnifiedPush endpoint shape per host and platform (checked after checkUnifiedPushEndpoint).
// The Mozilla host is decided on the parsed host with a trailing dot stripped, so "host." is refused too.
export function upShapeOk(platform: string, endpoint: string): boolean {
  if (parse(endpoint)?.hostname.replace(/\.$/, "") === MOZILLA_HOST) {
    return endpoint.startsWith(SUNUP_PREFIX) && platform === "android" && /^[A-Za-z0-9_=-]+$/.test(endpoint.slice(SUNUP_PREFIX.length));
  }
  return cliTopicOk(endpoint);
}

// Web push endpoint allow-list (ALLOWED_PUSH_ENDPOINT_PREFIXES) and the UnifiedPush
// (type 6) endpoint rule. No regex on URLs; parse with URL().
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

// Returns the matched prefix, or a reject record (host + longest matched prefix length).
export function checkWebpushEndpoint(endpoint: string, prefixList: string[]): { prefix: string } | { reject: EndpointReject } {
  const u = parse(endpoint);
  const auth = rawAuthority(endpoint);
  if (!u || u.protocol !== "https:" || auth === null || auth.includes("@") || auth.includes(":") || u.username || u.password) {
    return { reject: { host: u && u.protocol === "https:" ? u.hostname : undefined, prefix_len: 0 } };
  }
  let best = 0;
  for (const p of prefixList) {
    const pu = parse(p);
    if (!pu) continue;
    if (u.host === pu.host && u.pathname.startsWith(pu.pathname)) return { prefix: p };
    if (u.host === pu.host) best = Math.max(best, commonPrefix(endpoint, p));
  }
  return { reject: { host: u.hostname, prefix_len: best } };
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const IPV4 = /^[0-9]+(\.[0-9]+){3}$/;

// UnifiedPush rule: https, port 443, no userinfo, DNS hostname not in the reject list.
// Returns null when accepted, else a reason word (logged instead of the host).
export function checkUnifiedPushEndpoint(endpoint: string): string | null {
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
  if (IPV4.test(host)) return "ip-literal";
  const rawHost = (colon >= 0 ? auth.slice(0, colon) : auth).toLowerCase().replace(/\.$/, "");
  if (IPV4.test(rawHost)) return "ip-literal";
  if (host === "localhost" || /\.(localhost|local|internal|arpa)$/.test(host)) return "local";
  if (host === "pusharmor.com" || host.endsWith(".pusharmor.com") || host === "workers.dev" || host.endsWith(".workers.dev")) return "zone";
  return null;
}

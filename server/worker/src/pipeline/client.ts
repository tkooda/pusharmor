// PA-Client: "<platform>/<x.y.z>". Logged when well formed; 426 when older than PA_MIN_CLIENT.
// PA_MIN_CLIENT unset or malformed never blocks a request. With a floor set, a signed request
// (PA-ID or PA-Sig) with a missing or malformed header gets 426; an unsigned one passes.
// The website sends "delete-account" or "cli-login" instead: never held to a floor, and
// refused on every route and action other than its own.
import { ApiError } from "../errors";

const SITE = new Map<string, string[]>([
  ["delete-account", ["POST /v1/auth/email", "POST /v1/auth/email/verify", "DELETE /v1/account"]],
  ["cli-login", ["POST /v1/auth/email", "POST /v1/auth/email/verify"]],
]);

export function isSiteValue(h: string | null): boolean {
  return h !== null && SITE.has(h);
}

// Pipeline step: a website value on a route outside its action is refused.
export function checkSiteRoute(h: string | null, route: string): void {
  if (h !== null && SITE.has(h) && !SITE.get(h)!.includes(route)) throw new ApiError(426, "update required");
}

// Handler step: on a shared route, the value must name the action the body asks for
// (action is null for a request of neither action).
export function checkSiteAction(h: string | null, action: "delete-account" | "cli-login" | null): void {
  if (isSiteValue(h) && h !== action) throw new ApiError(426, "update required");
}

const PLATFORM = "(android|ios|chrome|firefox|web|cli)";
const CLIENT = new RegExp(`^${PLATFORM}\\/([0-9]{1,6})\\.([0-9]{1,6})\\.([0-9]{1,6})$`);

export function parseClient(h: string | null): { platform: string; version: number[] } | null {
  const m = h === null ? null : CLIENT.exec(h);
  return m ? { platform: m[1], version: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
}

function lower(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// PA_MIN_CLIENT is a list of "<platform>/<x.y.z>" entries separated by spaces and/or commas,
// e.g. "ios/0.0.47 cli/0.0.42 android/0.0.28": a floor per platform; an unlisted platform has
// none. Platforms skip version numbers, so one floor above the latest release of a platform
// would lock that platform out. A malformed entry (a bare "x.y.z", the old "ios=x.y.z") is
// skipped with one warning per isolate. A platform listed twice takes its highest floor.
const warned = new Set<string>();

export function minFloors(min: string | undefined): Map<string, number[]> {
  const floors = new Map<string, number[]>();
  for (const e of (min ?? "").split(/[\s,]+/)) {
    if (e === "") continue;
    const c = parseClient(e);
    if (c === null) {
      if (!warned.has(e)) {
        warned.add(e);
        console.warn(`PA_MIN_CLIENT: skipped malformed entry "${e}"`);
      }
      continue;
    }
    const prev = floors.get(c.platform);
    if (prev === undefined || lower(prev, c.version)) floors.set(c.platform, c.version);
  }
  return floors;
}

export function checkMinClient(client: { platform: string; version: number[] } | null, min: string | undefined, signed: boolean): void {
  const floors = minFloors(min);
  if (client === null) {
    if (signed && floors.size > 0) throw new ApiError(426, "update required");
    return;
  }
  const floor = floors.get(client.platform);
  if (floor !== undefined && lower(client.version, floor)) throw new ApiError(426, "update required");
}

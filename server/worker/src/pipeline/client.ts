// PA-Client: "<platform>/<x.y.z>". Logged when well formed; 426 when older than PA_MIN_CLIENT.
// A missing or malformed header, or PA_MIN_CLIENT unset or malformed, never blocks a request.
import { ApiError } from "../errors";

const CLIENT = /^(android|ios|chrome|firefox|web|cli)\/([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/;
const VERSION = /^([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})$/;

export function parseClient(h: string | null): { platform: string; version: number[] } | null {
  const m = h === null ? null : CLIENT.exec(h);
  return m ? { platform: m[1], version: [Number(m[2]), Number(m[3]), Number(m[4])] } : null;
}

function lower(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// PA_MIN_CLIENT is "x.y.z" (the floor of every platform) or a list "android=0.0.22,ios=0.0.20"
// (a floor per platform; an unlisted platform has none). Platforms skip version numbers, so
// one floor above the latest release of a platform would lock that platform out.
export function checkMinClient(client: { platform: string; version: number[] } | null, min: string | undefined): void {
  if (client === null || min === undefined) return;
  let floor = VERSION.exec(min);
  if (floor === null) {
    const hit = min.split(",").map((e) => /^([a-z]+)=(.+)$/.exec(e.trim())).find((m) => m !== null && m[1] === client.platform);
    floor = hit ? VERSION.exec(hit[2]) : null;
  }
  if (floor === null) return;
  if (lower(client.version, [Number(floor[1]), Number(floor[2]), Number(floor[3])])) throw new ApiError(426, "update required");
}

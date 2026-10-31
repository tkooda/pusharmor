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

export function checkMinClient(client: { version: number[] } | null, min: string | undefined): void {
  const m = min === undefined ? null : VERSION.exec(min);
  if (client === null || m === null) return;
  if (lower(client.version, [Number(m[1]), Number(m[2]), Number(m[3])])) throw new ApiError(426, "update required");
}

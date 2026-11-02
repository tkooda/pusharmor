/** Same prefix list the Worker uses (catalog Web push endpoint allow-list). */
export const ALLOWED_PUSH_ENDPOINT_PREFIXES = [
  "https://fcm.googleapis.com/fcm/send/",
  "https://fcm.googleapis.com/wp/",
  "https://updates.push.services.mozilla.com/wpush/v1/",
  "https://updates.push.services.mozilla.com/wpush/v2/",
];

export function endpointAllowed(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return ALLOWED_PUSH_ENDPOINT_PREFIXES.some((p) => {
    const pu = new URL(p);
    return u.host === pu.host && u.pathname.startsWith(pu.pathname);
  });
}

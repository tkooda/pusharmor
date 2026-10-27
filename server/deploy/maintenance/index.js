// Static 503 Worker used for maintenance mode. No bindings, no secrets.
export default {
  async fetch() {
    return new Response('{"error":"unavailable"}', {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "PA-Epoch-Ms": String(Date.now()),
        "Access-Control-Expose-Headers": "PA-Epoch-Ms",
        "Cache-Control": "no-store",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
        "Retry-After": "300",
      },
    });
  },
  // Keeps the cron triggers registered; does nothing.
  async scheduled() {},
};

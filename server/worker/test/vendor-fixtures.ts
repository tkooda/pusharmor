// Recorded vendor responses, one per row of the vendor-wrap result table (section 6).
// attempts = vendor sends for one recipient (retries and auth refresh included).
export interface VendorRow {
  name: string;
  vendor: "fcm" | "apns" | "wp" | "up";
  status: number;
  body?: string;
  headers?: Record<string, string>;
  result: string;
  attempts: number;
}

const fcmErr = (code: number, status: string, errorCode?: string) =>
  JSON.stringify({
    error: {
      code,
      message: "recorded",
      status,
      details: errorCode ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] : [],
    },
  });

export const VENDOR_ROWS: VendorRow[] = [
  { name: "fcm 200", vendor: "fcm", status: 200, body: '{"name":"projects/p/messages/1"}', result: "sent", attempts: 1 },
  { name: "fcm 404 UNREGISTERED", vendor: "fcm", status: 404, body: fcmErr(404, "NOT_FOUND", "UNREGISTERED"), result: "gone", attempts: 1 },
  { name: "fcm 400 INVALID_ARGUMENT", vendor: "fcm", status: 400, body: fcmErr(400, "INVALID_ARGUMENT", "INVALID_ARGUMENT"), result: "failed:fcm-400-INVALID_ARGUMENT", attempts: 1 },
  { name: "fcm 404 empty body", vendor: "fcm", status: 404, body: "", result: "failed:fcm-404", attempts: 1 },
  { name: "fcm 404 other reason", vendor: "fcm", status: 404, body: fcmErr(404, "NOT_FOUND"), result: "failed:fcm-404", attempts: 1 },
  { name: "fcm 403 SENDER_ID_MISMATCH", vendor: "fcm", status: 403, body: fcmErr(403, "PERMISSION_DENIED", "SENDER_ID_MISMATCH"), result: "failed:fcm-403-SENDER_ID_MISMATCH", attempts: 1 },
  { name: "fcm 403 PERMISSION_DENIED", vendor: "fcm", status: 403, body: fcmErr(403, "PERMISSION_DENIED"), result: "failed:fcm-403", attempts: 1 },
  { name: "fcm 401 then 401", vendor: "fcm", status: 401, body: fcmErr(401, "UNAUTHENTICATED", "THIRD_PARTY_AUTH_ERROR"), result: "failed:fcm-401-THIRD_PARTY_AUTH_ERROR", attempts: 2 },
  { name: "fcm 429 QUOTA_EXCEEDED Retry-After 60", vendor: "fcm", status: 429, headers: { "Retry-After": "60" }, body: fcmErr(429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED"), result: "failed:fcm-429-QUOTA_EXCEEDED", attempts: 1 },
  { name: "fcm 503 UNAVAILABLE", vendor: "fcm", status: 503, body: fcmErr(503, "UNAVAILABLE", "UNAVAILABLE"), result: "failed:fcm-503-UNAVAILABLE", attempts: 4 },
  { name: "fcm 500 INTERNAL", vendor: "fcm", status: 500, body: fcmErr(500, "INTERNAL", "INTERNAL"), result: "failed:fcm-500-INTERNAL", attempts: 4 },
  { name: "fcm 302", vendor: "fcm", status: 302, headers: { Location: "https://example.com/" }, result: "failed:fcm-3xx", attempts: 1 },
  { name: "apns 200", vendor: "apns", status: 200, result: "sent", attempts: 1 },
  { name: "apns 410 Unregistered", vendor: "apns", status: 410, body: '{"reason":"Unregistered","timestamp":1}', result: "gone", attempts: 1 },
  { name: "apns 410 ExpiredToken", vendor: "apns", status: 410, body: '{"reason":"ExpiredToken"}', result: "gone", attempts: 1 },
  { name: "apns 400 BadDeviceToken", vendor: "apns", status: 400, body: '{"reason":"BadDeviceToken"}', result: "failed:apns-400-BadDeviceToken", attempts: 1 },
  { name: "apns 400 DeviceTokenNotForTopic", vendor: "apns", status: 400, body: '{"reason":"DeviceTokenNotForTopic"}', result: "failed:apns-400-DeviceTokenNotForTopic", attempts: 1 },
  { name: "apns 400 BadTopic", vendor: "apns", status: 400, body: '{"reason":"BadTopic"}', result: "failed:apns-400-BadTopic", attempts: 1 },
  { name: "apns 404 BadPath", vendor: "apns", status: 404, body: '{"reason":"BadPath"}', result: "failed:apns-404-BadPath", attempts: 1 },
  { name: "apns 405 MethodNotAllowed", vendor: "apns", status: 405, body: '{"reason":"MethodNotAllowed"}', result: "failed:apns-405-MethodNotAllowed", attempts: 1 },
  { name: "apns 413 PayloadTooLarge", vendor: "apns", status: 413, body: '{"reason":"PayloadTooLarge"}', result: "failed:apns-413-PayloadTooLarge", attempts: 1 },
  { name: "apns 403 ExpiredProviderToken (fresh JWT: no remint)", vendor: "apns", status: 403, body: '{"reason":"ExpiredProviderToken"}', result: "failed:apns-403-ExpiredProviderToken", attempts: 1 },
  { name: "apns 403 InvalidProviderToken (fresh JWT: no remint)", vendor: "apns", status: 403, body: '{"reason":"InvalidProviderToken"}', result: "failed:apns-403-InvalidProviderToken", attempts: 1 },
  { name: "apns 429 TooManyRequests", vendor: "apns", status: 429, body: '{"reason":"TooManyRequests"}', result: "failed:apns-429-TooManyRequests", attempts: 4 },
  { name: "apns 429 TooManyProviderTokenUpdates", vendor: "apns", status: 429, body: '{"reason":"TooManyProviderTokenUpdates"}', result: "failed:apns-429-TooManyProviderTokenUpdates", attempts: 1 },
  { name: "apns 500 InternalServerError", vendor: "apns", status: 500, body: '{"reason":"InternalServerError"}', result: "failed:apns-500-InternalServerError", attempts: 4 },
  { name: "apns 503 ServiceUnavailable", vendor: "apns", status: 503, body: '{"reason":"ServiceUnavailable"}', result: "failed:apns-503-ServiceUnavailable", attempts: 4 },
  { name: "apns 301", vendor: "apns", status: 301, result: "failed:apns-3xx", attempts: 1 },
  { name: "wp 201", vendor: "wp", status: 201, result: "sent", attempts: 1 },
  { name: "wp 404", vendor: "wp", status: 404, result: "gone", attempts: 1 },
  { name: "wp 410", vendor: "wp", status: 410, body: '{"code":410,"errno":106}', result: "gone", attempts: 1 },
  { name: "wp 400", vendor: "wp", status: 400, result: "failed:wp-400", attempts: 1 },
  { name: "wp 413", vendor: "wp", status: 413, result: "failed:wp-413", attempts: 1 },
  { name: "wp 401 then 401", vendor: "wp", status: 401, result: "failed:wp-401", attempts: 2 },
  { name: "wp 403 then 403", vendor: "wp", status: 403, result: "failed:wp-403", attempts: 2 },
  { name: "wp 429", vendor: "wp", status: 429, result: "failed:wp-429", attempts: 4 },
  { name: "wp 500", vendor: "wp", status: 500, result: "failed:wp-500", attempts: 4 },
  { name: "wp 502", vendor: "wp", status: 502, result: "failed:wp-502", attempts: 4 },
  { name: "wp 503", vendor: "wp", status: 503, result: "failed:wp-503", attempts: 4 },
  { name: "wp 418 other 4xx", vendor: "wp", status: 418, result: "failed:wp-418", attempts: 1 },
  { name: "wp 307", vendor: "wp", status: 307, result: "failed:wp-3xx", attempts: 1 },
  { name: "up 201", vendor: "up", status: 201, result: "sent", attempts: 1 },
  { name: "up 404", vendor: "up", status: 404, result: "gone", attempts: 1 },
  { name: "up 410", vendor: "up", status: 410, result: "gone", attempts: 1 },
  { name: "up 413", vendor: "up", status: 413, result: "failed:up-413", attempts: 1 },
  { name: "up 503", vendor: "up", status: 503, result: "failed:up-503", attempts: 4 },
  { name: "up 302", vendor: "up", status: 302, result: "failed:up-3xx", attempts: 1 },
];

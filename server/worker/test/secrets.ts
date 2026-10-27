// Test-only secret values (never real secrets). HMAC secrets are b64url of 32 bytes.
// PA_ID_SECRET is the golden vector file's test id_secret.
export const TEST_SECRETS = {
  PA_ID_SECRET: "osEEqky1lYCunccbAIKM8-8MjkclYI6MwNlG8WtzstM",
  PA_CODE_SECRET: "Y29kZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDAwMDA",
  PA_CONFIRM_SECRET: "Y29uZmlybS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDA",
  PA_TOKEN_SECRET: "dG9rZW4tc2VjcmV0LWZvci10ZXN0cy1vbmx5LTAwMDA",
  CLOUDFLARE_TURNSTILE_SECRET: "test-turnstile-secret",
  AWS_SES_ACCESS_KEY_ID: "AKIDTESTONLY",
  AWS_SES_SECRET_ACCESS_KEY: "test-ses-secret-access-key",
  GOOGLE_FCM_SA_EMAIL: "sa@test-project.iam.gserviceaccount.com",
  GOOGLE_FCM_SA_KEY_ID: "test-fcm-kid",
  GOOGLE_FCM_SA_PRIVATE_KEY: "",
  APPLE_APNS_KEY_P8: "",
  WEBPUSH_VAPID_PRIVATE_KEY: "",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  APPLE_SIGNIN_KEY_ID: "TESTAPPLEKID",
  APPLE_SIGNIN_KEY_P8: "",
};

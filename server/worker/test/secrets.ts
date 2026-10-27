// Test-only secret values (never real secrets). HMAC secrets are b64url of 32 bytes.
// ID_SECRET is the golden vector file's test id_secret.
export const TEST_SECRETS = {
  ID_SECRET: "osEEqky1lYCunccbAIKM8-8MjkclYI6MwNlG8WtzstM",
  CODE_SECRET: "Y29kZS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDAwMDA",
  CONFIRM_SECRET: "Y29uZmlybS1zZWNyZXQtZm9yLXRlc3RzLW9ubHktMDA",
  TOKEN_SECRET: "dG9rZW4tc2VjcmV0LWZvci10ZXN0cy1vbmx5LTAwMDA",
  TURNSTILE_SECRET: "test-turnstile-secret",
  SES_ACCESS_KEY_ID: "AKIDTESTONLY",
  SES_SECRET_ACCESS_KEY: "test-ses-secret-access-key",
  FCM_SA_EMAIL: "sa@test-project.iam.gserviceaccount.com",
  FCM_SA_KEY_ID: "test-fcm-kid",
  FCM_SA_PRIVATE_KEY: "",
  APNS_KEY_P8: "",
  VAPID_PRIVATE_KEY: "",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  APPLE_SIGNIN_KEY_ID: "TESTAPPLEKID",
  APPLE_SIGNIN_KEY_P8: "",
};

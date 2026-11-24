// Worker bindings, vars and secrets (see wrangler.jsonc; secrets via "wrangler secret put").
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  RL_IP: RateLimit;
  RL_PEER: RateLimit;
  RL_MAIL_EMAIL: RateLimit;
  RL_MAIL_IP: RateLimit;
  RL_MAIL_GLOBAL: RateLimit;
  RL_CODE: RateLimit;
  RL_PAIR: RateLimit;
  RL_PROBE: RateLimit;
  RL_ACCT: RateLimit;
  RL_FILE: RateLimit;
  RL_DL_IP: RateLimit;
  RL_DL_KEY: RateLimit;
  FILE_QUOTA: DurableObjectNamespace<import("./file/quota").FileQuota>;

  PA_ALLOWED_PUSH_ENDPOINTS: string;
  PA_ALLOWED_UP_HOSTS: string;
  PA_PUSH_TTL_SECONDS: string;
  GOOGLE_FCM_PROJECT_ID: string;
  APPLE_APNS_TOPIC: string;
  APPLE_APNS_KEY_ID: string;
  APPLE_APNS_TEAM_ID: string;
  APPLE_SIGNIN_KEY_ID: string;
  WEBPUSH_VAPID_PUBLIC_KEY: string;
  WEBPUSH_VAPID_SUB: string;
  AWS_SES_REGION: string;
  AWS_SES_MAIL_FROM: string;
  AWS_SES_CONFIG_SET: string;
  CLOUDFLARE_TURNSTILE_HOSTNAME: string;
  CLOUDFLARE_TURNSTILE_ACTION: string;
  GOOGLE_AUD_WEB: string;
  GOOGLE_AUD_NATIVE: string;
  APPLE_SIGNIN_AUD_WEB: string;
  APPLE_SIGNIN_AUD_NATIVE: string;
  PA_OAUTH_REDIRECT_CHROME: string;
  PA_OAUTH_REDIRECT_FIREFOX: string;
  PA_OAUTH_REDIRECT_ANDROID: string;
  PA_OAUTH_REDIRECT_WEB: string;
  PA_OAUTH_REDIRECT_CLI: string;
  PA_WEB_ORIGINS: string;
  PA_LOG_SAMPLE: string;
  LOG_LEVEL?: string; // dashboard variable: error | warn | info (default) | debug
  PA_MIN_CLIENT?: string;
  PA_HEALTHCHECK_URL?: string; // secret; GET after each passing 15-minute self-check
  PA_TOTP_KEY_REVIEWER?: string; // secret; base32 TOTP key of the store review login (auth/totp.ts)
  PA_TOTP_KEY_RELEASE_TEST?: string; // secret; base32 TOTP key of the release-gate test login
  PA_FILE_DAY_LIMIT?: string; // dashboard variable: file uploads per account per UTC day; 0 = paused
  PA_FILE_MONTH_LIMIT?: string; // dashboard variable: file uploads per account per UTC month; 0 = paused
  // File storage: private bucket, S3 endpoint https://s3.<region>.backblazeb2.com, region.
  B2_BUCKET: string;
  B2_S3_ENDPOINT: string;
  B2_REGION: string;

  PA_ID_SECRET: string;
  PA_CODE_SECRET: string;
  PA_CONFIRM_SECRET: string;
  PA_TOKEN_SECRET: string;
  FILE_ACCT_SECRET: string; // acct-hash in file storage keys
  B2_KEY_ID?: string; // file storage application key id
  B2_APP_KEY?: string; // file storage application key
  CLOUDFLARE_TURNSTILE_SECRET: string;
  AWS_SES_ACCESS_KEY_ID: string;
  AWS_SES_SECRET_ACCESS_KEY: string;
  GOOGLE_FCM_SA_EMAIL: string;
  GOOGLE_FCM_SA_KEY_ID: string;
  GOOGLE_FCM_SA_PRIVATE_KEY: string;
  APPLE_APNS_KEY_P8: string;
  WEBPUSH_VAPID_PRIVATE_KEY: string;
  GOOGLE_CLIENT_SECRET: string;
  APPLE_SIGNIN_KEY_P8: string;
}

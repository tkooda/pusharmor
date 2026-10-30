// Worker bindings, vars and secrets (see wrangler.jsonc; secrets via "wrangler secret put").
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  RL_IP: RateLimit;
  RL_PEER: RateLimit;
  RL_MAIL: RateLimit;
  RL_MAIL_ALL: RateLimit;
  RL_CODE: RateLimit;
  RL_PAIR: RateLimit;
  RL_PROBE: RateLimit;
  RL_CODE_ALL: RateLimit;
  RL_ACCT: RateLimit;

  PA_ALLOWED_PUSH_ENDPOINT_PREFIXES: string;
  PA_ALLOWED_UP_HOSTS: string;
  PA_PUSH_TTL_SECONDS: string;
  PA_PUSH_PAIR_TTL_SECONDS: string;
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
  PA_WEB_ORIGINS: string;
  PA_LOG_SAMPLE: string;

  PA_ID_SECRET: string;
  PA_CODE_SECRET: string;
  PA_CONFIRM_SECRET: string;
  PA_TOKEN_SECRET: string;
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

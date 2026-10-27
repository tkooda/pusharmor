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

  ALLOWED_PUSH_ENDPOINT_PREFIXES: string;
  PUSH_TTL_SECONDS: string;
  PUSH_PAIR_TTL_SECONDS: string;
  FCM_PROJECT_ID: string;
  APNS_TOPIC: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUB: string;
  SES_REGION: string;
  MAIL_FROM: string;
  SES_CONFIG_SET: string;
  TURNSTILE_HOSTNAME: string;
  TURNSTILE_ACTION: string;
  GOOGLE_AUD_WEB: string;
  GOOGLE_AUD_NATIVE: string;
  APPLE_AUD_WEB: string;
  APPLE_AUD_NATIVE: string;
  OAUTH_REDIRECT_CHROME: string;
  OAUTH_REDIRECT_FIREFOX: string;
  OAUTH_REDIRECT_ANDROID: string;
  OAUTH_REDIRECT_WEB: string;
  WEB_ORIGINS: string;

  ID_SECRET: string;
  CODE_SECRET: string;
  CONFIRM_SECRET: string;
  TOKEN_SECRET: string;
  TURNSTILE_SECRET: string;
  SES_ACCESS_KEY_ID: string;
  SES_SECRET_ACCESS_KEY: string;
  FCM_SA_EMAIL: string;
  FCM_SA_KEY_ID: string;
  FCM_SA_PRIVATE_KEY: string;
  APNS_KEY_P8: string;
  VAPID_PRIVATE_KEY: string;
  GOOGLE_CLIENT_SECRET: string;
  APPLE_SIGNIN_KEY_ID: string;
  APPLE_SIGNIN_KEY_P8: string;
}

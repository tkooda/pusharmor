import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { TEST_SECRETS } from "./test/secrets.ts";


export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        main: "./src/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            ...TEST_SECRETS,
            TEST_MIGRATIONS: migrations,
            GOOGLE_FCM_PROJECT_ID: "test-project",
            APPLE_APNS_TOPIC: "com.example.pusharmor",
            APPLE_APNS_KEY_ID: "TESTAPNSKID",
            APPLE_APNS_TEAM_ID: "TESTTEAMID",
            WEBPUSH_VAPID_SUB: "mailto:ops@example.com",
            AWS_SES_REGION: "us-east-1",
            AWS_SES_MAIL_FROM: "codes@example.com",
            AWS_SES_CONFIG_SET: "test-config-set",
            GOOGLE_AUD_WEB: '["google-web-client"]',
            GOOGLE_AUD_NATIVE: '["google-web-client","google-ios-client"]',
            APPLE_SIGNIN_AUD_WEB: "com.example.pusharmor.web",
            APPLE_SIGNIN_AUD_NATIVE: "com.example.pusharmor",
            APPLE_SIGNIN_KEY_ID: "TESTAPPLEKID",
            PA_OAUTH_REDIRECT_CHROME: '["https://extid.chromiumapp.org/","https://betaid.chromiumapp.org/"]',
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: {
            // base64 of "test-webhook-secret-key"; must match TEST_WEBHOOK_KEY_B64 in api.test.ts
            RESEND_WEBHOOK_SECRET: "whsec_dGVzdC13ZWJob29rLXNlY3JldC1rZXk=",
          },
        },
      },
    },
  },
});

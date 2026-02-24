import { Env } from "./types";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Running scheduled maintenance: retention cleanup");

    try {
      // Delete emails past their expiration date
      const result = await env.DB.prepare(
        "DELETE FROM emails WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
      ).run();

      console.log(`Retention cleanup: deleted ${result.meta.changes} expired emails`);

      // Also clean up old webhook logs (keep 7 days)
      const webhookResult = await env.DB.prepare(
        "DELETE FROM webhook_log WHERE created_at < datetime('now', '-7 days')"
      ).run();

      if (webhookResult.meta.changes > 0) {
        console.log(`Cleaned up ${webhookResult.meta.changes} old webhook log entries`);
      }
    } catch (e) {
      console.error("Scheduled maintenance failed:", e);
    }
  }
};

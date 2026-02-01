import { Env } from "./types";

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log("Running scheduled maintenance: cleaning old emails");
    
    try {
      // Delete emails older than 30 days
      const result = await env.DB.prepare(
        "DELETE FROM emails WHERE received_at < datetime('now', '-30 days')"
      ).run();
      
      console.log(`Deleted ${result.meta.changes} old emails.`);
    } catch (e) {
      console.error("Failed to clean old emails:", e);
    }
  }
};

/**
 * ShellMail — Combined Worker
 * Handles both REST API (fetch) and inbound email (email)
 */

import { Env } from "./types";
import apiHandler from "./api";
import emailHandler from "./email";
import scheduledHandler from "./scheduled";

export default {
  fetch: apiHandler.fetch,
  email: emailHandler.email,
  scheduled: scheduledHandler.scheduled,
} satisfies ExportedHandler<Env>;

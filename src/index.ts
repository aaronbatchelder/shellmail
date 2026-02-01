/**
 * ClawMail — Combined Worker
 * Handles both REST API (fetch) and inbound email (email)
 */

import { Env } from "./types";
import apiHandler from "./api";
import emailHandler from "./email";

export default {
  fetch: apiHandler.fetch,
  email: emailHandler.email,
} satisfies ExportedHandler<Env>;

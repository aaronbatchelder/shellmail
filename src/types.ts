export interface Env {
  DB: D1Database;
  DOMAIN: string;
  ADMIN_SECRET?: string;
  RESEND_API_KEY?: string;
  ctx?: ExecutionContext;
}

export interface Address {
  id: string;
  local_part: string;
  domain: string;
  token_hash: string;
  recovery_hash: string;
  created_at: string;
  max_messages: number;
  status: "active" | "disabled";
  webhook_url: string | null;
  webhook_secret: string | null;
  plan: string;
  messages_received: number;
  messages_sent: number;
  last_activity_at: string | null;
  deleted_at: string | null;
  held_until: string | null;
}

export interface Email {
  id: string;
  address_id: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string;
  is_read: number;
  is_archived: number;
  otp_code: string | null;
  otp_link: string | null;
  otp_extracted: number;
  expires_at: string | null;
  direction: string;
  message_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references_header: string | null;
}

export interface CreateAddressRequest {
  local: string;
  recovery_email: string;
}

export interface RecoverRequest {
  address: string;
  recovery_email: string;
}

export interface WebhookConfig {
  url: string;
  secret?: string;
}

export interface SendEmailRequest {
  to: string;
  subject: string;
  body_text: string;
  body_html?: string;
  reply_to_id?: string;
}

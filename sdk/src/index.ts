/**
 * ShellMail SDK
 * TypeScript client for the ShellMail API
 * https://shellmail.ai
 */

// ── Types ────────────────────────────────────────────────

export interface ShellMailConfig {
  /** Your ShellMail API token (sm_...) */
  token: string;
  /** API base URL (default: https://shellmail.ai) */
  baseUrl?: string;
}

export interface EmailSummary {
  id: string;
  from_addr: string;
  from_name: string | null;
  subject: string;
  received_at: string;
  is_read: boolean;
  otp_code?: string | null;
  otp_link?: string | null;
  expires_at?: string | null;
}

export interface Email extends EmailSummary {
  body_text: string | null;
  body_html: string | null;
  is_archived: boolean;
}

export interface SentEmail {
  id: string;
  to_addr: string;
  subject: string;
  received_at: string;
  message_id: string;
}

export interface InboxResponse {
  address: string;
  unread_count: number;
  emails: EmailSummary[];
}

export interface SentResponse {
  address: string;
  sent_count: number;
  emails: SentEmail[];
}

export interface OtpResponse {
  found: boolean;
  email_id?: string;
  from?: string;
  subject?: string;
  code?: string | null;
  link?: string | null;
  received_at?: string;
  message?: string;
}

export interface SearchResponse {
  count: number;
  emails: EmailSummary[];
}

export interface SendOptions {
  /** Recipient email address */
  to: string;
  /** Email subject */
  subject: string;
  /** Plain text body */
  bodyText: string;
  /** HTML body (optional) */
  bodyHtml?: string;
  /** ID of email to reply to (for threading) */
  replyToId?: string;
}

export interface SendResponse {
  ok: boolean;
  id: string;
  message_id: string;
}

export interface WebhookConfig {
  configured: boolean;
  url: string | null;
  has_secret: boolean;
}

export interface WebhookSetResponse {
  ok: boolean;
  url: string;
  secret: string;
  note: string;
}

export interface CreateAddressResponse {
  address: string;
  token: string;
  note: string;
  /** True if a previously-deleted address was reclaimed */
  reclaimed?: boolean;
}

export interface HealthResponse {
  service: string;
  status: string;
  domain: string;
}

export interface ThreadSummary {
  thread_id: string;
  subject: string;
  last_message: {
    id: string;
    from_addr: string;
    from_name: string | null;
    to_addr: string | null;
    direction: string;
    received_at: string;
  };
  message_count: number;
  unread_count: number;
  last_message_at: string;
}

export interface ThreadsResponse {
  threads: ThreadSummary[];
  count: number;
}

export interface ThreadMessage {
  id: string;
  from_addr: string;
  from_name: string | null;
  to_addr: string | null;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  direction: string;
  received_at: string;
  is_read: boolean;
  message_id: string | null;
}

export interface ThreadResponse {
  thread_id: string;
  subject: string;
  messages: ThreadMessage[];
  message_count: number;
}

// ── Errors ───────────────────────────────────────────────

export class ShellMailError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string
  ) {
    super(message);
    this.name = "ShellMailError";
  }
}

// ── Client ───────────────────────────────────────────────

export class ShellMail {
  private token: string;
  private baseUrl: string;

  constructor(config: ShellMailConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl || "https://shellmail.ai";
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    requireAuth = true
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (requireAuth) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = (await response.json()) as T & { error?: string };

    if (!response.ok) {
      throw new ShellMailError(
        data.error || `Request failed: ${response.status}`,
        response.status
      );
    }

    return data;
  }

  // ── Inbox ────────────────────────────────────────────

  /**
   * List emails in your inbox
   * @param options.unreadOnly - Only return unread emails
   * @param options.limit - Max emails to return (default: 50, max: 100)
   * @param options.offset - Pagination offset
   */
  async inbox(options?: {
    unreadOnly?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<InboxResponse> {
    const params = new URLSearchParams();
    if (options?.unreadOnly) params.set("unread", "true");
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    return this.request<InboxResponse>("GET", `/api/mail?${params}`);
  }

  /**
   * Get a specific email by ID
   */
  async getEmail(emailId: string): Promise<Email> {
    return this.request<Email>("GET", `/api/mail/${emailId}`);
  }

  /**
   * Mark an email as read
   */
  async markRead(emailId: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/mail/${emailId}`, { is_read: true });
  }

  /**
   * Mark an email as unread
   */
  async markUnread(emailId: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/mail/${emailId}`, { is_read: false });
  }

  /**
   * Archive an email
   */
  async archive(emailId: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/mail/${emailId}`, { is_archived: true });
  }

  /**
   * Delete an email
   */
  async deleteEmail(emailId: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/mail/${emailId}`);
  }

  // ── Threads ──────────────────────────────────────────

  /**
   * List email threads (conversations)
   * @param options.limit - Max threads to return (default: 20, max: 100)
   * @param options.offset - Pagination offset
   */
  async threads(options?: {
    limit?: number;
    offset?: number;
  }): Promise<ThreadsResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    return this.request<ThreadsResponse>("GET", `/api/mail/threads?${params}`);
  }

  /**
   * Get all messages in a thread
   * @param threadId - The thread ID
   */
  async getThread(threadId: string): Promise<ThreadResponse> {
    return this.request<ThreadResponse>("GET", `/api/mail/threads/${threadId}`);
  }

  // ── OTP ──────────────────────────────────────────────

  /**
   * Get the latest OTP/verification code
   * @param options.timeout - Wait up to this many seconds for an OTP (max: 30)
   * @param options.from - Filter by sender address/domain
   * @param options.since - Only return OTPs received after this ISO timestamp
   */
  async getOtp(options?: {
    timeout?: number;
    from?: string;
    since?: string;
  }): Promise<OtpResponse> {
    const params = new URLSearchParams();
    if (options?.timeout) {
      // Convert seconds to milliseconds
      params.set("timeout", String(Math.min(options.timeout * 1000, 30000)));
    }
    if (options?.from) params.set("from", options.from);
    if (options?.since) params.set("since", options.since);
    return this.request<OtpResponse>("GET", `/api/mail/otp?${params}`);
  }

  /**
   * Wait for an OTP to arrive (convenience method)
   * @param timeoutSeconds - Max seconds to wait (default: 30)
   * @param from - Filter by sender
   */
  async waitForOtp(
    timeoutSeconds = 30,
    from?: string
  ): Promise<string | null> {
    const result = await this.getOtp({ timeout: timeoutSeconds, from });
    return result.found ? (result.code || result.link || null) : null;
  }

  // ── Search ───────────────────────────────────────────

  /**
   * Search emails
   * @param options.q - Search query (matches subject, body, sender)
   * @param options.from - Filter by sender
   * @param options.hasOtp - Only return emails with OTP codes
   * @param options.limit - Max results (default: 20)
   */
  async search(options: {
    q?: string;
    from?: string;
    hasOtp?: boolean;
    limit?: number;
  }): Promise<SearchResponse> {
    const params = new URLSearchParams();
    if (options.q) params.set("q", options.q);
    if (options.from) params.set("from", options.from);
    if (options.hasOtp) params.set("has_otp", "true");
    if (options.limit) params.set("limit", String(options.limit));
    return this.request<SearchResponse>("GET", `/api/mail/search?${params}`);
  }

  // ── Send ─────────────────────────────────────────────

  /**
   * Send an email
   * Rate limited by plan (Free: 10/day, Shell: 50/day, Reef: 100/day)
   */
  async send(options: SendOptions): Promise<SendResponse> {
    return this.request<SendResponse>("POST", "/api/mail/send", {
      to: options.to,
      subject: options.subject,
      body_text: options.bodyText,
      body_html: options.bodyHtml,
      reply_to_id: options.replyToId,
    });
  }

  /**
   * Reply to an email
   */
  async reply(
    emailId: string,
    body: string,
    options?: { html?: string }
  ): Promise<SendResponse> {
    // Get original email to get recipient
    const original = await this.getEmail(emailId);
    const subject = original.subject.startsWith("Re:")
      ? original.subject
      : `Re: ${original.subject}`;

    return this.send({
      to: original.from_addr,
      subject,
      bodyText: body,
      bodyHtml: options?.html,
      replyToId: emailId,
    });
  }

  /**
   * List sent emails
   */
  async sent(options?: {
    limit?: number;
    offset?: number;
  }): Promise<SentResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    return this.request<SentResponse>("GET", `/api/mail/sent?${params}`);
  }

  // ── Webhook ──────────────────────────────────────────

  /**
   * Get webhook configuration
   */
  async getWebhook(): Promise<WebhookConfig> {
    return this.request<WebhookConfig>("GET", "/api/webhook");
  }

  /**
   * Configure webhook URL
   * @param url - Webhook URL to receive email notifications
   * @param secret - Optional custom secret for HMAC signature
   */
  async setWebhook(url: string, secret?: string): Promise<WebhookSetResponse> {
    return this.request<WebhookSetResponse>("PUT", "/api/webhook", {
      url,
      secret,
    });
  }

  /**
   * Remove webhook configuration
   */
  async deleteWebhook(): Promise<{ ok: boolean }> {
    return this.request("DELETE", "/api/webhook");
  }

  // ── Account ──────────────────────────────────────────

  /**
   * Delete your address and all emails.
   * The address is held for 14 days — reclaim it by calling
   * ShellMail.createAddress() with the same local part and recovery email.
   */
  async deleteAccount(): Promise<{ ok: boolean; deleted: string; held_until: string }> {
    return this.request("DELETE", "/api/addresses/me");
  }

  // ── Static Methods ───────────────────────────────────

  /**
   * Create a new ShellMail address (no auth required)
   * @param local - Local part of email (before @)
   * @param recoveryEmail - Email for token recovery
   * @param baseUrl - API base URL (default: https://shellmail.ai)
   */
  static async createAddress(
    local: string,
    recoveryEmail: string,
    baseUrl = "https://shellmail.ai"
  ): Promise<CreateAddressResponse> {
    const response = await fetch(`${baseUrl}/api/addresses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ local, recovery_email: recoveryEmail }),
    });

    const data = (await response.json()) as CreateAddressResponse & {
      error?: string;
    };

    if (!response.ok) {
      throw new ShellMailError(
        data.error || `Request failed: ${response.status}`,
        response.status
      );
    }

    return data;
  }

  /**
   * Request token recovery (sends new token to recovery email)
   */
  static async recoverToken(
    address: string,
    recoveryEmail: string,
    baseUrl = "https://shellmail.ai"
  ): Promise<{ message: string }> {
    const response = await fetch(`${baseUrl}/api/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, recovery_email: recoveryEmail }),
    });

    const data = (await response.json()) as { message: string; error?: string };

    if (!response.ok) {
      throw new ShellMailError(
        data.error || `Request failed: ${response.status}`,
        response.status
      );
    }

    return data;
  }

  /**
   * Check API health
   */
  static async health(baseUrl = "https://shellmail.ai"): Promise<HealthResponse> {
    const response = await fetch(`${baseUrl}/health`);
    return response.json() as Promise<HealthResponse>;
  }
}

// Default export
export default ShellMail;

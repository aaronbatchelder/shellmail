/**
 * ShellMail API Client
 */

const API_BASE = process.env.SHELLMAIL_API_URL || "https://shellmail.ai";

export interface CreateAddressResponse {
  address: string;
  token: string;
  note: string;
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
}

export interface EmailDetail extends EmailSummary {
  body_text: string | null;
  body_html: string | null;
  is_archived: boolean;
}

export interface InboxResponse {
  address: string;
  unread_count: number;
  emails: EmailSummary[];
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

export interface WebhookResponse {
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

export class ShellMailAPI {
  private token: string | null;

  constructor(token?: string) {
    this.token = token || process.env.SHELLMAIL_TOKEN || null;
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
      if (!this.token) {
        throw new Error("No token configured. Run 'shellmail setup' first.");
      }
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json() as T & { error?: string };

    if (!response.ok) {
      throw new Error(data.error || `Request failed: ${response.status}`);
    }

    return data;
  }

  async createAddress(
    local: string,
    recoveryEmail: string
  ): Promise<CreateAddressResponse> {
    return this.request<CreateAddressResponse>(
      "POST",
      "/api/addresses",
      { local, recovery_email: recoveryEmail },
      false
    );
  }

  async inbox(unreadOnly = false, limit = 20): Promise<InboxResponse> {
    const params = new URLSearchParams();
    if (unreadOnly) params.set("unread", "true");
    params.set("limit", limit.toString());
    return this.request<InboxResponse>("GET", `/api/mail?${params}`);
  }

  async read(emailId: string): Promise<EmailDetail> {
    return this.request<EmailDetail>("GET", `/api/mail/${emailId}`);
  }

  async markRead(emailId: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/mail/${emailId}`, { is_read: true });
  }

  async archive(emailId: string): Promise<{ ok: boolean }> {
    return this.request("PATCH", `/api/mail/${emailId}`, { is_archived: true });
  }

  async delete(emailId: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/api/mail/${emailId}`);
  }

  async otp(options?: {
    timeout?: number;
    from?: string;
    since?: string;
  }): Promise<OtpResponse> {
    const params = new URLSearchParams();
    if (options?.timeout) params.set("timeout", options.timeout.toString());
    if (options?.from) params.set("from", options.from);
    if (options?.since) params.set("since", options.since);
    return this.request<OtpResponse>("GET", `/api/mail/otp?${params}`);
  }

  async search(options: {
    q?: string;
    from?: string;
    hasOtp?: boolean;
    limit?: number;
  }): Promise<{ count: number; emails: EmailSummary[] }> {
    const params = new URLSearchParams();
    if (options.q) params.set("q", options.q);
    if (options.from) params.set("from", options.from);
    if (options.hasOtp) params.set("has_otp", "true");
    if (options.limit) params.set("limit", options.limit.toString());
    return this.request("GET", `/api/mail/search?${params}`);
  }

  async getWebhook(): Promise<WebhookResponse> {
    return this.request<WebhookResponse>("GET", "/api/webhook");
  }

  async setWebhook(url: string, secret?: string): Promise<WebhookSetResponse> {
    return this.request<WebhookSetResponse>("PUT", "/api/webhook", {
      url,
      secret,
    });
  }

  async deleteWebhook(): Promise<{ ok: boolean }> {
    return this.request("DELETE", "/api/webhook");
  }

  async health(): Promise<{ service: string; status: string; domain: string }> {
    return this.request("GET", "/health", undefined, false);
  }
}

#!/usr/bin/env node
/**
 * ShellMail MCP Server
 * Provides email capabilities for AI agents via Model Context Protocol
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = process.env.SHELLMAIL_API_URL || "https://shellmail.ai";
const TOKEN = process.env.SHELLMAIL_TOKEN;

// API helper
async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  requireAuth = true
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (requireAuth) {
    if (!TOKEN) {
      throw new Error(
        "SHELLMAIL_TOKEN environment variable not set. Get your token at https://shellmail.ai"
      );
    }
    headers["Authorization"] = `Bearer ${TOKEN}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "shellmail_inbox",
    description:
      "List emails in your ShellMail inbox. Returns email summaries with sender, subject, date, and OTP codes if present.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unread_only: {
          type: "boolean",
          description: "Only return unread emails",
          default: false,
        },
        limit: {
          type: "number",
          description: "Maximum number of emails to return (default: 20, max: 100)",
          default: 20,
        },
      },
    },
  },
  {
    name: "shellmail_read",
    description:
      "Read the full content of a specific email by ID. Returns the complete email with body text and HTML.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to read",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "shellmail_otp",
    description:
      "Get the latest OTP/verification code from your inbox. Supports long-polling to wait for an OTP to arrive. Automatically extracts codes from verification emails.",
    inputSchema: {
      type: "object" as const,
      properties: {
        timeout: {
          type: "number",
          description:
            "Wait up to this many seconds for an OTP to arrive (max: 30). Use this when expecting an OTP soon.",
          default: 0,
        },
        from: {
          type: "string",
          description:
            "Filter by sender address or domain (e.g., 'github.com', 'noreply@stripe.com')",
        },
        since: {
          type: "string",
          description: "Only return OTPs received after this ISO timestamp",
        },
      },
    },
  },
  {
    name: "shellmail_send",
    description:
      "Send an email from your ShellMail address. Rate limited by plan (Free: 10/day, Shell: 50/day, Reef: 100/day).",
    inputSchema: {
      type: "object" as const,
      properties: {
        to: {
          type: "string",
          description: "Recipient email address",
        },
        subject: {
          type: "string",
          description: "Email subject line",
        },
        body_text: {
          type: "string",
          description: "Plain text body of the email",
        },
        body_html: {
          type: "string",
          description: "HTML body (optional, for rich formatting)",
        },
        reply_to_id: {
          type: "string",
          description: "ID of email to reply to (for threading)",
        },
      },
      required: ["to", "subject", "body_text"],
    },
  },
  {
    name: "shellmail_search",
    description:
      "Search emails by query, sender, or OTP presence. Useful for finding specific emails.",
    inputSchema: {
      type: "object" as const,
      properties: {
        q: {
          type: "string",
          description: "Search query (matches subject, body, sender)",
        },
        from: {
          type: "string",
          description: "Filter by sender address or domain",
        },
        has_otp: {
          type: "boolean",
          description: "Only return emails that contain OTP codes",
        },
        limit: {
          type: "number",
          description: "Maximum results (default: 20)",
          default: 20,
        },
      },
    },
  },
  {
    name: "shellmail_sent",
    description: "List emails you have sent from your ShellMail address.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of emails to return (default: 20)",
          default: 20,
        },
      },
    },
  },
  {
    name: "shellmail_delete",
    description: "Delete an email by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to delete",
        },
      },
      required: ["email_id"],
    },
  },
  {
    name: "shellmail_mark_read",
    description: "Mark an email as read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        email_id: {
          type: "string",
          description: "The ID of the email to mark as read",
        },
      },
      required: ["email_id"],
    },
  },
];

// Tool handlers
async function handleTool(
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "shellmail_inbox": {
      const params = new URLSearchParams();
      if (args.unread_only) params.set("unread", "true");
      if (args.limit) params.set("limit", String(args.limit));
      return apiRequest("GET", `/api/mail?${params}`);
    }

    case "shellmail_read": {
      if (!args.email_id) throw new Error("email_id is required");
      return apiRequest("GET", `/api/mail/${args.email_id}`);
    }

    case "shellmail_otp": {
      const params = new URLSearchParams();
      if (args.timeout) {
        // Convert seconds to milliseconds, cap at 30s
        const ms = Math.min(Number(args.timeout) * 1000, 30000);
        params.set("timeout", String(ms));
      }
      if (args.from) params.set("from", String(args.from));
      if (args.since) params.set("since", String(args.since));
      return apiRequest("GET", `/api/mail/otp?${params}`);
    }

    case "shellmail_send": {
      if (!args.to || !args.subject || !args.body_text) {
        throw new Error("to, subject, and body_text are required");
      }
      return apiRequest("POST", "/api/mail/send", {
        to: args.to,
        subject: args.subject,
        body_text: args.body_text,
        body_html: args.body_html,
        reply_to_id: args.reply_to_id,
      });
    }

    case "shellmail_search": {
      const params = new URLSearchParams();
      if (args.q) params.set("q", String(args.q));
      if (args.from) params.set("from", String(args.from));
      if (args.has_otp) params.set("has_otp", "true");
      if (args.limit) params.set("limit", String(args.limit));
      return apiRequest("GET", `/api/mail/search?${params}`);
    }

    case "shellmail_sent": {
      const limit = args.limit || 20;
      return apiRequest("GET", `/api/mail/sent?limit=${limit}`);
    }

    case "shellmail_delete": {
      if (!args.email_id) throw new Error("email_id is required");
      return apiRequest("DELETE", `/api/mail/${args.email_id}`);
    }

    case "shellmail_mark_read": {
      if (!args.email_id) throw new Error("email_id is required");
      return apiRequest("PATCH", `/api/mail/${args.email_id}`, { is_read: true });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Create and run server
async function main() {
  const server = new Server(
    {
      name: "shellmail",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleTool(name, (args as Record<string, unknown>) || {});
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ShellMail MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

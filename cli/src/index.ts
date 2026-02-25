#!/usr/bin/env node
/**
 * ShellMail CLI
 * Email for AI agents — in 30 seconds
 */

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
import { ShellMailAPI } from "./api.js";
import { loadConfig, saveConfig, clearConfig, getToken } from "./config.js";

const program = new Command();

program
  .name("shellmail")
  .description("Email for AI agents — create addresses, check mail, extract OTPs")
  .version("1.0.0");

// ── Setup Command ────────────────────────────────────────

program
  .command("setup")
  .description("Create a new ShellMail address interactively")
  .option("-l, --local <name>", "Local part of email address")
  .option("-r, --recovery <email>", "Recovery email address")
  .option("-a, --auto", "Auto-generate a random address")
  .action(async (options) => {
    console.log(chalk.bold("\n📧 ShellMail Setup\n"));

    let local = options.local;
    let recoveryEmail = options.recovery;

    // Get recovery email first (won't change between retries)
    if (!recoveryEmail) {
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "recovery",
          message: "Recovery email (for token recovery):",
          validate: (input: string) => {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) {
              return "Enter a valid email address";
            }
            return true;
          },
        },
      ]);
      recoveryEmail = answers.recovery;
    }

    // Loop until we get a valid address
    const api = new ShellMailAPI();
    let result: { address: string; token: string } | null = null;

    // If --auto flag, skip the name prompt
    if (options.auto) {
      local = "auto";
    }

    while (!result) {
      if (!local) {
        const answers = await inquirer.prompt([
          {
            type: "input",
            name: "local",
            message: `Choose your address (or type "auto" for random):\n  ${chalk.gray("_")}${chalk.cyan("@shellmail.ai")}\n `,
            validate: (input: string) => {
              if (input === "auto") return true;
              if (!input || input.length < 2) return "Must be at least 2 characters";
              if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i.test(input) && input.length > 2) {
                return "Only letters, numbers, dots, hyphens, underscores allowed";
              }
              return true;
            },
          },
        ]);
        local = answers.local;
      }

      const spinner = ora(`Creating ${local}@shellmail.ai...`).start();

      try {
        result = await api.createAddress(local, recoveryEmail);
        spinner.succeed(chalk.green("Address created!"));
      } catch (err) {
        const message = (err as Error).message;
        if (message.toLowerCase().includes("taken") || message.toLowerCase().includes("exists") || message.includes("409")) {
          spinner.fail(chalk.yellow(`${local}@shellmail.ai is already taken`));
          console.log(chalk.gray("  Try a different name\n"));
          local = null; // Reset to prompt again
        } else {
          spinner.fail(chalk.red("Failed to create address"));
          console.error(chalk.red(`  ${message}\n`));
          process.exit(1);
        }
      }
    }

    console.log("\n" + chalk.bold("Your ShellMail address:"));
    console.log(chalk.cyan(`  ${result.address}\n`));

    console.log(chalk.bold("Your API token:"));
    console.log(chalk.yellow(`  ${result.token}\n`));

    // Always save to config
    saveConfig({
      token: result.token,
      address: result.address,
    });
    console.log(chalk.green("✓ Token saved to ~/.shellmail/config.json\n"));

    console.log(chalk.gray("⚠️  Save this token somewhere safe! It won't be shown again.\n"));

    // Show next steps
    console.log(chalk.bold("─".repeat(50)));
    console.log(chalk.bold("\nNext Steps\n"));
    console.log(`  1. Send a test email to ${chalk.cyan(result.address)}`);
    console.log(`  2. Run ${chalk.cyan("shellmail inbox")} to see it arrive\n`);

    console.log(chalk.bold("Commands\n"));
    console.log(`  ${chalk.cyan("shellmail inbox")}      Check your inbox`);
    console.log(`  ${chalk.cyan("shellmail otp -w 30")}  Wait for an OTP code`);
    console.log(`  ${chalk.cyan("shellmail read <id>")} Read an email`);
    console.log(`  ${chalk.cyan("shellmail status")}     Verify setup\n`);
  });

// ── Inbox Command ────────────────────────────────────────

program
  .command("inbox")
  .description("List emails in your inbox")
  .option("-u, --unread", "Show only unread emails")
  .option("-n, --limit <number>", "Number of emails to show", "10")
  .action(async (options) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const spinner = ora("Fetching inbox...").start();

    try {
      const api = new ShellMailAPI(token);
      const result = await api.inbox(options.unread, parseInt(options.limit));

      spinner.stop();

      console.log(chalk.bold(`\n📬 ${result.address}`));
      console.log(chalk.gray(`   ${result.unread_count} unread\n`));

      if (result.emails.length === 0) {
        console.log(chalk.gray("   No emails.\n"));
        return;
      }

      for (const email of result.emails) {
        const unread = !email.is_read ? chalk.blue("●") : " ";
        const from = email.from_name || email.from_addr.split("@")[0];
        const date = new Date(email.received_at).toLocaleString();
        const otp = email.otp_code ? chalk.yellow(` [OTP: ${email.otp_code}]`) : "";

        console.log(`${unread} ${chalk.bold(from.slice(0, 20).padEnd(20))} ${email.subject?.slice(0, 40) || "(no subject)"}${otp}`);
        console.log(chalk.gray(`  ${email.id}  ${date}\n`));
      }
    } catch (err) {
      spinner.fail(chalk.red("Failed to fetch inbox"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Read Command ─────────────────────────────────────────

program
  .command("read <id>")
  .description("Read a specific email")
  .option("-m, --mark-read", "Mark as read after viewing", true)
  .action(async (id, options) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const spinner = ora("Fetching email...").start();

    try {
      const api = new ShellMailAPI(token);
      const email = await api.read(id);

      if (options.markRead && !email.is_read) {
        await api.markRead(id);
      }

      spinner.stop();

      console.log("\n" + chalk.bold("From: ") + (email.from_name ? `${email.from_name} <${email.from_addr}>` : email.from_addr));
      console.log(chalk.bold("Subject: ") + (email.subject || "(no subject)"));
      console.log(chalk.bold("Date: ") + new Date(email.received_at).toLocaleString());
      console.log(chalk.gray("─".repeat(60)) + "\n");

      if (email.body_text) {
        // Clean up quoted-printable encoding
        const body = email.body_text
          .replace(/=\r?\n/g, "")
          .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
        console.log(body);
      } else if (email.body_html) {
        // Strip HTML tags for terminal display
        const text = email.body_html
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        console.log(text);
      } else {
        console.log(chalk.gray("(no content)"));
      }

      console.log("\n");
    } catch (err) {
      spinner.fail(chalk.red("Failed to read email"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── OTP Command ──────────────────────────────────────────

program
  .command("otp")
  .description("Get the latest OTP/verification code")
  .option("-w, --wait <seconds>", "Wait for OTP to arrive (max 30s)")
  .option("-f, --from <domain>", "Filter by sender domain")
  .action(async (options) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const timeout = options.wait ? Math.min(parseInt(options.wait) * 1000, 30000) : 0;
    const spinner = timeout
      ? ora(`Waiting for OTP (${options.wait}s timeout)...`).start()
      : ora("Checking for OTP...").start();

    try {
      const api = new ShellMailAPI(token);
      const result = await api.otp({
        timeout,
        from: options.from,
      });

      if (result.found) {
        spinner.succeed(chalk.green("OTP found!"));
        console.log("\n" + chalk.bold.yellow(`  ${result.code || result.link}\n`));
        console.log(chalk.gray(`  From: ${result.from}`));
        console.log(chalk.gray(`  Subject: ${result.subject}`));
        console.log(chalk.gray(`  Received: ${new Date(result.received_at!).toLocaleString()}\n`));

        // Output just the code for piping
        if (process.stdout.isTTY === false) {
          process.stdout.write(result.code || result.link || "");
        }
      } else {
        spinner.warn(chalk.yellow(result.message || "No OTP found"));
        console.log(chalk.gray("\n  Tip: Send a verification email to your address, then try again.\n"));
        process.exit(1);
      }
    } catch (err) {
      spinner.fail(chalk.red("Failed to check OTP"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Search Command ───────────────────────────────────────

program
  .command("search")
  .description("Search emails")
  .option("-q, --query <text>", "Search text in subject/body/sender")
  .option("-f, --from <domain>", "Filter by sender")
  .option("--otp", "Only show emails with OTP codes")
  .option("-n, --limit <number>", "Number of results", "10")
  .action(async (options) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    if (!options.query && !options.from && !options.otp) {
      console.error(chalk.red("Provide at least one search option: --query, --from, or --otp"));
      process.exit(1);
    }

    const spinner = ora("Searching...").start();

    try {
      const api = new ShellMailAPI(token);
      const result = await api.search({
        q: options.query,
        from: options.from,
        hasOtp: options.otp,
        limit: parseInt(options.limit),
      });

      spinner.stop();

      console.log(chalk.bold(`\n🔍 ${result.count} result(s)\n`));

      for (const email of result.emails) {
        const from = email.from_name || email.from_addr.split("@")[0];
        const otp = email.otp_code ? chalk.yellow(` [OTP: ${email.otp_code}]`) : "";

        console.log(`${chalk.bold(from.slice(0, 20).padEnd(20))} ${email.subject?.slice(0, 40) || "(no subject)"}${otp}`);
        console.log(chalk.gray(`  ${email.id}\n`));
      }
    } catch (err) {
      spinner.fail(chalk.red("Search failed"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Webhook Command ──────────────────────────────────────

program
  .command("webhook")
  .description("Configure webhook notifications")
  .option("-s, --set <url>", "Set webhook URL")
  .option("-d, --delete", "Remove webhook configuration")
  .action(async (options) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const api = new ShellMailAPI(token);

    if (options.delete) {
      const spinner = ora("Removing webhook...").start();
      try {
        await api.deleteWebhook();
        spinner.succeed(chalk.green("Webhook removed"));
      } catch (err) {
        spinner.fail(chalk.red("Failed to remove webhook"));
        console.error(chalk.red(`  ${(err as Error).message}\n`));
        process.exit(1);
      }
      return;
    }

    if (options.set) {
      const spinner = ora("Configuring webhook...").start();
      try {
        const result = await api.setWebhook(options.set);
        spinner.succeed(chalk.green("Webhook configured!"));
        console.log("\n" + chalk.bold("URL: ") + result.url);
        console.log(chalk.bold("Secret: ") + chalk.yellow(result.secret));
        console.log(chalk.gray("\n⚠️  Save the secret! Use it to verify webhook signatures.\n"));
      } catch (err) {
        spinner.fail(chalk.red("Failed to configure webhook"));
        console.error(chalk.red(`  ${(err as Error).message}\n`));
        process.exit(1);
      }
      return;
    }

    // Show current config
    const spinner = ora("Fetching webhook config...").start();
    try {
      const result = await api.getWebhook();
      spinner.stop();

      if (result.configured) {
        console.log(chalk.bold("\n🔔 Webhook configured"));
        console.log(chalk.bold("URL: ") + result.url);
        console.log(chalk.bold("Secret: ") + (result.has_secret ? chalk.green("configured") : chalk.yellow("not set")));
      } else {
        console.log(chalk.gray("\nNo webhook configured."));
        console.log(chalk.gray("Use 'shellmail webhook --set <url>' to configure.\n"));
      }
    } catch (err) {
      spinner.fail(chalk.red("Failed to fetch webhook config"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Delete Command ───────────────────────────────────────

program
  .command("delete <id>")
  .description("Delete an email")
  .action(async (id) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const spinner = ora("Deleting email...").start();

    try {
      const api = new ShellMailAPI(token);
      await api.delete(id);
      spinner.succeed(chalk.green("Email deleted"));
    } catch (err) {
      spinner.fail(chalk.red("Failed to delete email"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Archive Command ──────────────────────────────────────

program
  .command("archive <id>")
  .description("Archive an email")
  .action(async (id) => {
    const token = getToken();
    if (!token) {
      console.error(chalk.red("No token configured. Run 'shellmail setup' first."));
      process.exit(1);
    }

    const spinner = ora("Archiving email...").start();

    try {
      const api = new ShellMailAPI(token);
      await api.archive(id);
      spinner.succeed(chalk.green("Email archived"));
    } catch (err) {
      spinner.fail(chalk.red("Failed to archive email"));
      console.error(chalk.red(`  ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// ── Logout Command ───────────────────────────────────────

program
  .command("logout")
  .description("Clear saved configuration")
  .action(async () => {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "This will remove your saved token. Continue?",
        default: false,
      },
    ]);

    if (confirm) {
      clearConfig();
      console.log(chalk.green("\n✓ Configuration cleared.\n"));
    }
  });

// ── Status Command ───────────────────────────────────────

program
  .command("status")
  .description("Check ShellMail service status and current config")
  .action(async () => {
    const config = loadConfig();
    const api = new ShellMailAPI();

    console.log(chalk.bold("\n📧 ShellMail Status\n"));

    // Check service health
    const spinner = ora("Checking service...").start();
    try {
      const health = await api.health();
      spinner.succeed(chalk.green(`Service: ${health.status}`));
    } catch {
      spinner.fail(chalk.red("Service: unreachable"));
    }

    // Show config
    if (config.token) {
      console.log(chalk.green("✓ Token: configured"));
      if (config.address) {
        console.log(chalk.green(`✓ Address: ${config.address}`));
      }
    } else if (process.env.SHELLMAIL_TOKEN) {
      console.log(chalk.green("✓ Token: set via SHELLMAIL_TOKEN"));
    } else {
      console.log(chalk.yellow("✗ Token: not configured"));
      console.log(chalk.gray("  Run 'shellmail setup' to create an address"));
    }

    console.log("");
  });

program.parse();

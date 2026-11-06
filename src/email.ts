/**
 * Email accounts: read over IMAP (read-only), send over SMTP.
 *
 * Account labels and hosts live in $RELAY_DIR/mail.json. Each password is
 * stored in the macOS login Keychain as "mail-<slug>", never in a file.
 *
 * Reading opens the inbox read-only (EXAMINE), so nothing is marked read,
 * moved, or deleted. Sending is only called from the Approve button handler
 * in relay.ts, with the exact text the owner approved. Claude never calls it.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { userInfo } from "os";

export interface MailAccount {
  label: string;
  slug: string;
  address: string;
  imapHost: string;
  smtpHost: string;
}

export interface MailItem {
  account: string;
  from: string;
  subject: string;
  date: Date;
  snippet: string;
}

const CACHE_MS = 2 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mail";
}

function keychainUser(): string {
  return process.env.USER || userInfo().username;
}

export function isEmailAddress(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

export class Mail {
  private file: string;
  private cache = new Map<string, { at: number; items: MailItem[] }>();

  constructor(relayDir: string, private timezone: string) {
    this.file = join(relayDir, "mail.json");
  }

  list(): MailAccount[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf-8"));
    } catch {
      return [];
    }
  }

  private save(list: MailAccount[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  /** Find an account by label, slug, or address. */
  find(name: string | null | undefined): MailAccount | null {
    const list = this.list();
    if (!name) return list[0] || null;
    const n = name.trim().toLowerCase();
    return (
      list.find((a) => a.label.toLowerCase() === n || a.slug === slugify(n) || a.address.toLowerCase() === n) ||
      null
    );
  }

  /** host: "google" for Gmail/Google Workspace, otherwise the mail server name (e.g. mail.example.com). */
  async add(label: string, address: string, host: string, password: string): Promise<MailAccount> {
    if (!isEmailAddress(address)) throw new Error("That does not look like an email address.");
    const google = host.toLowerCase() === "google" || host.toLowerCase() === "gmail";
    if (!google && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) throw new Error("Server should look like mail.example.com, or the word google.");
    if (google) password = password.replace(/\s+/g, ""); // app passwords are shown with spaces
    const acct: MailAccount = {
      label,
      slug: slugify(label),
      address: address.trim(),
      imapHost: google ? "imap.gmail.com" : host,
      smtpHost: google ? "smtp.gmail.com" : host,
    };

    // Check the login before saving anything
    await this.withImap(acct, password, async () => {});

    const r = Bun.spawnSync([
      "security", "add-generic-password", "-U",
      "-a", keychainUser(), "-s", `mail-${acct.slug}`, "-w", password,
    ]);
    if (r.exitCode !== 0) throw new Error("Could not save to Keychain: " + r.stderr.toString().trim());
    this.save([...this.list().filter((a) => a.slug !== acct.slug), acct]);
    this.cache.delete(acct.slug);
    return acct;
  }

  remove(label: string): boolean {
    const acct = this.find(label);
    if (!acct) return false;
    Bun.spawnSync(["security", "delete-generic-password", "-a", keychainUser(), "-s", `mail-${acct.slug}`]);
    this.save(this.list().filter((a) => a.slug !== acct.slug));
    this.cache.delete(acct.slug);
    return true;
  }

  private password(slug: string): string {
    const r = Bun.spawnSync(["security", "find-generic-password", "-a", keychainUser(), "-s", `mail-${slug}`, "-w"]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  }

  private async withImap<T>(acct: MailAccount, pass: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({
      host: acct.imapHost,
      port: 993,
      secure: true,
      auth: { user: acct.address, pass },
      logger: false,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /** Unread inbox mail from the last `days` days, newest first, for one account. Read-only. */
  private async unreadFor(acct: MailAccount, days: number, max: number): Promise<MailItem[]> {
    const hit = this.cache.get(acct.slug);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
    const pass = this.password(acct.slug);
    if (!pass) throw new Error("password missing from Keychain");

    const items = await this.withImap(acct, pass, async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const since = new Date(Date.now() - days * 86400000);
        const uids = ((await client.search({ seen: false, since }, { uid: true })) || []) as number[];
        const pick = uids.sort((a, b) => b - a).slice(0, max);
        const out: MailItem[] = [];
        if (!pick.length) return out;
        for await (const msg of client.fetch(pick, { source: true }, { uid: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const text = (parsed.text || "").replace(/\s+/g, " ").trim();
          out.push({
            account: acct.label,
            from: parsed.from?.text || "(unknown sender)",
            subject: parsed.subject || "(no subject)",
            date: parsed.date || new Date(),
            snippet: text.slice(0, 300),
          });
        }
        return out.sort((a, b) => b.date.getTime() - a.date.getTime());
      } finally {
        lock.release();
      }
    });
    this.cache.set(acct.slug, { at: Date.now(), items });
    return items;
  }

  /** Unread mail across all accounts. */
  async unread(days = 3, max = 15): Promise<{ items: MailItem[]; errors: string[] }> {
    const items: MailItem[] = [];
    const errors: string[] = [];
    for (const acct of this.list()) {
      try {
        items.push(...(await this.unreadFor(acct, days, max)));
      } catch (error: any) {
        errors.push(`${acct.label}: ${error.message || error}`);
      }
    }
    items.sort((a, b) => b.date.getTime() - a.date.getTime());
    return { items, errors };
  }

  format(items: MailItem[], withSnippet = true): string {
    if (!items.length) return "No unread email.";
    return items
      .map((m) => {
        const when = m.date.toLocaleString("en-US", {
          timeZone: this.timezone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
        });
        const head = `[${m.account}] ${when}  ${m.from}\n  ${m.subject}`;
        return withSnippet && m.snippet ? `${head}\n  ${m.snippet}` : head;
      })
      .join("\n");
  }

  /**
   * Send one plain-text email. Only the Approve button handler calls this.
   * Saves a copy to the Sent folder when the server does not do it itself.
   */
  async send(acct: MailAccount, to: string, subject: string, body: string): Promise<void> {
    if (!isEmailAddress(to)) throw new Error(`"${to}" is not a single email address.`);
    const pass = this.password(acct.slug);
    if (!pass) throw new Error("password missing from Keychain");

    const transport = nodemailer.createTransport({
      host: acct.smtpHost,
      port: 465,
      secure: true,
      auth: { user: acct.address, pass },
    });
    const message = { from: acct.address, to: to.trim(), subject, text: body };
    await transport.sendMail(message);

    // Gmail stores sent mail automatically; other servers usually do not
    if (acct.smtpHost === "smtp.gmail.com") return;
    try {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        nodemailer
          .createTransport({ streamTransport: true, buffer: true })
          .sendMail(message, (err, info: any) => (err ? reject(err) : resolve(info.message)));
      });
      await this.withImap(acct, pass, async (client) => {
        const boxes = await client.list();
        const sent =
          boxes.find((b: any) => b.specialUse === "\\Sent") ||
          boxes.find((b: any) => /(^|[./])sent( items| mail)?$/i.test(b.path));
        if (sent) await client.append(sent.path, raw, ["\\Seen"]);
      });
    } catch (error) {
      console.error("Could not save copy to Sent:", error);
    }
  }
}

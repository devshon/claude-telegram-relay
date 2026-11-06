/**
 * Approval queue.
 *
 * Claude never sends anything to anyone except the owner. When it writes a
 * message meant for someone else, it wraps it in a DRAFT tag:
 *
 *   [DRAFT: sms | Jane Smith 239-555-0100]
 *   Hi Jane, confirming our showing tomorrow at 2 PM.
 *   [/DRAFT]
 *
 *   [DRAFT: email | jane@example.com | Showing confirmation]
 *   ...body...
 *   [/DRAFT]
 *
 * The relay stores each draft locally (status "pending") and posts it to the
 * owner with Approve / Edit / Reject buttons. Nothing is sent by AI. When a
 * sender is connected later, it runs only from the Approve button handler.
 */

import { Database } from "bun:sqlite";

export type DraftStatus = "pending" | "approved" | "rejected" | "sent";

export interface Draft {
  id: number;
  created_at: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  status: DraftStatus;
  decided_at: string | null;
}

export class DraftStore {
  constructor(private db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        channel TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'approved', 'rejected', 'sent')),
        decided_at TEXT
      );
    `);
  }

  add(channel: string, recipient: string, subject: string | null, body: string): Draft {
    const row = this.db
      .query(
        "INSERT INTO drafts (channel, recipient, subject, body) VALUES (?, ?, ?, ?) RETURNING *"
      )
      .get(channel, recipient, subject, body) as Draft;
    return row;
  }

  get(id: number): Draft | null {
    return (this.db.query("SELECT * FROM drafts WHERE id = ?").get(id) as Draft) || null;
  }

  setStatus(id: number, status: DraftStatus): void {
    this.db
      .query("UPDATE drafts SET status = ?, decided_at = datetime('now') WHERE id = ?")
      .run(status, id);
  }

  setBody(id: number, body: string): void {
    this.db.query("UPDATE drafts SET body = ?, status = 'pending', decided_at = NULL WHERE id = ?").run(body, id);
  }

  pending(): Draft[] {
    return this.db
      .query("SELECT * FROM drafts WHERE status = 'pending' ORDER BY id")
      .all() as Draft[];
  }
}

const DRAFT_RE = /\[DRAFT:\s*([^|\]\n]+?)\s*\|\s*([^|\]\n]+?)(?:\s*\|\s*([^\]\n]+?))?\s*\]\s*\n?([\s\S]*?)\n?\s*\[\/DRAFT\]/gi;

/** Pull DRAFT blocks out of a response. Returns the remaining text and the parsed drafts. */
export function extractDrafts(response: string): {
  text: string;
  drafts: { channel: string; recipient: string; subject: string | null; body: string }[];
} {
  const drafts: { channel: string; recipient: string; subject: string | null; body: string }[] = [];
  const text = response
    .replace(DRAFT_RE, (_m, channel, recipient, subject, body) => {
      const clean = String(body).trim();
      if (clean) {
        drafts.push({
          channel: String(channel).trim().toLowerCase(),
          recipient: String(recipient).trim(),
          subject: subject ? String(subject).trim() : null,
          body: clean,
        });
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, drafts };
}

/** Text shown on the approval card. */
export function formatDraft(d: Draft): string {
  const lines = [`Draft #${d.id} (${d.channel}) to ${d.recipient}`];
  if (d.subject) lines.push(`Subject: ${d.subject}`);
  lines.push("", d.body);
  return lines.join("\n");
}

export const DRAFT_INSTRUCTIONS =
  "\nDRAFTS AND SENDING:" +
  "\nYou cannot send, post, or publish anything to anyone except the user. Never claim you sent something." +
  "\nWhen asked to write a text, email, or post meant for someone else, put the exact message in a draft block:" +
  "\n[DRAFT: sms | recipient name and number]\nmessage text\n[/DRAFT]" +
  "\n[DRAFT: email | recipient address | subject]\nemail body\n[/DRAFT]" +
  "\nThe user approves, edits, or rejects each draft with buttons. Keep any text outside the block to one short line.";

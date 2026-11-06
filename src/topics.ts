/**
 * Business topics.
 *
 * Hal can run inside one Telegram forum group with a topic per business.
 * Each topic is bound to a business name (and optionally the email and
 * calendar labels that belong to it). Messages in a topic get that business's
 * profile and only its accounts. One topic can be marked as Approvals: every
 * draft card is posted there.
 *
 * State lives in $RELAY_DIR/topics.json; profiles in $RELAY_DIR/profiles/<name>.md.
 * Direct messages to Hal keep working as before (the "Command" context).
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface TopicBinding {
  business: string;
  /** Email and calendar labels for this business. Empty = all. */
  accounts: string[];
}

interface TopicState {
  groupChatId: number | null;
  approvalsThreadId: number | null;
  commandThreadId: number | null;
  topics: Record<string, TopicBinding>;
}

export const COMMAND = "Command";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

export class Topics {
  private file: string;
  private profileDir: string;
  private state: TopicState;

  constructor(relayDir: string) {
    this.file = join(relayDir, "topics.json");
    this.profileDir = join(relayDir, "profiles");
    mkdirSync(this.profileDir, { recursive: true });
    try {
      this.state = JSON.parse(readFileSync(this.file, "utf-8"));
    } catch {
      this.state = { groupChatId: null, approvalsThreadId: null, commandThreadId: null, topics: {} };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  get groupChatId(): number | null {
    return this.state.groupChatId;
  }

  /** True when this chat may be used: a private chat, or the one bound group. */
  allowedChat(chatId: number, chatType: string): boolean {
    if (chatType === "private") return true;
    return this.state.groupChatId === null || this.state.groupChatId === chatId;
  }

  /** Bind a topic (thread) in the group to a business. The first bind claims the group. */
  bind(chatId: number, threadId: number, business: string, accounts: string[]): void {
    if (this.state.groupChatId === null) this.state.groupChatId = chatId;
    if (this.state.groupChatId !== chatId) throw new Error("Hal is already bound to another group.");
    this.state.topics[String(threadId)] = { business, accounts };
    if (business.toLowerCase() === COMMAND.toLowerCase()) this.state.commandThreadId = threadId;
    this.save();
  }

  unbind(threadId: number): boolean {
    const had = !!this.state.topics[String(threadId)];
    delete this.state.topics[String(threadId)];
    if (this.state.approvalsThreadId === threadId) this.state.approvalsThreadId = null;
    if (this.state.commandThreadId === threadId) this.state.commandThreadId = null;
    this.save();
    return had;
  }

  setApprovals(chatId: number, threadId: number): void {
    if (this.state.groupChatId === null) this.state.groupChatId = chatId;
    if (this.state.groupChatId !== chatId) throw new Error("Hal is already bound to another group.");
    this.state.approvalsThreadId = threadId;
    this.save();
  }

  /** Where approval cards go, or null to post them where the draft was made. */
  approvalsTarget(): { chatId: number; threadId: number } | null {
    const { groupChatId, approvalsThreadId } = this.state;
    return groupChatId !== null && approvalsThreadId !== null ? { chatId: groupChatId, threadId: approvalsThreadId } : null;
  }

  /** Where the morning brief goes, or null for a direct message. */
  commandTarget(): { chatId: number; threadId: number } | null {
    const { groupChatId, commandThreadId } = this.state;
    return groupChatId !== null && commandThreadId !== null ? { chatId: groupChatId, threadId: commandThreadId } : null;
  }

  isApprovals(chatId: number, threadId: number | undefined): boolean {
    return chatId === this.state.groupChatId && threadId !== undefined && threadId === this.state.approvalsThreadId;
  }

  /** The business for a message, or null for Command (direct messages, General, unbound topics). */
  bindingFor(chatId: number, threadId: number | undefined): TopicBinding | null {
    if (chatId !== this.state.groupChatId || threadId === undefined) return null;
    const b = this.state.topics[String(threadId)];
    if (!b || b.business.toLowerCase() === COMMAND.toLowerCase()) return null;
    return b;
  }

  list(): string {
    const lines = Object.entries(this.state.topics).map(([id, b]) => {
      const acc = b.accounts.length ? ` (accounts: ${b.accounts.join(", ")})` : " (all accounts)";
      return `- ${b.business}${acc}${this.profile(b.business) ? "" : ", no profile yet"} [topic ${id}]`;
    });
    if (this.state.approvalsThreadId !== null) lines.push(`- Approvals [topic ${this.state.approvalsThreadId}]`);
    return lines.length ? lines.join("\n") : "No topics yet.";
  }

  profile(name: string): string {
    try {
      return readFileSync(join(this.profileDir, `${slug(name)}.md`), "utf-8").trim();
    } catch {
      return "";
    }
  }

  setProfile(name: string, text: string): void {
    writeFileSync(join(this.profileDir, `${slug(name)}.md`), text.trim() + "\n");
  }
}

/** Session key: one Claude conversation per chat topic. */
export function sessionKey(chatId: number | undefined, threadId: number | undefined): string {
  return `${chatId ?? 0}:${threadId ?? 0}`;
}

/** Parse "Real Estate: SWFL, SWFL Calendar" into a name and labels. */
export function parseBinding(arg: string): { business: string; accounts: string[] } | null {
  const [name, rest] = arg.split(/:(.*)/s);
  const business = (name || "").trim();
  if (!business) return null;
  const accounts = (rest || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { business, accounts };
}

/** Keep only items whose label belongs to the binding (all items when no labels are set). */
export function forBinding<T>(items: T[], label: (t: T) => string, b: TopicBinding | null): T[] {
  if (!b || !b.accounts.length) return items;
  const want = new Set(b.accounts.map((a) => a.toLowerCase()));
  return items.filter((t) => want.has(label(t).toLowerCase()));
}

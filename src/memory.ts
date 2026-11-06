/**
 * Memory Module (local)
 *
 * Persistent messages, facts, and goals stored in a local SQLite file
 * (default: $RELAY_DIR/memory.db). Nothing leaves the machine.
 *
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves them locally, and strips them
 * from the response before sending to the user.
 *
 * Search over past messages uses SQLite full-text search (FTS5) when the
 * system SQLite supports it, and falls back to a simple keyword match.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

export class LocalMemory {
  private db: Database;
  private hasFts = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'telegram',
        metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal')),
        content TEXT NOT NULL,
        deadline TEXT,
        completed_at TEXT
      );
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
          USING fts5(content, content='messages', content_rowid='id');
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
        END;
      `);
      this.hasFts = true;
    } catch (error) {
      console.warn("FTS5 not available, using keyword search:", error);
    }
  }

  /** Shared handle so other local stores (drafts) use the same file. */
  get database(): Database {
    return this.db;
  }

  saveMessage(role: string, content: string, metadata?: Record<string, unknown>): void {
    try {
      this.db
        .query("INSERT INTO messages (role, content, metadata) VALUES (?, ?, ?)")
        .run(role, content, JSON.stringify(metadata || {}));
    } catch (error) {
      console.error("Memory save error:", error);
    }
  }

  addFact(content: string): void {
    this.db.query("INSERT INTO memory (type, content) VALUES ('fact', ?)").run(content);
  }

  addGoal(content: string, deadline: string | null): void {
    this.db
      .query("INSERT INTO memory (type, content, deadline) VALUES ('goal', ?, ?)")
      .run(content, deadline);
  }

  completeGoal(search: string): boolean {
    const row = this.db
      .query("SELECT id FROM memory WHERE type = 'goal' AND content LIKE ? LIMIT 1")
      .get(`%${search}%`) as { id: number } | null;
    if (!row) return false;
    this.db
      .query("UPDATE memory SET type = 'completed_goal', completed_at = datetime('now') WHERE id = ?")
      .run(row.id);
    return true;
  }

  facts(): { content: string }[] {
    return this.db
      .query("SELECT content FROM memory WHERE type = 'fact' ORDER BY created_at")
      .all() as { content: string }[];
  }

  activeGoals(): { content: string; deadline: string | null }[] {
    return this.db
      .query("SELECT content, deadline FROM memory WHERE type = 'goal' ORDER BY created_at")
      .all() as { content: string; deadline: string | null }[];
  }

  /** Most relevant past messages for a query (excluding the newest one, which is the query itself). */
  search(query: string, limit = 5): { role: string; content: string }[] {
    const words = (query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 12);
    if (!words.length) return [];

    try {
      if (this.hasFts) {
        const ftsQuery = words.map((w) => `"${w}"`).join(" OR ");
        return this.db
          .query(
            `SELECT m.role, m.content FROM messages_fts f
             JOIN messages m ON m.id = f.rowid
             WHERE messages_fts MATCH ? AND m.id < (SELECT MAX(id) FROM messages)
             ORDER BY rank LIMIT ?`
          )
          .all(ftsQuery, limit) as { role: string; content: string }[];
      }
      const clauses = words.map(() => "content LIKE ?").join(" OR ");
      return this.db
        .query(
          `SELECT role, content FROM messages
           WHERE (${clauses}) AND id < (SELECT MAX(id) FROM messages)
           ORDER BY id DESC LIMIT ?`
        )
        .all(...words.map((w) => `%${w}%`), limit) as { role: string; content: string }[];
    } catch (error) {
      console.error("Memory search error:", error);
      return [];
    }
  }
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals locally and returns the cleaned response.
 */
export async function processMemoryIntents(
  memory: LocalMemory | null,
  response: string
): Promise<string> {
  if (!memory) return response;

  let clean = response;

  try {
    // [REMEMBER: fact to store]
    for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
      memory.addFact(match[1].trim());
      clean = clean.replace(match[0], "");
    }

    // [GOAL: text] or [GOAL: text | DEADLINE: date]
    for (const match of response.matchAll(
      /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
    )) {
      memory.addGoal(match[1].trim(), match[2]?.trim() || null);
      clean = clean.replace(match[0], "");
    }

    // [DONE: search text for completed goal]
    for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
      memory.completeGoal(match[1].trim());
      clean = clean.replace(match[0], "");
    }
  } catch (error) {
    console.error("Memory intent error:", error);
  }

  return clean.replace(/[ \t]{2,}/g, " ").trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(memory: LocalMemory | null): Promise<string> {
  if (!memory) return "";

  try {
    const parts: string[] = [];
    const facts = memory.facts();
    const goals = memory.activeGoals();

    if (facts.length) {
      parts.push("FACTS:\n" + facts.map((f) => `- ${f.content}`).join("\n"));
    }
    if (goals.length) {
      parts.push(
        "GOALS:\n" +
          goals
            .map((g) => `- ${g.content}${g.deadline ? ` (by ${g.deadline})` : ""}`)
            .join("\n")
      );
    }
    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Keyword search over past messages for relevant context.
 */
export async function getRelevantContext(
  memory: LocalMemory | null,
  query: string
): Promise<string> {
  if (!memory) return "";

  const results = memory.search(query, 5);
  if (!results.length) return "";

  return (
    "RELEVANT PAST MESSAGES:\n" +
    results.map((m) => `[${m.role}]: ${m.content}`).join("\n")
  );
}

/**
 * Texts and calls exporter (read-only).
 *
 * This is the only program that gets Full Disk Access. It is compiled to a
 * standalone binary (setup/texts.sh), runs every 5 minutes from its own
 * launchd job, and copies the last few days of texts and calls into
 * $RELAY_DIR/texts.json. The relay and Claude read that file; neither ever
 * gets Full Disk Access. All databases are opened read-only.
 *
 * Usage: hal-texts <relay-dir> [days]
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, writeFileSync, chmodSync, copyFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

const HOME = homedir();
const RELAY_DIR = process.argv[2] || process.env.RELAY_DIR || join(HOME, ".claude-relay");
const DAYS = Number(process.argv[3] || 3);
const APPLE_EPOCH = 978307200; // 2001-01-01 in Unix seconds

const CHAT_DB = join(HOME, "Library", "Messages", "chat.db");
const CALL_DB = join(HOME, "Library", "Application Support", "CallHistoryDB", "CallHistory.storedata");
const AB_DIR = join(HOME, "Library", "Application Support", "AddressBook");

/** Open a copy of a live database (plus its WAL) read-only, so the original is never touched or locked. */
function openCopy(path: string): { db: Database; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hal-texts-"));
  const base = join(dir, "db");
  copyFileSync(path, base);
  for (const ext of ["-wal", "-shm"]) if (existsSync(path + ext)) copyFileSync(path + ext, base + ext);
  const db = new Database(base, { readonly: true });
  return { db, done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function digits(s: string): string {
  const d = s.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

/** Phone number and email -> contact name, from the local Contacts databases. */
function contacts(): Map<string, string> {
  const map = new Map<string, string>();
  const files: string[] = [];
  const main = join(AB_DIR, "AddressBook-v22.abcddb");
  if (existsSync(main)) files.push(main);
  const sources = join(AB_DIR, "Sources");
  if (existsSync(sources)) {
    for (const s of readdirSync(sources)) {
      const f = join(sources, s, "AddressBook-v22.abcddb");
      if (existsSync(f)) files.push(f);
    }
  }
  for (const f of files) {
    try {
      const { db, done } = openCopy(f);
      try {
        const name = "TRIM(COALESCE(r.ZFIRSTNAME,'') || ' ' || COALESCE(r.ZLASTNAME,''))";
        const org = "COALESCE(r.ZORGANIZATION,'')";
        for (const row of db.query(
          `SELECT p.ZFULLNUMBER AS v, ${name} AS n, ${org} AS o FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER`
        ).all() as any[]) {
          const n = row.n || row.o;
          if (row.v && n) map.set(digits(row.v), n);
        }
        for (const row of db.query(
          `SELECT e.ZADDRESS AS v, ${name} AS n, ${org} AS o FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER`
        ).all() as any[]) {
          const n = row.n || row.o;
          if (row.v && n) map.set(String(row.v).toLowerCase(), n);
        }
      } finally {
        done();
      }
    } catch (error) {
      console.error(`Contacts read failed (${f}):`, error);
    }
  }
  return map;
}

function who(handle: string, book: Map<string, string>): string {
  if (!handle) return "unknown";
  const name = handle.includes("@") ? book.get(handle.toLowerCase()) : book.get(digits(handle));
  return name ? `${name} (${handle})` : handle;
}

/** Newer macOS stores message text in attributedBody (a typedstream blob) instead of text. */
function decodeAttributedBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const buf = Buffer.from(blob);
  const marker = buf.indexOf("NSString");
  if (marker < 0) return "";
  let i = marker + "NSString".length + 5; // skip class info bytes
  if (i >= buf.length) return "";
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    len = buf.readUInt16LE(i);
    i += 2;
  } else if (len === 0x82) {
    len = buf.readUInt32LE(i);
    i += 4;
  }
  return buf.subarray(i, i + len).toString("utf-8");
}

function appleDate(v: number): string {
  // chat.db stores nanoseconds on modern macOS, seconds on old versions
  const secs = v > 1e12 ? v / 1e9 : v;
  return new Date((secs + APPLE_EPOCH) * 1000).toISOString();
}

function texts(book: Map<string, string>) {
  if (!existsSync(CHAT_DB)) return { items: [], error: "Messages database not found" };
  const since = (Date.now() / 1000 - APPLE_EPOCH - DAYS * 86400) * 1e9;
  const { db, done } = openCopy(CHAT_DB);
  try {
    const rows = db.query(
      `SELECT m.date AS date, m.is_from_me AS me, m.text AS text, m.attributedBody AS body,
              h.id AS handle, c.display_name AS chat, m.service AS service
       FROM message m
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       LEFT JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE m.date > ? AND m.associated_message_type = 0
       ORDER BY m.date DESC LIMIT 300`
    ).all(since) as any[];
    const items = rows
      .map((r) => ({
        at: appleDate(r.date),
        from_me: r.me === 1,
        with: who(r.handle || "", book),
        group: r.chat || null,
        service: r.service || "",
        text: (r.text || decodeAttributedBody(r.body) || "").replace(/￼/g, "[attachment]").trim(),
      }))
      .filter((m) => m.text);
    return { items, error: null };
  } finally {
    done();
  }
}

function calls(book: Map<string, string>) {
  if (!existsSync(CALL_DB)) return { items: [], error: "Call history not found (turn on Calls on Other Devices on the iPhone)" };
  const since = Date.now() / 1000 - APPLE_EPOCH - DAYS * 86400;
  const { db, done } = openCopy(CALL_DB);
  try {
    const rows = db.query(
      `SELECT ZDATE AS date, ZDURATION AS dur, ZORIGINATED AS out, ZANSWERED AS answered, ZADDRESS AS addr
       FROM ZCALLRECORD WHERE ZDATE > ? ORDER BY ZDATE DESC LIMIT 100`
    ).all(since) as any[];
    const items = rows.map((r) => ({
      at: new Date((r.date + APPLE_EPOCH) * 1000).toISOString(),
      direction: r.out === 1 ? "outgoing" : r.answered === 1 ? "incoming" : "missed",
      with: who(r.addr ? String(r.addr) : "", book),
      minutes: Math.round((r.dur || 0) / 6) / 10,
    }));
    return { items, error: null };
  } finally {
    done();
  }
}

function attempt<T>(fn: () => T, fallback: T, label: string): T {
  try {
    return fn();
  } catch (error: any) {
    const msg = String(error?.message || error);
    console.error(`${label}:`, msg);
    return { ...(fallback as any), error: /authoriz|permission|not permitted|EPERM|EACCES/i.test(msg) ? "No Full Disk Access" : msg };
  }
}

let book = new Map<string, string>();
try {
  book = contacts();
} catch (error) {
  console.error("contacts:", error);
}
const out = {
  updated: new Date().toISOString(),
  days: DAYS,
  texts: attempt(() => texts(book), { items: [], error: null as string | null }, "texts"),
  calls: attempt(() => calls(book), { items: [], error: null as string | null }, "calls"),
};

const file = join(RELAY_DIR, "texts.json");
writeFileSync(file + ".tmp", JSON.stringify(out));
chmodSync(file + ".tmp", 0o600);
renameSync(file + ".tmp", file);
console.log(`${out.updated}: ${out.texts.items.length} texts, ${out.calls.items.length} calls`);

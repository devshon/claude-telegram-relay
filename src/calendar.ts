/**
 * Read-only calendars from secret iCal (.ics) addresses.
 *
 * Calendar labels live in $RELAY_DIR/calendars.json. Each address is a
 * secret, so it is stored in the macOS login Keychain under the service
 * name "calendar-<slug>", never in a file. Nothing here can write to a
 * calendar.
 */

import IcalExpander from "ical-expander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { userInfo } from "os";

export interface CalEvent {
  calendar: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string;
}

interface CalConfig {
  label: string;
  slug: string;
}

const CACHE_MS = 5 * 60 * 1000;

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "calendar";
}

function keychainUser(): string {
  return process.env.USER || userInfo().username;
}

export class Calendars {
  private file: string;
  private cache = new Map<string, { at: number; ics: string }>();

  constructor(relayDir: string, private timezone: string) {
    this.file = join(relayDir, "calendars.json");
  }

  list(): CalConfig[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, "utf-8"));
    } catch {
      return [];
    }
  }

  private save(list: CalConfig[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  add(label: string, url: string): string {
    if (!/^https:\/\/\S+$/i.test(url)) throw new Error("That does not look like an https link.");
    const slug = slugify(label);
    const r = Bun.spawnSync([
      "security", "add-generic-password", "-U",
      "-a", keychainUser(), "-s", `calendar-${slug}`, "-w", url,
    ]);
    if (r.exitCode !== 0) throw new Error("Could not save to Keychain: " + r.stderr.toString().trim());
    const list = this.list().filter((c) => c.slug !== slug);
    list.push({ label, slug });
    this.save(list);
    this.cache.delete(slug);
    return slug;
  }

  remove(label: string): boolean {
    const slug = slugify(label);
    const list = this.list();
    if (!list.some((c) => c.slug === slug)) return false;
    Bun.spawnSync(["security", "delete-generic-password", "-a", keychainUser(), "-s", `calendar-${slug}`]);
    this.save(list.filter((c) => c.slug !== slug));
    this.cache.delete(slug);
    return true;
  }

  private url(slug: string): string {
    const r = Bun.spawnSync(["security", "find-generic-password", "-a", keychainUser(), "-s", `calendar-${slug}`, "-w"]);
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  }

  private async ics(slug: string): Promise<string> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.ics;
    const url = this.url(slug);
    if (!url) throw new Error("address missing from Keychain");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ics = await res.text();
    this.cache.set(slug, { at: Date.now(), ics });
    return ics;
  }

  /** Events overlapping [from, to), from every calendar, de-duplicated and sorted. */
  async events(from: Date, to: Date): Promise<{ events: CalEvent[]; errors: string[] }> {
    const out: CalEvent[] = [];
    const errors: string[] = [];

    for (const cal of this.list()) {
      try {
        const expander = new IcalExpander({ ics: await this.ics(cal.slug), maxIterations: 2000 });
        const { events, occurrences } = expander.between(from, to);
        const push = (summary: string, location: string, s: any, e: any) => {
          out.push({
            calendar: cal.label,
            title: summary || "(no title)",
            start: this.toDate(s),
            end: e ? this.toDate(e) : this.toDate(s),
            allDay: !!s.isDate,
            location: location || "",
          });
        };
        for (const ev of events) push(ev.summary, ev.location, ev.startDate, ev.endDate);
        for (const oc of occurrences) push(oc.item.summary, oc.item.location, oc.startDate, oc.endDate);
      } catch (error: any) {
        errors.push(`${cal.label}: ${error.message || error}`);
      }
    }

    // The same event can arrive from two synced calendars
    const seen = new Set<string>();
    const unique = out.filter((e) => {
      const key = `${e.title.toLowerCase()}|${e.start.getTime()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { events: unique, errors };
  }

  /** Start of the local day `offset` days from today, in the user's timezone. */
  dayStart(offset = 0): Date {
    const ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const [y, m, d] = ymd.split("-").map(Number);
    const guess = Date.UTC(y, m - 1, d + offset, 0, 0, 0);
    return new Date(guess - this.zoneOffsetMs(guess));
  }

  /** ICAL.Time to Date; all-day dates become midnight in the user's timezone. */
  private toDate(t: any): Date {
    if (!t.isDate) return t.toJSDate();
    const guess = Date.UTC(t.year, t.month - 1, t.day, 0, 0, 0);
    return new Date(guess - this.zoneOffsetMs(guess));
  }

  /** Milliseconds the timezone's wall clock is ahead of UTC at a given instant. */
  private zoneOffsetMs(at: number): number {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: this.timezone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(new Date(at)).map((x) => [x.type, x.value])
    );
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return wall - at;
  }

  private time(d: Date): string {
    return d.toLocaleTimeString("en-US", { timeZone: this.timezone, hour: "numeric", minute: "2-digit" });
  }

  private day(d: Date): string {
    return d.toLocaleDateString("en-US", { timeZone: this.timezone, weekday: "short", month: "short", day: "numeric" });
  }

  /** Plain-text agenda grouped by day, with overlaps marked CONFLICT. */
  format(events: CalEvent[]): string {
    if (!events.length) return "Nothing scheduled.";
    const lines: string[] = [];
    let currentDay = "";
    events.forEach((e, i) => {
      const day = this.day(e.start);
      if (day !== currentDay) {
        if (lines.length) lines.push("");
        lines.push(day);
        currentDay = day;
      }
      const when = e.allDay ? "All day" : `${this.time(e.start)}-${this.time(e.end)}`;
      const clash =
        !e.allDay &&
        events.some((o, j) => j !== i && !o.allDay && o.start < e.end && e.start < o.end);
      const where = e.location ? ` @ ${e.location}` : "";
      lines.push(`${when}  ${e.title}${where} [${e.calendar}]${clash ? "  CONFLICT" : ""}`);
    });
    return lines.join("\n");
  }
}

/**
 * Send one text through the Messages app on this Mac.
 *
 * Only the Approve button handler in relay.ts calls this, with the exact text
 * the owner approved. It goes out from the owner's own number (iMessage, or
 * SMS through the iPhone when Text Message Forwarding is on). The first send
 * asks once for permission for the relay to control Messages.
 */

/** Pull one phone number (or iMessage email) out of a recipient like "Tera RE +12396912961". */
export function textAddress(recipient: string): string | null {
  const email = recipient.match(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/i);
  if (email) return email[0];
  const phones = recipient.match(/\+?\d[\d\s().-]{8,}\d/g);
  if (!phones || phones.length !== 1) return null;
  const d = phones[0].replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return phones[0].trim().startsWith("+") ? `+${d}` : null;
}

const SCRIPT = `
on run argv
  set addr to item 1 of argv
  set msg to item 2 of argv
  tell application "Messages"
    try
      set acct to 1st account whose service type = iMessage
      send msg to participant addr of acct
      return "iMessage"
    on error
      set acct to 1st account whose service type = SMS
      send msg to participant addr of acct
      return "SMS"
    end try
  end tell
end run`;

/** Returns "iMessage" or "SMS". Throws with the reason if Messages refused. */
export async function sendText(address: string, body: string): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", SCRIPT, address, body], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    const e = err.trim();
    if (/-1743|not authori[sz]ed/i.test(e)) {
      throw new Error("Messages access not allowed. On the Mac Mini: System Settings > Privacy & Security > Automation > bun > turn on Messages.");
    }
    throw new Error(e || `osascript exited with ${code}`);
  }
  return out.trim() || "iMessage";
}

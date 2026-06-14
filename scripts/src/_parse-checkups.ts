import { readFileSync } from "node:fs";
const RAW = "/home/runner/workspace/.local/checkups-raw.jsonl";

type Row = { id: string; u: string; bot: boolean; c: string; t: string };
const rows: Row[] = readFileSync(RAW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
// fetched newest-first; sort chronological ascending
rows.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
console.log(`total messages: ${rows.length}`);
console.log(`range: ${rows[0].t.slice(0, 10)} -> ${rows[rows.length - 1].t.slice(0, 10)}`);

const CU_RE = /^!cu\b.*?<@!?(\d+)>/i;
const DID_RE = /did a checkup on\s+(.+?)\s*$/i;
const REMOVED_RE = /Removed checkup role from\s+(.+?)\.?\s*$/i;
const NOMONEY_RE = /Ripperdoc checkup on\s+<@!?(\d+)>\.\s*No money deducted/i;
const NOROLE_RE = /(.+?)\s+does not have the checkup role/i;

// classify bot message types for vocabulary
const botTypes: Record<string, number> = {};
for (const r of rows) {
  if (!r.bot) continue;
  let key = "OTHER";
  if (DID_RE.test(r.c)) key = "did a checkup on <char>";
  else if (REMOVED_RE.test(r.c)) key = "Removed checkup role from <char>";
  else if (NOMONEY_RE.test(r.c)) key = "Ripperdoc checkup on <@id> No money deducted";
  else if (NOROLE_RE.test(r.c)) key = "<char> does not have the checkup role";
  else if (/Cyberware Report/i.test(r.c)) key = "**Cyberware Report**";
  else if (/Paid meds:/i.test(r.c)) key = "Paid meds report";
  botTypes[key] = (botTypes[key] ?? 0) + 1;
}
console.log("\nBOT MESSAGE TYPES:", botTypes);

const cuCount = rows.filter((r) => CU_RE.test(r.c)).length;
console.log(`!cu commands: ${cuCount}`);

// Pair !cu <@id> with the next positive bot confirmation (within 180s) to get char->user
type Checkup = { userId: string; ts: string; char?: string; via: string };
const checkups: Checkup[] = [];
const cuNoConfirm: { userId: string; ts: string }[] = [];

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const cu = CU_RE.exec(r.c);
  if (cu && !r.bot) {
    const userId = cu[1];
    const ts0 = new Date(r.t).getTime();
    // look ahead up to 10 messages / 180s for a positive bot confirmation
    let confirmedChar: string | undefined;
    for (let j = i + 1; j < Math.min(i + 12, rows.length); j++) {
      const n = rows[j];
      if (!n.bot) continue;
      if (new Date(n.t).getTime() - ts0 > 180_000) break;
      const did = DID_RE.exec(n.c);
      const rem = REMOVED_RE.exec(n.c);
      if (did) { confirmedChar = did[1]; break; }
      if (rem) { confirmedChar = rem[1]; break; }
      if (NOROLE_RE.test(n.c)) { confirmedChar = "__NOROLE__"; break; }
    }
    if (confirmedChar && confirmedChar !== "__NOROLE__") {
      checkups.push({ userId, ts: r.t, char: confirmedChar, via: "!cu+confirm" });
    } else if (confirmedChar === "__NOROLE__") {
      cuNoConfirm.push({ userId, ts: r.t });
    } else {
      cuNoConfirm.push({ userId, ts: r.t });
    }
  }
  // direct id "No money deducted"
  const nm = NOMONEY_RE.exec(r.c);
  if (nm && r.bot) checkups.push({ userId: nm[1], ts: r.t, via: "nomoney" });
}

console.log(`\nconfirmed checkups (with userId): ${checkups.length}`);
console.log(`!cu without positive confirmation (norole/none): ${cuNoConfirm.length}`);

// per-user latest checkup (strict = confirmed only)
const byUser = new Map<string, { ts: string; char?: string; via: string; count: number }>();
for (const c of checkups) {
  const cur = byUser.get(c.userId);
  if (!cur || new Date(c.ts) > new Date(cur.ts)) byUser.set(c.userId, { ts: c.ts, char: c.char, via: c.via, count: (cur?.count ?? 0) + 1 });
  else cur.count++;
}
// loose: also fold in cuNoConfirm
const byUserLoose = new Map<string, string>();
for (const [u, v] of byUser) byUserLoose.set(u, v.ts);
for (const c of cuNoConfirm) {
  const cur = byUserLoose.get(c.userId);
  if (!cur || new Date(c.ts) > new Date(cur)) byUserLoose.set(c.userId, c.ts);
}

console.log(`distinct users with confirmed checkup: ${byUser.size}`);
console.log(`distinct users (loose incl norole): ${byUserLoose.size}`);

// reported users
const REPORTED = { "797182391030513745": "Nuxin/Curtis", "1121147736155242508": "Celeste owner" };
console.log("\n=== REPORTED USERS ===");
for (const [uid, label] of Object.entries(REPORTED)) {
  const strict = byUser.get(uid);
  const loose = byUserLoose.get(uid);
  console.log(`${label} (${uid}): strict=${strict ? strict.ts.slice(0, 16) + " char=" + strict.char + " n=" + strict.count : "NONE"} | loose=${loose ? loose.slice(0, 16) : "NONE"}`);
}

// recency distribution of strict last checkup
const now = Date.now();
const buckets = { "<=7d": 0, "<=14d": 0, "<=30d": 0, "<=60d": 0, ">60d": 0 };
for (const [, v] of byUser) {
  const days = (now - new Date(v.ts).getTime()) / 86400000;
  if (days <= 7) buckets["<=7d"]++; else if (days <= 14) buckets["<=14d"]++; else if (days <= 30) buckets["<=30d"]++; else if (days <= 60) buckets["<=60d"]++; else buckets[">60d"]++;
}
console.log("\nstrict last-checkup recency (today=2026-06-14):", buckets);

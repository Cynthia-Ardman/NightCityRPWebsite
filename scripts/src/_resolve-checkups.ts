import { readFileSync, writeFileSync } from "node:fs";
const RAW = "/home/runner/workspace/.local/checkups-raw.jsonl";
const ROSTER = "/home/runner/workspace/.local/roster.json";

type Row = { id: string; u: string; bot: boolean; c: string; t: string };
type Char = { id: number; name: string; owner_id: string | null; legacy_discord_username: string | null; created_at: string; last_checkup_at: string | null; kind: string };

const rows: Row[] = readFileSync(RAW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
rows.sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime());
const roster: Char[] = JSON.parse(readFileSync(ROSTER, "utf8"));

// ---- name matching helpers ----
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
// map normalized char name -> owner(s)
const nameToOwners = new Map<string, Set<string>>();
const tokenToOwners = new Map<string, Set<string>>();
for (const c of roster) {
  if (!c.owner_id) continue;
  const n = norm(c.name);
  if (!nameToOwners.has(n)) nameToOwners.set(n, new Set());
  nameToOwners.get(n)!.add(c.owner_id);
  for (const tok of n.split(" ")) {
    if (tok.length < 3) continue;
    if (!tokenToOwners.has(tok)) tokenToOwners.set(tok, new Set());
    tokenToOwners.get(tok)!.add(c.owner_id);
  }
}
// Resolve a Discord checkup display name (may have multiple aliases sep by / | ,) to a single owner id, if unambiguous.
function resolveOwnerByName(display: string): { owner: string | null; reason: string } {
  const aliases = display.split(/[\/|,]/).map((s) => norm(s)).filter((s) => s.length >= 2);
  // 1) exact full-name match on any alias
  const exact = new Set<string>();
  for (const a of aliases) { const o = nameToOwners.get(a); if (o) for (const x of o) exact.add(x); }
  if (exact.size === 1) return { owner: [...exact][0], reason: "exact-alias" };
  if (exact.size > 1) return { owner: null, reason: "exact-ambiguous" };
  // 2) also try whole display normalized
  const whole = nameToOwners.get(norm(display));
  if (whole && whole.size === 1) return { owner: [...whole][0], reason: "exact-whole" };
  // 3) token overlap: collect owners sharing a distinctive token
  const cand = new Map<string, number>();
  for (const a of aliases) for (const tok of a.split(" ")) {
    if (tok.length < 4) continue;
    const o = tokenToOwners.get(tok);
    if (o && o.size <= 3) for (const x of o) cand.set(x, (cand.get(x) ?? 0) + 1);
  }
  if (cand.size === 1) return { owner: [...cand.keys()][0], reason: "token" };
  return { owner: null, reason: cand.size === 0 ? "no-match" : "token-ambiguous" };
}

const CU_RE = /^!cu\b.*?<@!?(\d+)>/i;
const DID_RE = /did a checkup on\s+(.+?)\s*$/i;
const REMOVED_RE = /Removed checkup role from\s+(.+?)\.?\s*$/i;
const NOMONEY_RE = /Ripperdoc checkup on\s+<@!?(\d+)>\.\s*No money deducted/i;

type Event = { ts: string; owner: string | null; char?: string; how: string };
const events: Event[] = [];
const unresolved: { ts: string; char: string; reason: string }[] = [];

function precedingCu(idx: number): string | null {
  const t0 = new Date(rows[idx].t).getTime();
  for (let j = idx - 1; j >= Math.max(0, idx - 12); j--) {
    const p = rows[j];
    if (p.bot) continue;
    if (t0 - new Date(p.t).getTime() > 180_000) break;
    const m = CU_RE.exec(p.c);
    if (m) return m[1];
  }
  return null;
}

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r.bot) continue;
  const nm = NOMONEY_RE.exec(r.c);
  if (nm) { events.push({ ts: r.t, owner: nm[1], how: "nomoney-id" }); continue; }
  const did = DID_RE.exec(r.c);
  const rem = !did ? REMOVED_RE.exec(r.c) : null;
  const m = did || rem;
  if (m) {
    const char = m[1].trim();
    const cu = precedingCu(i);
    if (cu) { events.push({ ts: r.t, owner: cu, char, how: "paired-cu" }); continue; }
    const res = resolveOwnerByName(char);
    if (res.owner) events.push({ ts: r.t, owner: res.owner, char, how: "name-" + res.reason });
    else { events.push({ ts: r.t, owner: null, char, how: "unresolved-" + res.reason }); unresolved.push({ ts: r.t, char, reason: res.reason }); }
  }
}

// per-owner latest
const byOwner = new Map<string, { ts: string; char?: string; how: string; n: number }>();
for (const e of events) {
  if (!e.owner) continue;
  const cur = byOwner.get(e.owner);
  if (!cur) byOwner.set(e.owner, { ts: e.ts, char: e.char, how: e.how, n: 1 });
  else { cur.n++; if (new Date(e.ts) > new Date(cur.ts)) { cur.ts = e.ts; cur.char = e.char; cur.how = e.how; } }
}

console.log(`events: ${events.length} (resolved owner: ${events.filter(e=>e.owner).length}, unresolved: ${unresolved.length})`);
const howCounts: Record<string, number> = {};
for (const e of events) howCounts[e.how.replace(/^(name-|unresolved-)/, (x)=>x)] = (howCounts[e.how]??0)+1;
console.log("resolution methods:", events.reduce<Record<string,number>>((a,e)=>{a[e.how.split("-").slice(0,2).join("-")]=(a[e.how.split("-").slice(0,2).join("-")]??0)+1;return a;},{}));
console.log(`distinct owners with a checkup: ${byOwner.size}`);

// how many roster characters would get a last_checkup_at, and recency
const now = Date.now();
let wouldSet = 0; const rec = { "<=7d":0,"<=14d":0,"<=30d":0,"<=60d":0,">60d":0 };
const ownerChars = new Map<string, Char[]>();
for (const c of roster) { if (!c.owner_id) continue; if (!ownerChars.has(c.owner_id)) ownerChars.set(c.owner_id, []); ownerChars.get(c.owner_id)!.push(c); }
for (const [owner, info] of byOwner) {
  const chars = ownerChars.get(owner);
  if (!chars) continue;
  wouldSet += chars.length;
  const days = (now - new Date(info.ts).getTime())/86400000;
  if (days<=7) rec["<=7d"]++; else if (days<=14) rec["<=14d"]++; else if (days<=30) rec["<=30d"]++; else if (days<=60) rec["<=60d"]++; else rec[">60d"]++;
}
console.log(`owners-with-checkup that map to roster chars; roster chars that would get last_checkup_at: ${wouldSet}`);
console.log("owner last-checkup recency (today 2026-06-14):", rec);

// owners in channel not found in roster
const orphanOwners = [...byOwner.keys()].filter((o)=>!ownerChars.has(o));
console.log(`channel owners NOT in roster (no character): ${orphanOwners.length}`);

// reported
console.log("\n=== reported ===");
for (const [uid,label] of [["797182391030513745","Curtis/knuckson"],["1121147736155242508","Celeste/bensubean"]] as const) {
  const b = byOwner.get(uid);
  console.log(`${label} (${uid}): ${b ? b.ts.slice(0,16)+" via "+b.how+" char="+b.char+" n="+b.n : "NO CHECKUP IN CHANNEL"}`);
}

writeFileSync("/home/runner/workspace/.local/checkup-byowner.json", JSON.stringify([...byOwner.entries()].map(([owner,v])=>({owner,...v})),null,0));
writeFileSync("/home/runner/workspace/.local/checkup-unresolved.json", JSON.stringify(unresolved,null,2));
console.log("\nwrote .local/checkup-byowner.json and checkup-unresolved.json");

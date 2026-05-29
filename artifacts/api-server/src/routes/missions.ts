import { Router, type IRouter } from "express";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import {
  db,
  missionLog,
  characters,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole } from "../lib/discord";

const router: IRouter = Router();

// A "mission" in the UI sense is a group of mission_log rows sharing the
// same fixer, title, and calendar day (occurredAt if set, otherwise
// createdAt). That mirrors how fixers actually log them — one row per
// participant typed into the form with the same title in the same sitting.
// The composite ID we expose to the client is `${fixerId}:${title}:${date}`,
// base64'd so it's URL-safe.
//
// We never collapse rows at the DB level — each row keeps its own
// payoutEddies and characterId. The grouping is purely a presentation
// concern that the API computes on read.

type MissionRow = {
  id: number;
  characterId: number | null;
  characterName: string | null;
  characterPortraitUrl: string | null;
  fixerId: string | null;
  fixerName: string | null;
  fixerAvatarUrl: string | null;
  title: string;
  summary: string | null;
  payoutEddies: number;
  status: string;
  occurredAt: Date | null;
  createdAt: Date;
};

// Extract the attendee Discord ID embedded in a [legacy-mission:<missionId>:<attendeeId>]
// tag (stamped by the prod importer). Used to fall back to a Discord
// username when characterId couldn't be resolved on a legacy row.
function legacyAttendeeId(s: string | null): string | null {
  if (!s) return null;
  const m = s.match(/\[legacy-mission:[^:]+:([^\]]+)\]/);
  return m ? m[1] : null;
}

// Strip internal anchors stamped by the prod importer ([legacy-mission:...]
// and [legacy:...]). These were never meant to surface in the UI — they
// exist only so the importer can detect previously-imported rows on rerun.
function stripLegacyTags(s: string | null): string | null {
  if (!s) return s;
  const cleaned = s
    .replace(/\[legacy-mission:[^\]]+\]/g, "")
    .replace(/\[legacy(?:-[a-z]+)?:[^\]]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned : null;
}

function dayKey(d: Date | null | undefined, fallback: Date): string {
  const dt = d ?? fallback;
  // YYYY-MM-DD in UTC. Avoids local-timezone drift between API/UI.
  return dt.toISOString().slice(0, 10);
}

function groupKey(r: MissionRow): string {
  return `${r.fixerId ?? "_"}|${r.title}|${dayKey(r.occurredAt, r.createdAt)}`;
}

function encodeGroupId(key: string): string {
  return Buffer.from(key, "utf8").toString("base64url");
}
function decodeGroupId(id: string): string | null {
  try {
    const s = Buffer.from(id, "base64url").toString("utf8");
    return s.includes("|") ? s : null;
  } catch {
    return null;
  }
}

const baseSelect = () =>
  db
    .select({
      id: missionLog.id,
      characterId: missionLog.characterId,
      characterName: characters.name,
      characterPortraitUrl: characters.portraitUrl,
      fixerId: missionLog.fixerId,
      fixerName: users.username,
      fixerAvatarUrl: users.avatarUrl,
      title: missionLog.title,
      summary: missionLog.summary,
      payoutEddies: missionLog.payoutEddies,
      status: missionLog.status,
      occurredAt: missionLog.occurredAt,
      createdAt: missionLog.createdAt,
    })
    .from(missionLog)
    .leftJoin(characters, eq(characters.id, missionLog.characterId))
    .leftJoin(users, eq(users.id, missionLog.fixerId));

type MissionGroupSummary = {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  occurredAt: string | null;
  createdAt: string;
  fixerId: string | null;
  fixerName: string | null;
  fixerAvatarUrl: string | null;
  participantCount: number;
  totalPayoutEddies: number;
  // For "my missions" view: the entries that belong to the requesting
  // player (or the single representative entry for global views).
  myPayoutEddies: number | null;
  myCharacters: Array<{
    id: number;
    name: string;
    portraitUrl: string | null;
    payoutEddies: number;
  }>;
  // Every resolved participating character in the group (deduped by id),
  // regardless of who is asking. Powers the clickable "Players" list on
  // the mission card. Legacy rows without a resolved characterId are still
  // counted in participantCount but cannot be listed/linked here.
  players: Array<{
    characterId: number;
    name: string;
    portraitUrl: string | null;
  }>;
};

function groupRows(rows: MissionRow[], mineCharacterIds: Set<number> | null): MissionGroupSummary[] {
  const buckets = new Map<string, MissionRow[]>();
  // Preserve discovery order so the most-recent group (rows are pre-sorted
  // by createdAt desc) lands first.
  const order: string[] = [];
  for (const r of rows) {
    const k = groupKey(r);
    if (!buckets.has(k)) {
      buckets.set(k, []);
      order.push(k);
    }
    buckets.get(k)!.push(r);
  }
  return order.map((k) => {
    const rs = buckets.get(k)!;
    const head = rs[0];
    const myRows = mineCharacterIds
      ? rs.filter((r) => r.characterId != null && mineCharacterIds.has(r.characterId))
      : [];
    return {
      id: encodeGroupId(k),
      title: stripLegacyTags(head.title) ?? head.title,
      summary: stripLegacyTags(head.summary),
      status: head.status,
      occurredAt: head.occurredAt ? head.occurredAt.toISOString() : null,
      createdAt: head.createdAt.toISOString(),
      fixerId: head.fixerId,
      fixerName: head.fixerName,
      fixerAvatarUrl: head.fixerAvatarUrl,
      participantCount: countParticipants(rs),
      totalPayoutEddies: rs.reduce((a, r) => a + (r.payoutEddies ?? 0), 0),
      myPayoutEddies: mineCharacterIds
        ? myRows.reduce((a, r) => a + (r.payoutEddies ?? 0), 0)
        : null,
      myCharacters: myRows
        .filter((r) => r.characterId != null)
        .map((r) => ({
          id: r.characterId!,
          name: r.characterName ?? "(unknown)",
          portraitUrl: r.characterPortraitUrl,
          payoutEddies: r.payoutEddies ?? 0,
        })),
      players: dedupePlayers(rs),
    };
  });
}

// Count distinct participants in a group: resolved characters (by id) plus
// legacy attendees that couldn't be resolved (by their embedded Discord id).
// This keeps pure-legacy missions showing the "N players (legacy)" fallback
// on the card even when none can be linked.
function countParticipants(rs: MissionRow[]): number {
  const resolved = new Set<number>();
  const legacy = new Set<string>();
  for (const r of rs) {
    if (r.characterId != null) {
      resolved.add(r.characterId);
    } else {
      const lid = legacyAttendeeId(r.summary);
      if (lid) legacy.add(lid);
    }
  }
  return resolved.size + legacy.size;
}

// Collect every resolved participating character in a group, deduped by id,
// preserving first-seen order. Legacy rows with a null characterId are
// dropped here (they're still reflected in participantCount).
function dedupePlayers(rs: MissionRow[]): MissionGroupSummary["players"] {
  const seen = new Set<number>();
  const out: MissionGroupSummary["players"] = [];
  for (const r of rs) {
    if (r.characterId == null || seen.has(r.characterId)) continue;
    seen.add(r.characterId);
    out.push({
      characterId: r.characterId,
      name: r.characterName ?? "(unknown)",
      portraitUrl: r.characterPortraitUrl,
    });
  }
  return out;
}

// Player view: missions where ANY of my characters participated.
router.get("/missions/mine", requireAuth, async (req, res): Promise<void> => {
  // Find every character owned by the caller (claimed or transferred to
  // them). We need the IDs both to filter the SQL and to mark "my" entries
  // inside each group.
  const myChars = await db
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id));
  const myCharIds = myChars.map((c) => c.id);
  if (myCharIds.length === 0) {
    res.json([]);
    return;
  }

  // 1) Find the (title, fixerId, day) groups the player participated in.
  //    We need this set because grouping only on the rows that involve the
  //    player would hide the other participants — but we want them as
  //    co-participants in the group summary.
  const myRows = await baseSelect()
    .where(inArray(missionLog.characterId, myCharIds))
    .orderBy(desc(missionLog.createdAt))
    .limit(500);
  const keys = new Set<string>();
  for (const r of myRows) keys.add(groupKey(r as MissionRow));
  if (keys.size === 0) {
    res.json([]);
    return;
  }

  // 2) Re-query all rows for those groups so the summary's participant
  //    count + totalPayout reflect the whole mission, not just the
  //    player's slice.
  const titles = [...new Set(myRows.map((r) => r.title))];
  const fixerIds = [...new Set(myRows.map((r) => r.fixerId).filter((x): x is string => !!x))];
  let allRowsForGroups: MissionRow[];
  if (fixerIds.length > 0) {
    allRowsForGroups = (await baseSelect()
      .where(and(inArray(missionLog.title, titles), inArray(missionLog.fixerId, fixerIds)))
      .orderBy(desc(missionLog.createdAt))) as MissionRow[];
  } else {
    allRowsForGroups = (await baseSelect()
      .where(inArray(missionLog.title, titles))
      .orderBy(desc(missionLog.createdAt))) as MissionRow[];
  }
  // Filter down to only the exact groups the player belongs to (the
  // title+fixerId join above can over-fetch if a fixer reused a title for
  // a different mission on a different day).
  const filtered = allRowsForGroups.filter((r) => keys.has(groupKey(r)));

  res.json(groupRows(filtered, new Set(myCharIds)));
});

// Fixer/admin view: every mission, with group summaries.
router.get("/missions/all", requireAuth, async (req, res): Promise<void> => {
  const me = req.user!;
  if (!hasRole(me.roles, "FIXER") && !hasRole(me.roles, "ADMIN")) {
    res.status(403).json({ error: "Fixer or admin role required" });
    return;
  }
  const limit = Math.min(2000, parseInt(String(req.query.limit ?? "1000"), 10) || 1000);
  const rows = (await baseSelect()
    .orderBy(desc(missionLog.createdAt))
    .limit(limit)) as MissionRow[];
  res.json(groupRows(rows, null));
});

// Mission group detail: all participants + fixer + every entry.
router.get("/missions/:id", requireAuth, async (req, res): Promise<void> => {
  const key = decodeGroupId(String(req.params.id));
  if (!key) {
    res.status(400).json({ error: "Invalid mission id" });
    return;
  }
  const [rawFixerId, ...titleAndDay] = key.split("|");
  // Title may itself contain "|" — reassemble all but the last segment as
  // the title; the last segment is always the YYYY-MM-DD day key.
  const day = titleAndDay[titleAndDay.length - 1];
  const title = titleAndDay.slice(0, -1).join("|");
  if (!title || !day) {
    res.status(400).json({ error: "Invalid mission id" });
    return;
  }
  const fixerId = rawFixerId === "_" ? null : rawFixerId;

  // Fetch every row for (title, fixerId) and then filter by the day so we
  // don't have to teach SQL the UTC date-truncation rule.
  const candidates = (await baseSelect().where(
    fixerId
      ? and(eq(missionLog.title, title), eq(missionLog.fixerId, fixerId))
      : eq(missionLog.title, title),
  )) as MissionRow[];
  const rows = candidates.filter(
    (r) => dayKey(r.occurredAt, r.createdAt) === day && (fixerId == null || r.fixerId === fixerId),
  );
  if (rows.length === 0) {
    res.status(404).json({ error: "Mission not found" });
    return;
  }

  // Authorization: this is a mission *log* (already happened), so we
  // disclose to:
  //   - The fixer who ran it
  //   - Any character owner who participated
  //   - Admins
  // Other authenticated players don't get to read someone else's mission.
  const me = req.user!;
  const isStaff = hasRole(me.roles, "ADMIN") || hasRole(me.roles, "FIXER");
  let isParticipantOwner = false;
  if (!isStaff && rows.some((r) => r.characterId != null)) {
    const charIds = rows.map((r) => r.characterId).filter((x): x is number => x != null);
    const owners = await db
      .select({ ownerId: characters.ownerId })
      .from(characters)
      .where(inArray(characters.id, charIds));
    isParticipantOwner = owners.some((o) => o.ownerId === me.id);
  }
  const isFixerOnThisMission = fixerId === me.id;
  if (!isStaff && !isParticipantOwner && !isFixerOnThisMission) {
    res.status(403).json({ error: "You are not a participant on this mission" });
    return;
  }

  // For any row whose characterId couldn't be resolved, fall back to the
  // Discord username embedded in the legacy-mission tag so the player still
  // appears with a real name instead of "(deleted character)".
  const needFallback = rows
    .filter((r) => r.characterId == null)
    .map((r) => legacyAttendeeId(r.summary))
    .filter((x): x is string => !!x);
  const discordToName = new Map<string, { username: string; avatarUrl: string | null }>();
  if (needFallback.length) {
    const uniq = [...new Set(needFallback)];
    const found = await db
      .select({ discordId: users.discordId, username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(inArray(users.discordId, uniq));
    for (const u of found) discordToName.set(u.discordId, { username: u.username, avatarUrl: u.avatarUrl });
  }

  const head = rows[0];
  res.json({
    id: encodeGroupId(key),
    title: stripLegacyTags(head.title) ?? head.title,
    summary: stripLegacyTags(head.summary),
    status: head.status,
    occurredAt: head.occurredAt ? head.occurredAt.toISOString() : null,
    createdAt: head.createdAt.toISOString(),
    fixerId: head.fixerId,
    fixerName: head.fixerName,
    fixerAvatarUrl: head.fixerAvatarUrl,
    totalPayoutEddies: rows.reduce((a, r) => a + (r.payoutEddies ?? 0), 0),
    participants: rows.map((r) => {
      let charName = r.characterName;
      let portrait = r.characterPortraitUrl;
      if (!charName) {
        const did = legacyAttendeeId(r.summary);
        const fb = did ? discordToName.get(did) : null;
        if (fb) {
          charName = `@${fb.username}`;
          portrait = portrait ?? fb.avatarUrl;
        }
      }
      return {
        entryId: r.id,
        characterId: r.characterId,
        characterName: charName,
        characterPortraitUrl: portrait,
        payoutEddies: r.payoutEddies ?? 0,
        status: r.status,
        summary: stripLegacyTags(r.summary),
      };
    }),
  });
});

export default router;

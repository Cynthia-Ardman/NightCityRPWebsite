import { db, vrchatInstances, vrchatInstanceSessions, vrchatInstanceSamples } from "@workspace/db";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  fetchGroupInstances,
  getGroupRoleMap,
  recordSessionError,
  vrchatCredsConfigured,
  type RawVrchatInstance,
} from "./vrchatClient";

// Normalised access type. Group instances are what the group-instances endpoint
// returns; the more "open" ones (public / plus) read as socials, the more
// locked ones (members / invite+ / friends+) read as missions — see
// matchedEventHint on the client.
export type VrchatAccessType =
  | "group_public"
  | "group_plus"
  | "group_members"
  | "invite_plus"
  | "friends_plus"
  | "invite"
  | "public"
  | "unknown";

interface ParsedLocation {
  worldId: string;
  instanceId: string;
  shortId: string;
  accessType: VrchatAccessType;
  region: string | null;
}

// Parse a VRChat location string, e.g.
//   "wrld_abc:12345~group(grp_x)~groupAccessType(public)~region(us)"
//   "wrld_abc:777~hidden(usr_y)~region(eu)"   (invite+)
//   "wrld_abc:777~friends(usr_y)~region(use)" (friends+)
export function parseLocation(location: string): ParsedLocation {
  const [worldId, rest = ""] = location.split(":");
  const shortId = rest.split("~")[0] ?? rest;
  const has = (token: string) => rest.includes(`~${token}(`);
  const grab = (token: string): string | null => {
    const m = new RegExp(`~${token}\\(([^)]*)\\)`).exec(rest);
    return m ? m[1] : null;
  };

  let accessType: VrchatAccessType = "unknown";
  if (has("group")) {
    const gat = (grab("groupAccessType") ?? "").toLowerCase();
    accessType =
      gat === "public" ? "group_public" : gat === "plus" ? "group_plus" : "group_members";
  } else if (has("hidden")) {
    accessType = "invite_plus";
  } else if (has("friends")) {
    accessType = "friends_plus";
  } else if (has("private")) {
    accessType = "invite";
  } else if (rest && !rest.includes("~")) {
    accessType = "public";
  }

  return { worldId, instanceId: rest, shortId, accessType, region: grab("region") };
}

export function buildLaunchUrl(worldId: string, instanceId: string): string {
  return `https://vrchat.com/home/launch?worldId=${encodeURIComponent(
    worldId,
  )}&instanceId=${encodeURIComponent(instanceId)}`;
}

// Map a list of group role IDs to their display names. IDs that can't be resolved
// (unknown role, or the role map was unavailable this poll) are DROPPED rather
// than echoed back — roleNames is a strictly human-readable field, so we never
// leak opaque grol_… IDs into it. roleIds stays the canonical raw field.
export function resolveRoleNames(roleIds: string[], roleMap: Map<string, string>): string[] {
  return roleIds.map((id) => roleMap.get(id)).filter((n): n is string => !!n);
}

interface NormalisedInstance {
  location: string;
  worldId: string;
  worldName: string;
  thumbnailUrl: string | null;
  instanceShortId: string;
  instanceId: string;
  accessType: VrchatAccessType;
  region: string | null;
  userCount: number;
  capacity: number | null;
  roleIds: string[];
}

function normalise(raw: RawVrchatInstance): NormalisedInstance | null {
  const location = raw.location ?? "";
  if (!location || !location.includes(":")) return null;
  const parsed = parseLocation(location);
  const worldId = raw.world?.id ?? parsed.worldId;
  if (!worldId) return null;
  return {
    location,
    worldId,
    worldName: raw.world?.name ?? "Unknown World",
    thumbnailUrl: raw.world?.thumbnailImageUrl ?? raw.world?.imageUrl ?? null,
    instanceShortId: parsed.shortId,
    instanceId: raw.instanceId ?? parsed.instanceId,
    accessType: parsed.accessType,
    region: raw.region ?? parsed.region,
    userCount: raw.userCount ?? raw.n_users ?? raw.memberCount ?? 0,
    capacity: raw.capacity ?? raw.world?.capacity ?? null,
    roleIds: Array.isArray(raw.roleIds) ? raw.roleIds.filter((r): r is string => !!r) : [],
  };
}

// Refresh the cached set of open NCRP group instances from the VRChat API.
// Upserts each live instance (preserving firstSeenAt so uptime keeps counting)
// and prunes rows for instances that have since closed. Returns the live count.
export async function pollGroupInstances(): Promise<number> {
  if (!vrchatCredsConfigured()) {
    throw new Error("VRChat credentials not configured.");
  }
  let raws: RawVrchatInstance[];
  try {
    raws = await fetchGroupInstances();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordSessionError(msg);
    throw err;
  }

  const now = new Date();
  const live = raws.map(normalise).filter((i): i is NormalisedInstance => i !== null);
  const seen = new Set<string>();

  // Only pay the (cached) cost of resolving role names when at least one live
  // instance actually restricts by role.
  const anyRoles = live.some((i) => i.roleIds.length > 0);
  const roleMap = anyRoles ? await getGroupRoleMap() : new Map<string, string>();

  for (const i of live) {
    if (seen.has(i.location)) continue;
    seen.add(i.location);
    const roleNames = resolveRoleNames(i.roleIds, roleMap);
    await db
      .insert(vrchatInstances)
      .values({
        location: i.location,
        worldId: i.worldId,
        worldName: i.worldName,
        thumbnailUrl: i.thumbnailUrl,
        instanceShortId: i.instanceShortId,
        instanceId: i.instanceId,
        accessType: i.accessType,
        region: i.region,
        userCount: i.userCount,
        capacity: i.capacity,
        roleIds: i.roleIds,
        roleNames,
        firstSeenAt: now,
        lastSeenAt: now,
        raw: i as unknown as Record<string, unknown>,
      })
      // Preserve firstSeenAt (NOT in the update set) so uptime persists while
      // the instance stays open.
      .onConflictDoUpdate({
        target: vrchatInstances.location,
        set: {
          worldId: i.worldId,
          worldName: i.worldName,
          thumbnailUrl: i.thumbnailUrl,
          instanceShortId: i.instanceShortId,
          instanceId: i.instanceId,
          accessType: i.accessType,
          region: i.region,
          userCount: i.userCount,
          capacity: i.capacity,
          roleIds: i.roleIds,
          roleNames,
          lastSeenAt: now,
          raw: i as unknown as Record<string, unknown>,
        },
      });
  }

  // Prune instances that have closed since the last poll.
  const locations = [...seen];
  if (locations.length === 0) {
    await db.delete(vrchatInstances);
  } else {
    await db.delete(vrchatInstances).where(notInArray(vrchatInstances.location, locations));
  }

  // Append to the durable session history (never pruned) so analytics can
  // report instance lifetimes and occupancy long after an instance closes.
  try {
    await recordInstanceSessions(live, now);
  } catch (err) {
    // History is best-effort: a recording failure must never break the live
    // instance browser refresh.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "VRChat instance session recording failed",
    );
  }

  logger.info({ count: seen.size }, "VRChat instances refreshed");
  return seen.size;
}

// Upsert one OPEN session row per live instance (keyed by the partial unique
// index on location WHERE closed_at IS NULL AND source='live'), append a
// head-count sample per poll tick, and close any open sessions whose location
// vanished from this (successful) poll. Exported for tests.
export async function recordInstanceSessions(
  live: Array<Pick<NormalisedInstance, "location" | "worldId" | "worldName" | "accessType" | "region" | "userCount" | "capacity">>,
  now: Date,
): Promise<void> {
  // One transaction per poll tick so a partial failure can't close sessions
  // it never re-upserted (or vice versa), and overlapping polls serialize on
  // the partial unique index instead of interleaving.
  await db.transaction(async (tx) => {
  const seen = new Set<string>();
  for (const i of live) {
    if (seen.has(i.location)) continue;
    seen.add(i.location);
    const [row] = await tx
      .insert(vrchatInstanceSessions)
      .values({
        location: i.location,
        worldId: i.worldId,
        worldName: i.worldName,
        accessType: i.accessType,
        region: i.region,
        source: "live",
        firstSeenAt: now,
        lastSeenAt: now,
        peakUserCount: i.userCount,
        sampleCount: 1,
        sumUserCounts: i.userCount,
        capacity: i.capacity,
      })
      .onConflictDoUpdate({
        target: vrchatInstanceSessions.location,
        targetWhere: sql`closed_at IS NULL AND source = 'live'`,
        set: {
          worldName: i.worldName,
          lastSeenAt: now,
          peakUserCount: sql`GREATEST(${vrchatInstanceSessions.peakUserCount}, ${i.userCount})`,
          sampleCount: sql`${vrchatInstanceSessions.sampleCount} + 1`,
          sumUserCounts: sql`${vrchatInstanceSessions.sumUserCounts} + ${i.userCount}`,
          capacity: i.capacity,
        },
      })
      .returning({ id: vrchatInstanceSessions.id });
    if (row) {
      await tx.insert(vrchatInstanceSamples).values({
        sessionId: row.id,
        at: now,
        userCount: i.userCount,
      });
    }
  }

  // Close open sessions no longer present. closedAt = the last poll that DID
  // see the instance (lastSeenAt), not "now", so durations aren't inflated by
  // the poll interval.
  const openFilter = and(isNull(vrchatInstanceSessions.closedAt), eq(vrchatInstanceSessions.source, "live"));
  const gone =
    seen.size === 0
      ? openFilter
      : and(openFilter, notInArray(vrchatInstanceSessions.location, [...seen]));
  await tx
    .update(vrchatInstanceSessions)
    .set({ closedAt: sql`${vrchatInstanceSessions.lastSeenAt}` })
    .where(gone);
  });
}

export interface VrchatInstanceView {
  location: string;
  worldId: string;
  worldName: string;
  thumbnailUrl: string | null;
  instanceShortId: string;
  accessType: VrchatAccessType;
  region: string | null;
  userCount: number;
  capacity: number | null;
  // Resolved display names of the group roles allowed to join this instance.
  // Empty for open (public/plus) instances or any instance without a role gate.
  roleNames: string[];
  firstSeenAt: string;
  launchUrl: string;
}

export async function getCachedInstances(): Promise<VrchatInstanceView[]> {
  const rows = await db.select().from(vrchatInstances);
  return rows
    .map((r) => ({
      location: r.location,
      worldId: r.worldId,
      worldName: r.worldName,
      thumbnailUrl: r.thumbnailUrl,
      instanceShortId: r.instanceShortId,
      accessType: r.accessType as VrchatAccessType,
      region: r.region,
      userCount: r.userCount,
      capacity: r.capacity,
      roleNames: r.roleNames ?? [],
      firstSeenAt: r.firstSeenAt.toISOString(),
      launchUrl: buildLaunchUrl(r.worldId, r.instanceId),
    }))
    .sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());
}

import { db, vrchatInstances } from "@workspace/db";
import { notInArray } from "drizzle-orm";
import { logger } from "./logger";
import {
  fetchGroupInstances,
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

  for (const i of live) {
    if (seen.has(i.location)) continue;
    seen.add(i.location);
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

  logger.info({ count: seen.size }, "VRChat instances refreshed");
  return seen.size;
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
      firstSeenAt: r.firstSeenAt.toISOString(),
      launchUrl: buildLaunchUrl(r.worldId, r.instanceId),
    }))
    .sort((a, b) => new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime());
}

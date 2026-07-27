import { Router, type IRouter, type Request } from "express";
import { and, desc, eq, gte, ilike, inArray, ne, notInArray, sql } from "drizzle-orm";
import {
  db,
  customRequests,
  characters,
  users,
  inventoryItems,
  housing,
  stores,
  ripperdocs,
  storeStock,
  ripperdocStock,
  storeEmployees,
  ripperdocEmployees,
  walletTransactions,
  characterUpdates,
  activityEvents,
  missionAssignments,
  missionApplications,
  catalogRent,
  characterTagOptions,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { hasRole, sendDirectMessage, postToChannel } from "../lib/discord";
import { announceWithThread } from "../lib/reviewAnnounce";
import { portalLink } from "../lib/portalUrl";
import { createNotification } from "../lib/notifications";
import { reconcileBusinessChannelAccess } from "../lib/businessChannelAccess";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { isListingReserved } from "../lib/listingReservations";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { endOfCurrentMonth } from "../lib/billingDates";
import { isAdmin } from "../lib/roleChecks";
import { mergeTags } from "../lib/characterTags";
import { syncTagRolesForCharacter } from "../lib/tagRoles";
import {
  isReviewer,
  isEligibleReviewer,
  listEligibleReviewers,
  majorityOf,
  countVotes,
  tallyReviewVotes,
  castReviewVote,
  clearReviewVotes,
  loadVotesBySubject,
  loadLastActivityBySubject,
  latestVoterIdFor,
  type ReviewActionResult,
} from "../lib/review";

// Off-catalog "miscellaneous" requests: off-map property, custom guns, and
// custom cyberware. Staff triage these in the unified Pending Requests page;
// approving one auto-applies it (creates a housing lease or an inventory item).
// See lib/db schema `custom_requests` for the data model and idempotency marker.

const REQUEST_TYPES = ["property", "gun", "cyberware", "store", "ripperdoc", "item"] as const;
type RequestType = (typeof REQUEST_TYPES)[number];

// Custom-request types that NEVER appear in the staff triage queue: `stock_cost`
// is owner-approved, `employee_invite` is decided by the invited player, and
// `mission_participation` is decided by the assigned character's player. They
// live only in "My Submissions" / the Inbox. Exported so the reviewer unseen-count / unseen-id
// endpoints (review.ts) can exclude the exact same set — otherwise the dashboard
// "Pending Requests" card and the misc-tab badge count a ticket that the queue
// they link to never renders (a phantom "1 pending request, nothing there").
export const STAFF_QUEUE_EXCLUDED_REQUEST_TYPES = ["stock_cost", "employee_invite", "mission_participation"] as const;

// Custom-request types decided by the PLAYER (not submitted by them): the
// portal renders these on the Inbox page ("waiting on you"), not on My
// Submissions. Exported so /review/my-unseen (review.ts) excludes them from the
// submitter unseen count — the My Submissions page no longer renders these
// rows, so counting them would leave a badge with no row to open and clear.
// stock_cost deliberately stays out of this list: it remains on My Submissions.
export const PLAYER_DECIDED_REQUEST_TYPES = ["employee_invite", "mission_participation"] as const;

const CS_CHANNEL_ID = process.env.CS_APPROVAL_CHANNEL_ID ?? "";

// Post a custom request's summary to the cs-approver channel and start a thread
// from it (the read-only mirror shown on the portal). Best-effort and
// fire-and-forget: a Discord miss must never block request creation, and writes
// are suppressed outside the production deployment. customRequests historically
// did not post to CS — this brings them in line with sheets/edits.
export async function announceRequest(
  requestId: number,
  reqType: string,
  title: string,
  characterName: string,
  submitterName: string,
): Promise<void> {
  if (!CS_CHANNEL_ID) return;
  try {
    // Deep-link straight to this request: the misc-requests queue reads ?focus=
    // and auto-expands + scrolls to the matching card, so the CS-approver post
    // lands the reviewer on the exact ticket (parity with sheets/edits).
    const reviewUrl = portalLink(`/requests?focus=${requestId}`);
    // Only persist discordThreadId when a thread genuinely exists; on a hard
    // failure (null) keep just the message id so a later backfill can thread
    // from it without re-posting.
    await announceWithThread({
      channelId: CS_CHANNEL_ID,
      content: `New ${reqType} request pending review: **${title}** by ${submitterName}`,
      embeds: [
        {
          title,
          fields: [
            { name: "Type", value: reqType, inline: true },
            { name: "Character", value: characterName, inline: true },
            { name: "Player", value: submitterName, inline: true },
            { name: "Review", value: reviewUrl, inline: false },
          ],
        },
      ],
      threadTitle: `Request: ${title}`,
      persist: async ({ msgId, threadId }) => {
        await db
          .update(customRequests)
          .set({ discordMessageId: msgId, ...(threadId ? { discordThreadId: threadId } : {}) })
          .where(eq(customRequests.id, requestId));
      },
    });
  } catch (err) {
    logger.warn({ err, requestId }, "announceRequest failed");
  }
}

// Venue requests (store/ripperdoc) carry name/character plus required
// purpose/location/description and materialize into the stores/ripperdocs
// tables on approval (owned by the requester + chosen character).
function isVenueType(type: string): boolean {
  return type === "store" || type === "ripperdoc";
}

// Player-facing label for a request type, used in Discord DMs and the
// activity feed. Keep in sync with REQUEST_TYPES.
function typeLabelFor(type: string): string {
  switch (type) {
    case "property":
      return "off-map housing";
    case "gun":
      return "custom gun";
    case "cyberware":
      return "custom cyberware";
    case "item":
      return "custom item";
    case "store":
      return "new store";
    case "ripperdoc":
      return "new ripperdoc";
    case "employee_invite":
      return "employment invitation";
    case "venue_stock":
      return "custom stock";
    case "stock_cost":
      return "stock cost";
    case "mission_participation":
      return "mission participation";
    case "character_tag":
      return "character tag";
    default:
      return "request";
  }
}

// stock_cost (venue owner pays) and employee_invite (invited player accepts)
// are decided outside the staff vote pipeline. Returns a 400 error body when a
// staff vote/override/request-changes action targets one of them.
function ownerDecidedError(type: string): { status: number; body: { error: string } } | null {
  if (type === "stock_cost") return { status: 400, body: { error: "Stock-cost requests are decided by the venue owner" } };
  if (type === "employee_invite") return { status: 400, body: { error: "Employment invitations are decided by the invited player" } };
  if (type === "mission_participation") return { status: 400, body: { error: "Participation requests are decided by the assigned character's player" } };
  return null;
}

// Clamp a commission percentage into [0, 100]. Mirrors stores.ts clampPct.
function clampPct(raw: unknown): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Audit category for a request decision — venues are shop, property is
// housing, guns/cyberware are inventory.
function auditCategoryFor(type: string): "housing" | "shop" | "inventory" | "character" {
  if (type === "property") return "housing";
  if (type === "gun" || type === "cyberware" || type === "item") return "inventory";
  if (type === "character_tag") return "character";
  // store / ripperdoc / stock_cost / venue_stock / employee_invite all live
  // under the shop umbrella.
  return "shop";
}

// Maps a lifecycle bucket name to the set of statuses it covers. Active =
// awaiting a decision; Resolved = decided but not yet committed/archived;
// Archive = closed. Unknown bucket falls back to pending.
function bucketStatuses(bucket: string): string[] {
  if (bucket === "active") return ["pending", "changes_requested"];
  if (bucket === "resolved") return ["approved", "rejected", "cancelled"];
  if (bucket === "archive") return ["closed"];
  return ["pending"];
}

function bucketPredicate(bucket: string) {
  return inArray(customRequests.status, bucketStatuses(bucket));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RequestSelectRow = typeof customRequests.$inferSelect;
type CharacterRow = typeof characters.$inferSelect;

// Mechanical parameters a reviewer supplies when approving a request.
// `property` needs monthly rent (+ optional kind); `cyberware` needs CWP.
// Other types need nothing. These are validated up-front when an approve vote
// (or override) is cast and persisted on `details.approval`, so the deciding
// approve can materialize from the stored values without re-prompting.
type ApprovalParams = {
  monthlyRent?: unknown; kind?: unknown; businessName?: unknown; district?: unknown; tier?: unknown;
  cwp?: unknown; slot?: unknown;
  category?: unknown; weaponType?: unknown; fireMode?: unknown; powerLevel?: unknown; manufacturer?: unknown;
  unitCost?: unknown; retail?: unknown; qty?: unknown;
};

// Trim an arbitrary param into a non-empty string, or null when absent/blank.
function reqStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

// Monetary fields here land in Postgres `integer` (int4) columns, which max out
// at 2,147,483,647. Cap well under that so a fat-fingered value is rejected with
// a clear 400 at approve/apply time instead of overflowing into a cryptic 500.
const MAX_MONEY = 2_000_000_000;

// Validates that the params required to APPROVE a given request type are
// present and well-formed. Returns a normalized object on success or an error
// string. Called before recording an approve vote so the tally can never be
// tipped to "approved" without the values needed to materialize.
function normalizeApprovalParams(
  type: string,
  params: ApprovalParams,
  details?: Record<string, unknown> | null,
): { ok: Record<string, number | string> } | { error: string } {
  if (type === "property") {
    const raw = parseInt(String(params.monthlyRent), 10);
    if (!Number.isFinite(raw) || raw < 0) {
      return { error: "monthlyRent (>= 0) required to approve a housing request" };
    }
    // Clamp a too-large value down to the ceiling instead of rejecting it, so a
    // staff typo of an enormous number is silently corrected rather than erroring.
    const monthlyRent = Math.min(raw, MAX_MONEY);
    // Off-map housing is residential-only: business spaces now go through the
    // Off-Map Business (store/ripperdoc) request, which optionally attaches its
    // own business lease. This removes the old "property = home or business?"
    // ambiguity ("Deadlock Defense" confusion).
    const kind = "residential";
    // District + tier are fixer-decided at close (mirroring the properties page)
    // and required so an off-map lease carries the same classification on-map
    // listings do.
    const district = reqStr(params.district);
    if (!district) return { error: "district required to approve a housing request" };
    const tier = reqStr(params.tier);
    if (!tier) return { error: "tier required to approve a housing request" };
    const out: Record<string, number | string> = { monthlyRent, kind, district, tier };
    // Optional: staff may set/replace the leased property name at approval time.
    // When omitted the request title is used as-is.
    if (typeof params.businessName === "string" && params.businessName.trim()) {
      out.businessName = params.businessName.trim();
    }
    return { ok: out };
  }
  if (type === "store" || type === "ripperdoc") {
    // Off-Map Business venues need no mechanical params UNLESS the player asked
    // to attach an off-map property — then the fixer sets the lease's rent /
    // district / tier at close, exactly like a housing request. On-map venues
    // already get their lease from the reserved catalog building, so they never
    // collect these here.
    const det = details ?? {};
    const attach = det.attachProperty === true && det.locationKind !== "on_map";
    if (!attach) return { ok: {} };
    const raw = parseInt(String(params.monthlyRent), 10);
    if (!Number.isFinite(raw) || raw < 0) {
      return { error: "monthlyRent (>= 0) required to attach a property to this business" };
    }
    const monthlyRent = Math.min(raw, MAX_MONEY);
    const district = reqStr(params.district);
    if (!district) return { error: "district required to attach a property to this business" };
    const tier = reqStr(params.tier);
    if (!tier) return { error: "tier required to attach a property to this business" };
    const out: Record<string, number | string> = { monthlyRent, district, tier };
    if (typeof params.businessName === "string" && params.businessName.trim()) {
      out.businessName = params.businessName.trim();
    }
    return { ok: out };
  }
  if (type === "cyberware") {
    const cwp = Number(params.cwp);
    if (!Number.isFinite(cwp) || cwp < 0) {
      return { error: "cwp (>= 0) required to approve a cyberware request" };
    }
    // Slot (the catalog "category") is fixer-decided and required so the chrome
    // lands in the right body-system group and counts toward the 1-per-slot cap.
    const slot = reqStr(params.slot);
    if (!slot) return { error: "slot required to approve a cyberware request" };
    return { ok: { cwp, slot } };
  }
  if (type === "gun") {
    // Mechanical classification is fixer-decided at close, mirroring the gun
    // catalog. All four are required; manufacturer is optional.
    const category = reqStr(params.category);
    if (!category) return { error: "category (Power/Tech/Smart) required to approve a gun request" };
    const weaponType = reqStr(params.weaponType);
    if (!weaponType) return { error: "weaponType required to approve a gun request" };
    const fireMode = reqStr(params.fireMode);
    if (!fireMode) return { error: "fireMode required to approve a gun request" };
    const powerLevel = reqStr(params.powerLevel);
    if (!powerLevel) return { error: "powerLevel (L/M/H) required to approve a gun request" };
    const out: Record<string, number | string> = { category, weaponType, fireMode, powerLevel };
    const manufacturer = reqStr(params.manufacturer);
    if (manufacturer) out.manufacturer = manufacturer;
    return { ok: out };
  }
  if (type === "venue_stock") {
    const rawUnitCost = parseInt(String(params.unitCost), 10);
    const rawRetail = parseInt(String(params.retail), 10);
    const qty = parseInt(String(params.qty), 10);
    if (!Number.isFinite(rawUnitCost) || rawUnitCost < 0) {
      return { error: "unitCost (>= 0) required to approve a stock request" };
    }
    if (!Number.isFinite(rawRetail) || rawRetail < 0) {
      return { error: "retail (>= 0) required to approve a stock request" };
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return { error: "qty (>= 1) required to approve a stock request" };
    }
    // Clamp too-large money values down to the ceiling rather than erroring.
    const unitCost = Math.min(rawUnitCost, MAX_MONEY);
    const retail = Math.min(rawRetail, MAX_MONEY);
    return { ok: { unitCost, retail, qty } };
  }
  return { ok: {} };
}

// Auto-applies an approved request by type (housing lease / inventory item /
// venue) and returns the appliedRef + human summary. Runs inside the caller's
// locked transaction so the materialize + status flip are atomic. Shared by
// the vote-decided-approve path and the admin override path. `params` carries
// the mechanical values (rent/kind/cwp) — for the vote path these come from
// `details.approval`, for override straight from the request body.
async function materializeRequest(
  tx: Tx,
  reqRow: RequestSelectRow,
  c: CharacterRow,
  params: ApprovalParams,
): Promise<{ ok: { appliedRef: string; summary: string } } | { error: { status: number; body: { error: string } } }> {
  if (reqRow.type === "property") {
    const monthlyRent = parseInt(String(params.monthlyRent), 10);
    if (!Number.isFinite(monthlyRent) || monthlyRent < 0) {
      return { error: { status: 400, body: { error: "monthlyRent (>= 0) required to approve a property request" } } };
    }
    if (monthlyRent > MAX_MONEY) {
      return { error: { status: 400, body: { error: `monthlyRent must be ${MAX_MONEY.toLocaleString()} or less — re-approve this request with a valid rent` } } };
    }
    // Off-map housing is residential-only (the old ambiguous business path now
    // lives under the Off-Map Business request).
    const kind = "residential";
    if (!c.approved) {
      return { error: { status: 400, body: { error: "Character is not approved; cannot bill rent" } } };
    }
    // Staff may set/replace the property name on approval; it becomes the
    // lease's displayed address. Falls back to the request title.
    const businessName =
      typeof params.businessName === "string" && params.businessName.trim()
        ? params.businessName.trim()
        : reqRow.title;
    // District + tier are fixer-decided at close and required (off-map leases
    // carry their own copy since there is no catalog listing to join).
    const district = reqStr(params.district);
    if (!district) return { error: { status: 400, body: { error: "district required to approve a property request" } } };
    const tier = reqStr(params.tier);
    if (!tier) return { error: { status: 400, body: { error: "tier required to approve a property request" } } };
    const [lease] = await tx
      .insert(housing)
      .values({
        characterId: reqRow.characterId,
        listingId: null,
        address: businessName,
        district,
        tier,
        monthlyRent,
        paidThrough: endOfCurrentMonth(),
        notes: reqRow.description ?? null,
        kind,
      })
      .returning();
    return { ok: { appliedRef: `housing:${lease.id}`, summary: `Off-map property approved: ${businessName} (${tier} · ${district} · €$${monthlyRent.toLocaleString()}/mo, ${kind})` } };
  }
  if (reqRow.type === "gun") {
    // Mechanical classification (fixer-decided at close, mirroring the gun
    // catalog) is packed into notes with the same " · " convention the staff
    // inventory gun editor uses, so the inventory view renders it identically.
    const category = reqStr(params.category);
    if (!category) return { error: { status: 400, body: { error: "category (Power/Tech/Smart) required to approve a gun request" } } };
    const weaponType = reqStr(params.weaponType);
    if (!weaponType) return { error: { status: 400, body: { error: "weaponType required to approve a gun request" } } };
    const fireMode = reqStr(params.fireMode);
    if (!fireMode) return { error: { status: 400, body: { error: "fireMode required to approve a gun request" } } };
    const powerLevel = reqStr(params.powerLevel);
    if (!powerLevel) return { error: { status: 400, body: { error: "powerLevel (L/M/H) required to approve a gun request" } } };
    const manufacturer = reqStr(params.manufacturer);
    const notes = [
      manufacturer ? `Manufacturer: ${manufacturer}` : null,
      `Category: ${category}`,
      `Type: ${weaponType}`,
      `Fire: ${fireMode}`,
      `Power: ${powerLevel}`,
      reqStr(reqRow.description),
    ]
      .filter(Boolean)
      .join(" · ");
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: reqRow.characterId,
        ownerId: c.ownerId,
        name: reqRow.title,
        category: "gun",
        quantity: 1,
        notes,
      })
      .returning();
    return { ok: { appliedRef: `inventory:${item.instanceUuid}`, summary: `Custom gun approved: ${reqRow.title} (${category} · ${weaponType} · ${powerLevel})` } };
  }
  if (reqRow.type === "item") {
    // Freeform off-catalog item (anything that is not a gun or cyberware).
    // No mechanical params; materializes as a generic "misc" inventory item
    // owned by the requesting character, mirroring the gun flow.
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: reqRow.characterId,
        ownerId: c.ownerId,
        name: reqRow.title,
        category: "misc",
        quantity: 1,
        notes: reqRow.description ?? null,
      })
      .returning();
    return { ok: { appliedRef: `inventory:${item.instanceUuid}`, summary: `Custom item approved: ${reqRow.title}` } };
  }
  if (reqRow.type === "cyberware") {
    const cwp = Number(params.cwp);
    if (!Number.isFinite(cwp) || cwp < 0) {
      return { error: { status: 400, body: { error: "cwp (>= 0) required to approve a cyberware request" } } };
    }
    // Slot (the catalog "category") is fixer-decided and required. Appended as a
    // trailing "· slot: <x>" segment so slotFromNotes / the cyberware tab pick it
    // up and the chrome counts toward the 1-per-slot cap.
    const slot = reqStr(params.slot);
    if (!slot) return { error: { status: 400, body: { error: "slot required to approve a cyberware request" } } };
    const notes = `CWP ${cwp}${reqRow.description ? ` · ${reqRow.description}` : ""} · slot: ${slot}`;
    const [item] = await tx
      .insert(inventoryItems)
      .values({
        characterId: reqRow.characterId,
        ownerId: c.ownerId,
        name: reqRow.title,
        category: "cyberware",
        quantity: 1,
        notes,
      })
      .returning();
    return { ok: { appliedRef: `inventory:${item.instanceUuid}`, summary: `Custom cyberware approved: ${reqRow.title} (CWP ${cwp} · ${slot})` } };
  }
  if (reqRow.type === "store" || reqRow.type === "ripperdoc") {
    if (!c.ownerId) {
      return { error: { status: 400, body: { error: "Character is unclaimed (no owner) — cannot apply" } } };
    }
    const det = (reqRow.details ?? {}) as {
      purpose?: string;
      location?: string;
      locationKind?: "on_map" | "off_map";
      listingId?: number;
      storeKind?: string;
      attachProperty?: boolean;
    };
    // On-map venue: commit a business lease for the reserved building to the
    // venue's owning character, and pin the venue location to the building. The
    // lease is the side effect; appliedRef stays venue:<id> so a close→reopen
    // never double-applies. We lock the listing FOR UPDATE and re-check that no
    // lease exists (the reservation index prevents another live request, but a
    // direct staff lease could have landed in the meantime).
    let venueLocation = det.location ?? null;
    let venueHousingId: number | null = null;
    if (det.locationKind === "on_map") {
      const lid = Number(reqRow.reservedListingId ?? det.listingId);
      if (!Number.isInteger(lid) || lid <= 0) {
        return { error: { status: 400, body: { error: "On-map venue request is missing its building" } } };
      }
      const [listing] = await tx
        .select()
        .from(catalogRent)
        .where(eq(catalogRent.id, lid))
        .for("update");
      if (!listing || listing.kind !== "business") {
        return { error: { status: 400, body: { error: "Reserved building no longer exists" } } };
      }
      if (!listing.leasable) {
        return { error: { status: 400, body: { error: "Reserved building is not available for lease" } } };
      }
      const [existingLease] = await tx
        .select({ id: housing.id })
        .from(housing)
        .where(eq(housing.listingId, lid))
        .limit(1);
      if (existingLease) {
        return { error: { status: 409, body: { error: "Reserved building was leased by someone else" } } };
      }
      const address = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
      const [lease] = await tx
        .insert(housing)
        .values({
          characterId: reqRow.characterId,
          listingId: lid,
          address,
          monthlyRent: listing.monthlyRent,
          paidThrough: endOfCurrentMonth(),
          notes: `Business lease via ${reqRow.type} request "${reqRow.title}"`,
          kind: "business",
        })
        .returning({ id: housing.id });
      venueLocation = address;
      venueHousingId = lease.id;
    } else if (det.attachProperty) {
      // Off-map business that opted into a property: mint an off-map business
      // lease (no catalog building, listingId null) using the rent / district /
      // tier the fixer sets at CLOSE & APPLY — exactly like an off-map housing
      // request, but classified as a business lease and linked to the venue.
      const raw = parseInt(String(params.monthlyRent), 10);
      if (!Number.isFinite(raw) || raw < 0) {
        return { error: { status: 400, body: { error: "monthlyRent (>= 0) required to attach a property to this business" } } };
      }
      if (raw > MAX_MONEY) {
        return { error: { status: 400, body: { error: `monthlyRent must be ${MAX_MONEY.toLocaleString()} or less — re-approve this request with a valid rent` } } };
      }
      const district = reqStr(params.district);
      if (!district) {
        return { error: { status: 400, body: { error: "district required to attach a property to this business" } } };
      }
      const tier = reqStr(params.tier);
      if (!tier) {
        return { error: { status: 400, body: { error: "tier required to attach a property to this business" } } };
      }
      if (!c.approved) {
        return { error: { status: 400, body: { error: "Character is not approved; cannot bill rent" } } };
      }
      const address =
        typeof params.businessName === "string" && params.businessName.trim()
          ? params.businessName.trim()
          : reqRow.title;
      const [lease] = await tx
        .insert(housing)
        .values({
          characterId: reqRow.characterId,
          listingId: null,
          address,
          district,
          tier,
          monthlyRent: raw,
          paidThrough: endOfCurrentMonth(),
          notes: `Off-map business lease via ${reqRow.type} request "${reqRow.title}"`,
          kind: "business",
        })
        .returning({ id: housing.id });
      venueLocation = det.location ?? address;
      venueHousingId = lease.id;
    }
    if (reqRow.type === "store") {
      // Off-Map Business type picker: a Gun Store surfaces under the Guns badge
      // in the directory; everything else stays a general "mixed" store.
      const storeKind = det.storeKind === "guns" ? "guns" : "mixed";
      const [s] = await tx
        .insert(stores)
        .values({
          ownerId: c.ownerId,
          ownerCharacterId: reqRow.characterId,
          name: reqRow.title,
          purpose: det.purpose ?? null,
          location: venueLocation,
          housingId: venueHousingId,
          description: reqRow.description ?? null,
          kind: storeKind,
        })
        .returning();
      return { ok: { appliedRef: `store:${s.id}`, summary: `New store approved: ${reqRow.title}` } };
    }
    const [r] = await tx
      .insert(ripperdocs)
      .values({
        ownerId: c.ownerId,
        ownerCharacterId: reqRow.characterId,
        name: reqRow.title,
        purpose: det.purpose ?? null,
        location: venueLocation,
        housingId: venueHousingId,
        description: reqRow.description ?? null,
      })
      .returning();
    return { ok: { appliedRef: `ripperdoc:${r.id}`, summary: `New ripperdoc approved: ${reqRow.title}` } };
  }
  if (reqRow.type === "character_tag") {
    // Approval-gated tag add (created by PATCH /characters/:id/tags when the
    // tag option has requiresApproval). Applying = adding the tag to the
    // character's manualTags. The Discord role grant (if the option is
    // role-linked) happens post-commit in afterApprove — external writes must
    // never run inside the tx.
    const det = (reqRow.details ?? {}) as { tag?: string };
    const tagName = typeof det.tag === "string" ? det.tag.trim() : "";
    if (!tagName) {
      return { error: { status: 400, body: { error: "Tag request is missing its tag" } } };
    }
    // Re-resolve against the registry at close — the option may have been
    // renamed or removed since the request was submitted.
    const [opt] = await tx
      .select({ name: characterTagOptions.name })
      .from(characterTagOptions)
      .where(ilike(characterTagOptions.name, tagName));
    if (!opt) {
      return { error: { status: 400, body: { error: `Tag "${tagName}" is no longer in the tag registry` } } };
    }
    const [fresh] = await tx
      .select({ appliedTags: characters.appliedTags, manualTags: characters.manualTags })
      .from(characters)
      .where(eq(characters.id, reqRow.characterId))
      .for("update");
    if (!fresh) {
      return { error: { status: 400, body: { error: "Character no longer exists" } } };
    }
    const current = mergeTags(fresh.appliedTags, fresh.manualTags);
    if (!current.some((t) => t.toLowerCase() === opt.name.toLowerCase())) {
      await tx
        .update(characters)
        .set({ manualTags: [...(fresh.manualTags ?? []), opt.name] })
        .where(eq(characters.id, reqRow.characterId));
    }
    return {
      ok: {
        appliedRef: `character_tag:${reqRow.characterId}:${opt.name.toLowerCase()}`,
        summary: `Tag approved: ${opt.name}`,
      },
    };
  }
  if (reqRow.type === "venue_stock") {
    // Fixers have voted to approve and set the cost/qty/retail. We don't add
    // the stock or debit the venue here — instead we hand off to the existing
    // stock_cost flow: insert a pending stock_cost request the venue owner must
    // approve from "My Submissions" (which debits + stocks via /stock-decision).
    const det = (reqRow.details ?? {}) as {
      kind?: "store" | "ripperdoc";
      venueId?: number;
      venueName?: string;
      category?: string | null;
    };
    const kind = det.kind === "ripperdoc" ? "ripperdoc" : "store";
    const venueId = Number(det.venueId);
    if (!Number.isFinite(venueId) || venueId <= 0) {
      return { error: { status: 400, body: { error: "Stock request is missing its venue" } } };
    }
    // Hard-validate the closer-supplied mechanical params (no permissive
    // defaults): a CLOSE & APPLY with missing/invalid numbers must 400, matching
    // the property/cyberware branches and normalizeApprovalParams.
    const rawUnitCost = parseInt(String(params.unitCost), 10);
    const rawRetail = parseInt(String(params.retail), 10);
    const rawQty = parseInt(String(params.qty), 10);
    if (!Number.isFinite(rawUnitCost) || rawUnitCost < 0) {
      return { error: { status: 400, body: { error: "unitCost (>= 0) required to approve a stock request" } } };
    }
    if (!Number.isFinite(rawRetail) || rawRetail < 0) {
      return { error: { status: 400, body: { error: "retail (>= 0) required to approve a stock request" } } };
    }
    if (!Number.isFinite(rawQty) || rawQty < 1) {
      return { error: { status: 400, body: { error: "qty (>= 1) required to approve a stock request" } } };
    }
    const unitCost = Math.min(rawUnitCost, MAX_MONEY);
    const retail = Math.min(rawRetail, MAX_MONEY);
    const qty = rawQty;
    const totalCost = unitCost * qty;
    const [stockReq] = await tx
      .insert(customRequests)
      .values({
        type: "stock_cost",
        characterId: reqRow.characterId,
        requestedById: reqRow.requestedById,
        title: reqRow.title,
        description: reqRow.description ?? null,
        details: {
          kind,
          venueId,
          venueName: det.venueName,
          name: reqRow.title,
          category: det.category ?? null,
          qty,
          unitCost,
          totalCost,
          retail,
        } as never,
      })
      .returning();
    return {
      ok: {
        appliedRef: `custom_request:${stockReq.id}`,
        summary: `Custom stock approved by fixers: ${reqRow.title} x${qty} @ €$${unitCost.toLocaleString()}/unit — awaiting your payment in My Submissions.`,
      },
    };
  }
  return { error: { status: 400, body: { error: `Unknown request type ${reqRow.type}` } } };
}

// Side-effects run AFTER an approve commits (character update note, activity
// feed, inventory ledger, audit, player DM). Shared by vote-decided-approve
// and override so both leave an identical trail. Best-effort beyond the audit.
async function afterApprove(
  req: Parameters<typeof recordAudit>[0]["req"] & { user: NonNullable<unknown> },
  reqRow: RequestSelectRow,
  c: CharacterRow,
  appliedRef: string,
  summary: string,
  via: "vote" | "override",
): Promise<void> {
  const u = (req as { user: { id: string; username: string; avatarUrl: string | null } }).user;
  await db.insert(characterUpdates).values({ characterId: reqRow.characterId, authorId: u.id, note: summary });
  await db.insert(activityEvents).values({
    kind: "request_approved",
    actorId: u.id,
    actorName: u.username,
    actorAvatarUrl: u.avatarUrl,
    message: `${c.name}: ${summary}${via === "override" ? " (admin override)" : ""}`,
  });
  if (reqRow.type === "character_tag") {
    // Grant the mapped Discord role (if any) now that the tag add committed.
    // Fire-and-forget: a Discord miss never blocks the approval trail.
    const tag = String((reqRow.details as { tag?: string } | null)?.tag ?? "").trim();
    if (tag) void syncTagRolesForCharacter(reqRow.characterId, [tag], [], `tag request #${reqRow.id} approved`);
  }
  if (reqRow.type === "gun" || reqRow.type === "cyberware" || reqRow.type === "item") {
    await recordInventoryEvent({
      instanceUuid: appliedRef.replace("inventory:", ""),
      kind: "created",
      actorId: u.id,
      actorName: u.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: reqRow.title,
      quantity: 1,
      reason: `Approved ${reqRow.type} request`,
    });
  }
  await recordAudit({
    req,
    category: auditCategoryFor(reqRow.type),
    action: via === "override" ? "request_override_approve" : "request_vote_approve",
    targetType: "custom_request",
    targetId: reqRow.id,
    message: summary,
    after: { type: reqRow.type, characterId: reqRow.characterId, appliedRef, via },
  });
  // Mirror the decision onto the affected character's own audit trail so a
  // fixer reading a character's history sees the applied request (lease, venue,
  // chrome, etc.) without cross-referencing the request log. Uses a distinct
  // close/apply action so it reads clearly apart from the request-vote entry.
  await recordAudit({
    req,
    category: auditCategoryFor(reqRow.type),
    action: "request_applied",
    targetType: "character",
    targetId: reqRow.characterId,
    message: `${c.name}: ${summary}${via === "override" ? " (admin override)" : ""}`,
    after: { type: reqRow.type, requestId: reqRow.id, appliedRef, via },
  });
}

const router: IRouter = Router();

type RequestRow = {
  id: number;
  type: string;
  characterId: number;
  characterName: string | null;
  requestedById: string;
  requestedByName: string | null;
  title: string;
  description: string | null;
  imageUrl: string | null;
  imageUrls: string[] | null;
  details: unknown;
  status: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  reviewerNote: string | null;
  appliedRef: string | null;
  closedAt: Date | null;
  closedBy: string | null;
  closedOutcome: string | null;
  createdAt: Date;
};

// Max reference images per request — generous but keeps payloads/cards sane.
const MAX_REQUEST_IMAGES = 8;

// Normalize the caller-supplied image inputs into a clean ordered array:
// prefers the multi-image `imageUrls` array, falls back to the legacy single
// `imageUrl` string. Trims entries, drops non-strings/empties, dedupes, caps.
function sanitizeImageUrls(imageUrls: unknown, imageUrl?: unknown): string[] {
  const raw = Array.isArray(imageUrls)
    ? imageUrls
    : typeof imageUrl === "string"
      ? [imageUrl]
      : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= MAX_REQUEST_IMAGES) break;
  }
  return out;
}

function shape(row: RequestRow): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    characterId: row.characterId,
    characterName: row.characterName ?? "(unknown)",
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    title: row.title,
    description: row.description,
    imageUrl: row.imageUrl ?? null,
    // Legacy rows predate the array column and carry only imageUrl, so readers
    // always get a usable array.
    imageUrls: row.imageUrls?.length ? row.imageUrls : row.imageUrl ? [row.imageUrl] : [],
    details: row.details ?? null,
    status: row.status,
    reviewedById: row.reviewedById,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewerNote: row.reviewerNote,
    appliedRef: row.appliedRef,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closedBy: row.closedBy,
    // Legacy closed rows predate closed_outcome; an appliedRef proves the
    // approved effect was committed, so fall back to "approved" there.
    closedOutcome: row.closedOutcome ?? (row.status === "closed" && row.appliedRef ? "approved" : null),
    createdAt: row.createdAt.toISOString(),
  };
}

async function selectWhere(predicate: ReturnType<typeof and> | ReturnType<typeof eq>) {
  return (await db
    .select({
      id: customRequests.id,
      type: customRequests.type,
      characterId: customRequests.characterId,
      characterName: characters.name,
      requestedById: customRequests.requestedById,
      requestedByName: users.username,
      title: customRequests.title,
      description: customRequests.description,
      imageUrl: customRequests.imageUrl,
      imageUrls: customRequests.imageUrls,
      details: customRequests.details,
      status: customRequests.status,
      reviewedById: customRequests.reviewedById,
      reviewedAt: customRequests.reviewedAt,
      reviewerNote: customRequests.reviewerNote,
      appliedRef: customRequests.appliedRef,
      closedAt: customRequests.closedAt,
      closedBy: customRequests.closedBy,
      closedOutcome: customRequests.closedOutcome,
      createdAt: customRequests.createdAt,
    })
    .from(customRequests)
    .innerJoin(characters, eq(characters.id, customRequests.characterId))
    .innerJoin(users, eq(users.id, customRequests.requestedById))
    .where(predicate)
    .orderBy(desc(customRequests.createdAt))) as RequestRow[];
}

// Attach the review tally (approve/reject counts, majority threshold, and the
// viewer's own vote) to a list of request rows in a fixed number of queries —
// one bulk vote load + one reviewer-pool load — instead of N+1. The eligible
// pool excludes each request's own submitter. `stock_cost` rows are
// owner-decided and simply tally to 0/0 here, which the UI ignores.
// `includeRoster` controls whether reviewer identities (the eligible reviewer
// roster + per-voter identity) are exposed. This is reviewer-only info: it must
// stay false for the player-facing /requests/mine endpoint so non-reviewers
// can't enumerate the staff reviewer pool or see who voted.
async function attachTallies(
  rows: RequestRow[],
  viewerId: string,
  includeRoster: boolean,
): Promise<Record<string, unknown>[]> {
  if (rows.length === 0) return [];
  const votesById = await loadVotesBySubject({ subjectType: "request", subjectIds: rows.map((r) => r.id) });
  const activityById = await loadLastActivityBySubject(
    "request",
    rows.map((r) => ({ id: r.id, baseAt: r.createdAt })),
  );
  // Full reviewer roster (id + identity) so the UI can show who hasn't voted.
  const reviewerPool = await listEligibleReviewers(null);
  return rows.map((r) => {
    const eligible = reviewerPool.filter((rv) => rv.id !== r.requestedById);
    const eligibleSet = new Set(eligible.map((rv) => rv.id));
    const votes = (votesById.get(r.id) ?? []).filter((v) => eligibleSet.has(v.voterId));
    const { approveCount, rejectCount, pauseCount } = countVotes(votes);
    const mine = (votesById.get(r.id) ?? []).find((v) => v.voterId === viewerId);
    return {
      ...shape(r),
      lastActivityAt: (activityById.get(r.id) ?? r.createdAt).toISOString(),
      approveCount,
      rejectCount,
      pauseCount,
      threshold: majorityOf(eligible.length),
      myVote: mine?.vote ?? null,
      ...(includeRoster ? { eligibleReviewers: eligible } : {}),
      voters: includeRoster
        ? votes.map((v) => ({
            id: v.voterId,
            name: v.voterName,
            avatarUrl: v.voterAvatarUrl,
            vote: v.vote,
          }))
        : [],
    };
  });
}

// Re-evaluate one still-`pending` request against the LIVE eligible-reviewer
// majority and, if it now resolves, apply the same status transition the vote
// handler makes. This self-heals tickets stranded `pending` after the eligible
// pool shrank (a reviewer's role was revoked or they left) below the
// already-cast tally — the decision is otherwise only ever evaluated at
// vote-cast time, so a shrinking pool never re-triggers it and the ticket
// never surfaces its Close & Apply action. Locked + status-guarded, so it is
// idempotent and races safely with a concurrent real vote or admin override.
// Returns the decided status, or null if it stayed pending. Reviewer-gated by
// the caller (only the staff queue invokes it).
async function finalizeDecidedRequest(
  req: Request,
  rid: number,
): Promise<"approved" | "rejected" | null> {
  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow || reqRow.status !== "pending") return null;
    // Owner-decided types (stock_cost, employee_invite, mission_participation)
    // never tally through the fixer pool — leave them to their own flow.
    if (ownerDecidedError(reqRow.type)) return null;
    const tally = await tallyReviewVotes({ subjectType: "request", subjectId: rid, submitterId: reqRow.requestedById, conn: tx });
    if (!tally.decided) return null;
    // Attribute the decision to the most recent matching voter — the closest
    // thing to a "deciding" reviewer — falling back to the triggering reviewer
    // only if (impossibly) no matching vote exists.
    const deciderId =
      (await latestVoterIdFor({
        subjectType: "request",
        subjectId: rid,
        vote: tally.decided === "approved" ? "approve" : "reject",
        conn: tx,
      })) ?? req.user!.id;
    if (tally.decided === "rejected") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: deciderId, reviewedAt: new Date(), reviewerNote: null })
        .where(eq(customRequests.id, rid));
      return { decided: "rejected" as const, reqRow, tally };
    }
    // Decided approve — STAGE only (mirrors the vote handler): effects are
    // applied when a fixer closes the ticket. Persist the stashed mechanical
    // params onto decisionParams so close can materialize without re-prompting.
    const storedApproval = ((reqRow.details ?? {}) as { approval?: ApprovalParams }).approval ?? null;
    await tx
      .update(customRequests)
      .set({ status: "approved", reviewedById: deciderId, reviewedAt: new Date(), reviewerNote: null, decisionParams: storedApproval as never })
      .where(eq(customRequests.id, rid));
    return { decided: "approved" as const, reqRow, tally };
  });
  if (!txResult) return null;
  const out = txResult;
  if (out.decided === "approved") {
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_auto_finalize_approve",
      targetType: "custom_request",
      targetId: rid,
      message: `Auto-finalized ${out.reqRow.type} request → approved (majority reached after reviewer-pool change; pending close): ${out.reqRow.title}`,
      after: { type: out.reqRow.type, characterId: out.reqRow.characterId, staged: true, autoFinalized: true },
    });
  } else {
    const [row] = await selectWhere(eq(customRequests.id, rid));
    try {
      await db.insert(activityEvents).values({
        kind: "request_rejected",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorAvatarUrl: req.user!.avatarUrl,
        message: `${row.characterName ?? "(unknown)"}: Rejected ${typeLabelFor(out.reqRow.type)} request: ${out.reqRow.title}`,
      });
    } catch (err) {
      logger.warn({ err, requestId: rid }, "auto-finalize reject activity-feed write failed");
    }
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_auto_finalize_reject",
      targetType: "custom_request",
      targetId: rid,
      message: `Auto-finalized ${out.reqRow.type} request → rejected (majority reached after reviewer-pool change): ${out.reqRow.title}`,
      after: { autoFinalized: true },
    });
    // The player is NOT DM'd here — rejection is communicated at close (with an
    // optional staff message), giving staff a window to reconsider first.
  }
  return out.decided;
}

// Walk an attachTallies result and auto-finalize any row whose live tally
// already resolves while it is still `pending`. Cheap in steady state: the
// decided-but-pending case is rare (only the stranded tickets), so this fires
// zero finalize transactions on a healthy queue. Mutates `entries` in place so
// the response reflects the freshly-applied status.
async function finalizeDecidedRequestsInPlace(req: Request, entries: Record<string, unknown>[]): Promise<void> {
  for (const entry of entries) {
    if (entry.status !== "pending") continue;
    const approve = entry.approveCount as number;
    const reject = entry.rejectCount as number;
    const threshold = entry.threshold as number;
    if (approve < threshold && reject < threshold) continue;
    const decided = await finalizeDecidedRequest(req, entry.id as number);
    if (decided) entry.status = decided;
  }
}

// Best-effort Discord DM to the player who submitted a request, telling them
// the staff decision (and the reviewer note on rejection). Resolves the
// requester's Discord id from `users`. Never throws — a delivery miss (DMs
// closed, no bot token, network error) must not affect the already-committed
// approve/reject decision.
async function notifyRequesterOfDecision(
  row: RequestRow,
  summary: string | null,
  approved: boolean,
  closingMessage?: string | null,
): Promise<void> {
  // In-portal bell notification — additive to the Discord DM below, and not
  // conditional on the requester having a resolvable Discord id.
  {
    const typeLabel = typeLabelFor(row.type);
    const who = row.characterName ?? "your character";
    void createNotification({
      userId: row.requestedById,
      type: "request_decision",
      title: `${approved ? "Approved" : "Rejected"}: ${typeLabel} request "${row.title}"`,
      body: approved
        ? [summary, closingMessage].filter(Boolean).join("\n") || `Your ${typeLabel} request for ${who} was approved.`
        : (closingMessage ?? row.reviewerNote ?? `Your ${typeLabel} request for ${who} was rejected.`),
      href: "/submissions",
    });
  }
  try {
    const [u] = await db
      .select({ discordId: users.discordId })
      .from(users)
      .where(eq(users.id, row.requestedById));
    if (!u?.discordId) return;
    const typeLabel = typeLabelFor(row.type);
    const who = row.characterName ?? "your character";
    let content: string;
    // Decision is passed in explicitly: both the approve AND the reject DM now
    // fire from closeRequest AFTER the row's status has been flipped to
    // "closed", so we can't infer approved-vs-rejected from row.status here.
    // `closingMessage` is the staff member's optional note from the close dialog
    // (Tickety-style) — for an approval it is appended after the effect summary;
    // for a rejection it IS the reason (falling back to the deciding vote note).
    if (approved) {
      content = `Your ${typeLabel} request "${row.title}" for ${who} was approved.`;
      if (summary) content += `\n${summary}`;
      if (closingMessage) content += `\n${closingMessage}`;
    } else {
      content = `Your ${typeLabel} request "${row.title}" for ${who} was rejected.`;
      const reason = closingMessage ?? row.reviewerNote;
      if (reason) content += `\nReason: ${reason}`;
    }
    await sendDirectMessage(u.discordId, content);
  } catch (err) {
    logger.warn({ err, requestId: row.id }, "request decision DM failed");
  }
}

// Submit a custom request. Player picks one of their own characters and types
// a free-text title (location / item name) and description.
router.post("/requests", requireAuth, async (req, res): Promise<void> => {
  const { type, characterId, title, description, imageUrl, imageUrls, purpose, location, source, locationKind, listingId, storeKind, attachProperty, asDraft } = req.body ?? {};
  // A draft is the requester's private work-in-progress: it is NOT announced to
  // the cs-approver queue, holds no building reservation, and is invisible to
  // reviewers until the player submits it (POST /requests/:id/submit).
  const isDraft = asDraft === true;
  const reqType = String(type) as RequestType;
  if (!REQUEST_TYPES.includes(reqType)) {
    res.status(400).json({ error: `type must be one of: ${REQUEST_TYPES.join(", ")}` });
    return;
  }
  const cid = parseInt(String(characterId), 10);
  if (!cid || !title || !String(title).trim()) {
    res.status(400).json({ error: "characterId and title required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, cid));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  // Scope to the caller's own characters (admins may submit on behalf).
  if (c.ownerId !== req.user!.id && !isAdmin(req.user!)) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (c.archived) {
    res.status(400).json({ error: "Cannot submit a request for an archived character" });
    return;
  }

  // Venue requests require purpose, location, and description (all stored so
  // the venue can be created verbatim on approval). purpose/location live in
  // the `details` jsonb; the venue name is the title; description reuses the
  // shared column.
  let details: Record<string, unknown> | null = null;
  let descToStore = typeof description === "string" && description.trim() ? description.trim() : null;
  // On-map venue requests reserve a real catalog building; validated below and
  // written to customRequests.reservedListingId so it can't be double-booked.
  let reservedListingId: number | null = null;
  if (isVenueType(reqType)) {
    const p = typeof purpose === "string" ? purpose.trim() : "";
    const d = typeof description === "string" ? description.trim() : "";
    // "on_map" picks a business building from the rent catalog; "off_map" (the
    // default / legacy behaviour) keeps the free-text location.
    const kind = locationKind === "on_map" ? "on_map" : "off_map";
    // Business-type picker (stores only): a Gun Store is tagged so it surfaces
    // under the Guns badge in the directory; anything else is a general store.
    const venueStoreKind = reqType === "store" ? (storeKind === "guns" ? "guns" : "mixed") : undefined;
    // Off-map venues may opt to attach a property — the fixer then sets the
    // off-map business lease's rent/district/tier at CLOSE & APPLY. On-map
    // venues always lease their reserved catalog building, so the flag is moot.
    const wantsProperty = kind === "off_map" && attachProperty === true;
    // Drafts skip the required-field gates (mirrors the sheet draft→submit flow):
    // a player can stash partial work and finish it later. The full check runs at
    // POST /requests/:id/submit before the row ever reaches reviewers.
    if (kind === "on_map") {
      if (!isDraft && (!p || !d)) {
        res.status(400).json({ error: "purpose and description are required" });
        return;
      }
      const lid = Number(listingId);
      if (Number.isInteger(lid) && lid > 0) {
        const [listing] = await db.select().from(catalogRent).where(eq(catalogRent.id, lid));
        if (!listing || listing.kind !== "business" || !listing.leasable) {
          res.status(400).json({ error: "Selected building is not an available business building" });
          return;
        }
        // Reject up-front if the building already has a lease or a live reservation
        // (the partial-unique index is the authoritative race guard below). Drafts
        // hold no reservation, so they skip this — availability is re-checked when
        // the draft is submitted.
        if (!isDraft) {
          const [existingLease] = await db
            .select({ id: housing.id })
            .from(housing)
            .where(eq(housing.listingId, lid))
            .limit(1);
          if (existingLease || (await isListingReserved(lid))) {
            res.status(409).json({ error: "That building is no longer available" });
            return;
          }
        }
        const buildingLabel = listing.district ? `${listing.name} — ${listing.district}` : listing.name;
        details = { purpose: p, locationKind: "on_map", listingId: lid, location: buildingLabel, ...(venueStoreKind ? { storeKind: venueStoreKind } : {}) };
        reservedListingId = lid;
      } else if (!isDraft) {
        res.status(400).json({ error: "listingId is required for an on-map venue" });
        return;
      } else {
        details = { purpose: p, locationKind: "on_map", ...(venueStoreKind ? { storeKind: venueStoreKind } : {}) };
      }
    } else {
      const l = typeof location === "string" ? location.trim() : "";
      if (!isDraft && (!p || !l || !d)) {
        res.status(400).json({ error: "purpose, location, and description are required" });
        return;
      }
      details = {
        purpose: p,
        locationKind: "off_map",
        location: l,
        ...(venueStoreKind ? { storeKind: venueStoreKind } : {}),
        ...(wantsProperty ? { attachProperty: true } : {}),
      };
    }
    descToStore = d || null;
  } else if ((reqType === "gun" || reqType === "cyberware") && typeof source === "string" && source.trim()) {
    // Optional "where do you want this from" source for gun/cyberware requests
    // (a store/ripperdoc name or a free-text "Custom" value). Carried on
    // details.source for fixers reviewing the request.
    details = { source: source.trim() };
  }

  // Reference images: prefer the multi-image array; fall back to the legacy
  // single imageUrl field for old clients. The legacy column stays in sync as
  // the first image so existing single-image consumers keep working.
  const cleanedImages = sanitizeImageUrls(imageUrls, imageUrl);
  const insertValues = {
    type: reqType,
    characterId: cid,
    requestedById: req.user!.id,
    title: String(title).trim(),
    description: descToStore,
    imageUrl: cleanedImages[0] ?? null,
    imageUrls: cleanedImages,
    details: details as never,
    reservedListingId,
    status: isDraft ? "draft" : "pending",
  };
  let inserted: typeof customRequests.$inferSelect | undefined;
  // Drafts never hold a reservation (the partial-unique index only covers
  // pending/approved rows), so they always take the plain insert path; the
  // building is re-validated and reserved when the draft is submitted.
  if (reservedListingId != null && !isDraft) {
    // On-map: lock the building row FOR UPDATE so a concurrent /housing/lease or
    // another on-map submit serializes here — otherwise a lease could land
    // between our pre-check and insert and strand an approved request. Re-check
    // lease + reservation under the lock; the partial-unique index remains the
    // final guard (onConflictDoNothing → no row → 409).
    const rid = reservedListingId;
    await db.transaction(async (tx) => {
      await tx.select({ id: catalogRent.id }).from(catalogRent).where(eq(catalogRent.id, rid)).for("update");
      const [existingLease] = await tx
        .select({ id: housing.id })
        .from(housing)
        .where(eq(housing.listingId, rid))
        .limit(1);
      if (existingLease || (await isListingReserved(rid, tx))) {
        return;
      }
      [inserted] = await tx
        .insert(customRequests)
        .values(insertValues)
        .onConflictDoNothing({
          target: customRequests.reservedListingId,
          where: sql`reserved_listing_id IS NOT NULL AND status IN ('pending', 'approved')`,
        })
        .returning();
    });
  } else {
    [inserted] = await db.insert(customRequests).values(insertValues).returning();
  }
  if (!inserted) {
    res.status(409).json({ error: "That building is no longer available" });
    return;
  }
  const [row] = await selectWhere(eq(customRequests.id, inserted.id));
  // Mirror sheets/edits: announce to cs-approver + open a thread, fire-and-forget.
  // Drafts stay private until the player submits them, so skip the announce.
  if (!isDraft) {
    void announceRequest(inserted.id, reqType, String(title).trim(), c.name, req.user!.username);
  }
  res.status(201).json(shape(row));
});

// A player's own requests (scoped to caller). Optional ?type filter.
router.get("/requests/mine", requireAuth, async (req, res): Promise<void> => {
  const typeFilter = req.query.type ? String(req.query.type) : null;
  const predicate = typeFilter
    ? and(eq(customRequests.requestedById, req.user!.id), eq(customRequests.type, typeFilter))
    : eq(customRequests.requestedById, req.user!.id);
  const rows = await selectWhere(predicate);
  res.json(await attachTallies(rows, req.user!.id, isReviewer(req.user!)));
});

// Staff: list requests across all players. Defaults to pending. Reviewer-gated.
router.get("/requests", requireAuth, async (req, res): Promise<void> => {
  // Gate on the full reviewer pool (FIXER / CS_APPROVER / ADMIN) to match the
  // sheets and pending-edits queues. CS_APPROVERs are eligible requests voters
  // (isEligibleReviewer), so they must be able to see the queue — and to trigger
  // finalize-on-read for tickets stranded after the voter pool shrank.
  if (!isReviewer(req.user!)) {
    res.status(403).json({ error: "Requires reviewer role" });
    return;
  }
  // Lifecycle buckets for the Active / Resolved / Archive sections. A `bucket`
  // query param maps to a set of statuses; the legacy single `status` param is
  // still honored for back-compat (and defaults to pending).
  const bucket = req.query.bucket ? String(req.query.bucket) : null;
  const statusPredicate = bucket
    ? bucketPredicate(bucket)
    : eq(customRequests.status, String(req.query.status ?? "pending"));
  // Exclude the My-Requests-only types (see STAFF_QUEUE_EXCLUDED_REQUEST_TYPES).
  // `venue_stock` IS fixer-voted, so it stays here.
  const rows = await selectWhere(
    and(
      statusPredicate,
      notInArray(customRequests.type, STAFF_QUEUE_EXCLUDED_REQUEST_TYPES as unknown as string[]),
    ),
  );
  const out = await attachTallies(rows, req.user!.id, true);
  // Self-heal any ticket whose tally already passes the (possibly shrunk)
  // majority but was left pending — see finalizeDecidedRequestsInPlace.
  await finalizeDecidedRequestsInPlace(req, out);
  res.json(out);
});


// POST /requests/:id/vote — a reviewer (not the requester) casts an
// approve/reject vote. An approve vote must carry the mechanical params for the
// request type (property: monthlyRent[+kind]; cyberware: cwp); they're stashed
// on details.approval so the deciding approve can materialize from them. When
// the tally reaches majority the request is decided in the same locked txn.
router.post("/requests/:id/vote", requireAuth, async (req, res): Promise<void> => {
  if (!isEligibleReviewer(req.user!)) {
    res.status(403).json({ error: "Only Cs Approvers can vote. Admins use override." });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const body = req.body ?? {};
  // "pause" is a visible marker only — it never counts toward the decision
  // thresholds (see tallyReviewVotes) and never blocks auto-finalize.
  const vote =
    body.vote === "approve" ? "approve" : body.vote === "reject" ? "reject" : body.vote === "pause" ? "pause" : null;
  if (!vote) {
    res.status(400).json({ error: "vote must be 'approve', 'reject' or 'pause'" });
    return;
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;

  // Mechanical params (rent / cwp / stock price) are NO LONGER collected at
  // vote time — voting is a single click for every request type. The values
  // are entered by the closer at the CLOSE & APPLY step (see closeRequest),
  // after the fixers have agreed on them. A param-type approve therefore stages
  // with decisionParams=null; close supplies (and validates) the numbers.
  if (vote === "approve") {
    const [pre] = await db.select({ type: customRequests.type }).from(customRequests).where(eq(customRequests.id, rid));
    if (!pre) { res.status(404).json({ error: "Request not found" }); return; }
    const preBlocked = ownerDecidedError(pre.type);
    if (preBlocked) { res.status(preBlocked.status).json(preBlocked.body); return; }
  }

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { error: blocked };
    // Voting stays open on a still-staged decision (approved | rejected) as well
    // as a pending ticket: under the deferred-effects model the effect isn't
    // committed until close, so until then reviewers may add / remove / flip
    // votes and the status is re-derived from the live tally. This makes "change
    // my mind after it tipped" work without first reopening — and a removed vote
    // can walk a decided ticket back to pending. Only closed / cancelled tickets
    // are locked. (appliedRef is deliberately NOT blocked here: a reopened ticket
    // is pending with appliedRef preserved, and re-voting it is the whole point
    // of reopen; the second close is idempotent because appliedRef short-circuits
    // re-materialization.)
    const voteable = reqRow.status === "pending" || reqRow.status === "approved" || reqRow.status === "rejected";
    if (!voteable) {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    if (reqRow.requestedById === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot vote on a request you submitted" } } };
    }

    await castReviewVote({ subjectType: "request", subjectId: rid, voterId: req.user!.id, vote, note, conn: tx });
    const tally = await tallyReviewVotes({ subjectType: "request", subjectId: rid, submitterId: reqRow.requestedById, conn: tx });

    if (!tally.decided) {
      // The tally no longer reaches a majority (a vote was removed or flipped).
      // If the ticket had already been decided, walk it back to pending and wipe
      // the stale decision metadata — including any prior admin override — so it
      // re-enters the queue cleanly. An already-pending ticket just stays pending.
      if (reqRow.status !== "pending") {
        await tx
          .update(customRequests)
          .set({ status: "pending", reviewedById: null, reviewedAt: null, reviewerNote: null, decisionParams: null, overriddenBy: null })
          .where(eq(customRequests.id, rid));
        return { ok: { decided: null as "approved" | "rejected" | null, reverted: true, reqRow, tally } };
      }
      return { ok: { decided: null as "approved" | "rejected" | null, reverted: false, reqRow, tally } };
    }

    if (tally.decided === "rejected") {
      // A fresh majority now drives the decision: clear any prior staged params /
      // admin override so the ticket is attributed to the vote tally.
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note, decisionParams: null, overriddenBy: null })
        .where(eq(customRequests.id, rid));
      return { ok: { decided: "rejected" as const, reverted: false, reqRow, tally } };
    }

    // Decided approve — STAGE the decision only. Under the deferred-effects
    // lifecycle the effect (lease / inventory / venue) is NOT applied here; it
    // is committed when a fixer closes the ticket. Mechanical params are entered
    // by the closer at CLOSE & APPLY, so decisionParams is normally null here;
    // a legacy details.approval (from before params moved to close) is still
    // honored as a fallback so older staged tickets keep working. Clears any
    // prior override so a vote-reached approval is attributed to the tally.
    const storedApproval = ((reqRow.details ?? {}) as { approval?: ApprovalParams }).approval ?? null;
    await tx
      .update(customRequests)
      .set({ status: "approved", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note, decisionParams: storedApproval as never, overriddenBy: null })
      .where(eq(customRequests.id, rid));
    return { ok: { decided: "approved" as const, reverted: false, reqRow, tally } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const out = txResult.ok;
  if (out.decided === "approved") {
    // Effects are deferred to close — record only the staged-decision audit
    // here. The player DM, character note, inventory ledger and activity feed
    // all fire from afterApprove when the ticket is closed.
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_vote_approve",
      targetType: "custom_request",
      targetId: rid,
      message: `Approved ${out.reqRow.type} request (pending close): ${out.reqRow.title}`,
      after: { type: out.reqRow.type, characterId: out.reqRow.characterId, staged: true },
    });
  } else if (out.decided === "rejected") {
    const [row] = await selectWhere(eq(customRequests.id, rid));
    try {
      await db.insert(activityEvents).values({
        kind: "request_rejected",
        actorId: req.user!.id,
        actorName: req.user!.username,
        actorAvatarUrl: req.user!.avatarUrl,
        message: `${row.characterName ?? "(unknown)"}: Rejected ${typeLabelFor(out.reqRow.type)} request: ${out.reqRow.title}`,
      });
    } catch (err) {
      logger.warn({ err, requestId: rid }, "reject activity-feed write failed");
    }
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_vote_reject",
      targetType: "custom_request",
      targetId: rid,
      message: `Rejected ${out.reqRow.type} request: ${out.reqRow.title}`,
    });
    // No player DM here — the rejection is communicated at close (with an
    // optional staff message), so reaching the reject threshold no longer
    // instantly notifies the player. Staff can change votes / reopen first.
  } else if (out.reverted) {
    // A removed / flipped vote dropped a previously-decided ticket back below
    // majority — record the walk-back for the audit trail.
    await recordAudit({
      req,
      category: auditCategoryFor(out.reqRow.type),
      action: "request_vote_reverted",
      targetType: "custom_request",
      targetId: rid,
      message: `Vote change dropped ${out.reqRow.type} request below majority → back to pending: ${out.reqRow.title}`,
    });
  }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json({ ...shape(row), decided: out.decided, approveCount: out.tally.approveCount, rejectCount: out.tally.rejectCount, pauseCount: out.tally.pauseCount, threshold: out.tally.threshold });
});

// POST /requests/:id/override — admin-only immediate approval, bypassing the
// vote. Carries the mechanical params directly. Records overriddenBy.
router.post("/requests/:id/override", requireAuth, async (req, res): Promise<void> => {
  if (!isAdmin(req.user!)) {
    res.status(403).json({ error: "Only admins can override" });
    return;
  }
  const rid = parseInt(String(req.params.id), 10);
  const body = req.body ?? {};
  const note = typeof body.reviewerNote === "string" && body.reviewerNote.trim() ? body.reviewerNote.trim() : null;
  // Override can approve (default) OR deny, both bypassing the majority vote.
  const deny = body.decision === "deny";

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { error: blocked };
    // Allow overriding a staged decision in either direction (approved OR
    // rejected) so an admin can flip or re-stage it before it is closed/applied
    // — e.g. override-approve a vote-rejected ticket, or override-deny one the
    // votes approved. Block once the effect has been materialized (appliedRef
    // set) or the ticket is terminal (closed / cancelled).
    const editable =
      reqRow.status === "pending" ||
      reqRow.status === "changes_requested" ||
      reqRow.status === "approved" ||
      reqRow.status === "rejected";
    if (!editable || reqRow.appliedRef) {
      return { error: { status: 409, body: { error: `Request already ${reqRow.appliedRef ? "applied" : reqRow.status}` } } };
    }
    if (reqRow.requestedById === req.user!.id) {
      return { error: { status: 403, body: { error: "You cannot override your own request" } } };
    }
    if (deny) {
      // Deny needs no mechanical params; the ticket is rejected and archived on
      // close with no effect to apply.
      await tx
        .update(customRequests)
        .set({
          status: "rejected",
          reviewedById: req.user!.id,
          reviewedAt: new Date(),
          reviewerNote: note,
          decisionParams: null,
          overriddenBy: req.user!.id,
        })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow } };
    }
    // STAGE the approval only — like a single-click vote, override no longer
    // collects mechanical params. The effect is committed when the ticket is
    // closed, where the closer supplies (and validates) rent / cwp / stock
    // price. decisionParams stays null here.
    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNote: note,
        decisionParams: null,
        overriddenBy: req.user!.id,
      })
      .where(eq(customRequests.id, rid));
    return { ok: { reqRow } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  // Effects deferred to close — staged-decision audit only.
  await recordAudit({
    req,
    category: auditCategoryFor(txResult.ok.reqRow.type),
    action: deny ? "request_override_reject" : "request_override_approve",
    targetType: "custom_request",
    targetId: rid,
    message: `${deny ? "Denied" : "Approved"} ${txResult.ok.reqRow.type} request via admin override (pending close): ${txResult.ok.reqRow.title}`,
    after: { type: txResult.ok.reqRow.type, characterId: txResult.ok.reqRow.characterId, staged: true, overriddenBy: req.user!.id, decision: deny ? "deny" : "approve" },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// Close a RESOLVED custom request (approved | rejected | cancelled) → archived.
// Closing an APPROVED ticket commits its effect exactly once (guarded by
// appliedRef); closing a rejected/cancelled ticket just archives it. Idempotent:
// re-closing an already-closed ticket is a 200 no-op. Materialize runs inside the
// locked txn so apply + status flip are atomic; the player DM / character note /
// inventory ledger / activity feed run after commit. The caller (review.ts) has
// already verified the actor is a reviewer.
export async function closeRequest(req: Request, id: number, note?: string, closeParams?: ApprovalParams): Promise<ReviewActionResult> {
  const u = req.user!;
  const result = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, id)).for("update");
    if (!reqRow) return { kind: "error" as const, status: 404, body: { error: "Request not found" } };
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { kind: "error" as const, status: blocked.status, body: blocked.body };
    if (reqRow.status === "closed") return { kind: "noop" as const };
    if (reqRow.status !== "approved" && reqRow.status !== "rejected" && reqRow.status !== "cancelled") {
      return { kind: "error" as const, status: 409, body: { error: `Only a resolved ticket can be closed (this one is ${reqRow.status})` } };
    }
    if (reqRow.status === "approved" && !reqRow.appliedRef) {
      const [c] = await tx.select().from(characters).where(eq(characters.id, reqRow.characterId));
      if (!c || c.archived) return { kind: "error" as const, status: 400, body: { error: "Character is missing or archived" } };
      if (!c.ownerId) return { kind: "error" as const, status: 400, body: { error: "Character is unclaimed (no owner) — cannot apply" } };
      // Mechanical params are entered by the closer at this CLOSE & APPLY step.
      // When supplied they are validated and take precedence; otherwise we fall
      // back to anything staged at vote/override time (legacy tickets). The
      // materializeRequest call below re-validates and 400s if still missing.
      let params = (reqRow.decisionParams ?? ((reqRow.details ?? {}) as { approval?: ApprovalParams }).approval ?? {}) as ApprovalParams;
      if (closeParams && Object.values(closeParams).some((v) => v !== undefined)) {
        const norm = normalizeApprovalParams(reqRow.type, closeParams, reqRow.details as Record<string, unknown> | null);
        if ("error" in norm) return { kind: "error" as const, status: 400, body: { error: norm.error } };
        params = norm.ok as ApprovalParams;
      }
      const mat = await materializeRequest(tx, reqRow, c, params);
      if ("error" in mat) return { kind: "error" as const, status: mat.error.status, body: mat.error.body };
      await tx
        .update(customRequests)
        .set({ status: "closed", closedAt: new Date(), closedBy: u.id, appliedRef: mat.ok.appliedRef, closedOutcome: reqRow.status })
        .where(eq(customRequests.id, id));
      return { kind: "applied" as const, reqRow, c, appliedRef: mat.ok.appliedRef, summary: mat.ok.summary };
    }
    // Rejected / cancelled (or an already-applied approved row): archive only.
    await tx
      .update(customRequests)
      .set({ status: "closed", closedAt: new Date(), closedBy: u.id, closedOutcome: reqRow.status })
      .where(eq(customRequests.id, id));
    return { kind: "archived" as const, reqRow };
  });

  if (result.kind === "error") return { status: result.status, body: result.body };
  if (result.kind === "applied") {
    await afterApprove(req as never, result.reqRow, result.c, result.appliedRef, result.summary, result.reqRow.overriddenBy ? "override" : "vote");
    // A newly-approved business gives its owner access to the business-owners
    // Discord channel. Fire-and-forget; self-heals via the hourly reconcile.
    if (result.appliedRef.startsWith("store:") || result.appliedRef.startsWith("ripperdoc:")) {
      void reconcileBusinessChannelAccess().catch((err) =>
        logger.warn({ err, appliedRef: result.appliedRef }, "business channel access reconcile (approve) failed"),
      );
    }
    const [row] = await selectWhere(eq(customRequests.id, id));
    await notifyRequesterOfDecision(row, result.summary, true, note ?? null);
  } else if (result.kind === "archived") {
    await recordAudit({
      req,
      category: auditCategoryFor(result.reqRow.type),
      action: "request_closed",
      targetType: "custom_request",
      targetId: id,
      message: `Closed ${result.reqRow.type} request (${result.reqRow.status}): ${result.reqRow.title}${note ? ` — note: ${note}` : ""}`,
    });
    // The player is told of a REJECTION here, at close — not the moment the vote
    // tally tipped — so staff can attach an optional closing message and still
    // reconsider (change votes / reopen) before the player ever hears. A
    // player-cancelled ticket (status "cancelled") is the player's own action,
    // so it never DMs them "rejected".
    if (result.reqRow.status === "rejected") {
      const [row] = await selectWhere(eq(customRequests.id, id));
      await notifyRequesterOfDecision(row, null, false, note ?? null);
    }
  }
  const [row] = await selectWhere(eq(customRequests.id, id));
  return { status: 200, body: shape(row) };
}

// Reopen a RESOLVED (approved | rejected) or ARCHIVED (closed) custom request
// back to pending for another review round. Votes are cleared and the decision /
// override / decisionParams / closed fields are wiped so the normal respond /
// approve / deny tools come back.
//
// Idempotency note: `appliedRef` is PRESERVED. It is only ever set when an
// approved ticket was committed (a lease / inventory / venue was created) on
// close. Keeping it means the live effect is not orphaned, and re-closing the
// reopened ticket is a no-op archive (closeRequest only materializes when
// `approved && !appliedRef`), so reopening can never double-apply.
export async function reopenRequest(req: Request, id: number): Promise<ReviewActionResult> {
  const result = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, id)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.status !== "approved" && reqRow.status !== "rejected" && reqRow.status !== "closed") {
      return { error: { status: 409, body: { error: `Only a resolved or archived ticket can be reopened (this one is ${reqRow.status})` } } };
    }
    const det = { ...((reqRow.details ?? {}) as Record<string, unknown>) };
    delete det.approval;
    await tx
      .update(customRequests)
      .set({
        status: "pending",
        reviewedById: null,
        reviewedAt: null,
        reviewerNote: null,
        overriddenBy: null,
        decisionParams: null,
        closedAt: null,
        closedBy: null,
        closedOutcome: null,
        details: det as never,
      })
      .where(eq(customRequests.id, id));
    // Votes are CLEARED on reopen so the ticket returns to a genuinely fresh
    // pending state. Preserving them made reopen a no-op: finalize-on-read would
    // immediately re-tally the carried-over votes and auto-resolve the ticket
    // right back to its prior decision. Reviewers who only want to tweak a
    // decision (add / remove / flip a vote) can now do so directly on the
    // still-staged approved/rejected ticket without reopening at all; reopen is
    // the explicit "start the review over" reset.
    await clearReviewVotes({ subjectType: "request", subjectId: id, conn: tx });
    return { ok: { reqRow } };
  });
  if ("error" in result && result.error) return result.error;
  await recordAudit({
    req,
    category: auditCategoryFor(result.ok.reqRow.type),
    action: "request_reopened",
    targetType: "custom_request",
    targetId: id,
    message: `Reopened ${result.ok.reqRow.type} request: ${result.ok.reqRow.title}`,
  });
  const [row] = await selectWhere(eq(customRequests.id, id));
  return { status: 200, body: shape(row) };
}

// POST /requests/:id/request-changes — RETIRED. Reviewers no longer park
// requests in a blocking `changes_requested` state; the /review comment thread
// is non-blocking communication and never gates approval. Legacy rows already
// in `changes_requested` still resubmit normally. Endpoint kept registered so
// stale clients get a clear 410 rather than a 404.
router.post("/requests/:id/request-changes", requireAuth, async (_req, res): Promise<void> => {
  res.status(410).json({ error: "Request-changes is retired. Use the comment thread; it never blocks approval." });
});

// PATCH /requests/:id — the requester (or admin) edits the request while it is
// still in their hands (pending or changes_requested). Mechanical/owner fields
// only; status is untouched here (resubmit flips it back to the queue).
router.patch("/requests/:id", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can edit this request" });
    return;
  }
  if (reqRow.status !== "pending" && reqRow.status !== "changes_requested" && reqRow.status !== "draft") {
    res.status(409).json({ error: `Request is ${reqRow.status} and can no longer be edited` });
    return;
  }
  const body = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.description === "string") patch.description = body.description.trim() || null;
  // Images: the multi-image array wins when present; a legacy single imageUrl
  // patch (older clients) rewrites the whole set. The legacy column is kept in
  // sync as the first image either way.
  if (Array.isArray(body.imageUrls) || typeof body.imageUrl === "string") {
    const cleaned = sanitizeImageUrls(body.imageUrls, body.imageUrl);
    patch.imageUrls = cleaned;
    patch.imageUrl = cleaned[0] ?? null;
  }
  // Venue purpose/location live in details — merge, never clobber approval.
  if (isVenueType(reqRow.type) && (typeof body.purpose === "string" || typeof body.location === "string")) {
    const det = (reqRow.details ?? {}) as Record<string, unknown>;
    patch.details = {
      ...det,
      ...(typeof body.purpose === "string" ? { purpose: body.purpose.trim() } : {}),
      ...(typeof body.location === "string" ? { location: body.location.trim() } : {}),
    } as never;
  }
  if (Object.keys(patch).length === 0) {
    const [row] = await selectWhere(eq(customRequests.id, rid));
    res.json(shape(row));
    return;
  }
  // When the OWNER edits a request that is STILL pending (live in the fixer
  // queue), it's a material change to what reviewers are voting on, so clear any
  // votes already cast — the next round must judge the edited content. (For
  // changes_requested the votes are cleared by the separate resubmit step
  // instead, so we only reset here when the row hasn't left the queue.)
  // clearReviewVotes is a no-op for owner/player-decided types that never accrue
  // votes.
  //
  // An ADMIN editing someone else's request deliberately KEEPS the existing
  // votes so the request retains its approvals and is pushed straight through
  // without a re-review (staff "edit and push through").
  //
  // The UPDATE is guarded on the SAME status we read above so a concurrent vote
  // that flips the ticket to approved/rejected between the read and the write
  // can't be clobbered (and we don't clear votes on an already-decided row).
  const isOwnerEditing = reqRow.requestedById === req.user!.id;
  if (reqRow.status === "pending") {
    const applied = await db.transaction(async (tx) => {
      const rows = await tx
        .update(customRequests)
        .set(patch)
        .where(and(eq(customRequests.id, rid), eq(customRequests.status, "pending")))
        .returning({ id: customRequests.id });
      if (rows.length === 0) return false;
      if (isOwnerEditing) {
        await clearReviewVotes({ subjectType: "request", subjectId: rid, conn: tx });
      }
      return true;
    });
    if (!applied) {
      res.status(409).json({ error: "This request was just decided by a reviewer — refresh to see the result" });
      return;
    }
  } else {
    // changes_requested OR draft: no votes to clear; guard on the exact status we
    // read so a concurrent submit/resubmit can't be clobbered.
    const rows = await db
      .update(customRequests)
      .set(patch)
      .where(and(eq(customRequests.id, rid), eq(customRequests.status, reqRow.status)))
      .returning({ id: customRequests.id });
    if (rows.length === 0) {
      res.status(409).json({ error: "This request's status changed — refresh and try again" });
      return;
    }
  }
  // Staff edits on someone else's request must leave an audit trail (the owner's
  // own edits are already implicit in the request history).
  if (!isOwnerEditing) {
    await recordAudit({
      req,
      category: auditCategoryFor(reqRow.type),
      action: "request_edit",
      targetType: "custom_request",
      targetId: rid,
      message: `Admin edited ${reqRow.type} request: ${reqRow.title}`,
      after: { ...patch, votesKept: reqRow.status === "pending" },
    });
  }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// POST /requests/:id/resubmit — the requester sends a changes_requested
// request back to the review queue. Votes are cleared so the next round starts
// fresh; resubmitting with no further edits is allowed.
router.post("/requests/:id/resubmit", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can resubmit" });
    return;
  }
  if (reqRow.status !== "changes_requested") {
    res.status(409).json({ error: `Request is ${reqRow.status}, not awaiting changes` });
    return;
  }
  // Atomic: only flip back to pending (and clear votes) if the row is STILL
  // changes_requested. A concurrent admin override could otherwise have already
  // approved + materialized it; flipping it back to pending here would let a
  // later vote materialize it a SECOND time.
  const ok = await db.transaction(async (tx) => {
    const [changed] = await tx
      .update(customRequests)
      .set({ status: "pending", reviewedById: null, reviewedAt: null, reviewerNote: null })
      .where(and(eq(customRequests.id, rid), eq(customRequests.status, "changes_requested")))
      .returning();
    if (!changed) return false;
    await clearReviewVotes({ subjectType: "request", subjectId: rid, conn: tx });
    return true;
  });
  if (!ok) { res.status(409).json({ error: "Request is no longer awaiting changes" }); return; }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// POST /requests/:id/withdraw — the requester pulls their own in-flight request
// out of the review queue. Only pending / changes_requested rows can be
// withdrawn (never approved/rejected/closed — a staged or applied decision must
// go through the staff close/reopen tools). Status-guarded conditional UPDATE
// under a FOR UPDATE lock so it can't race a concurrent approve/override:
// whoever flips the status first wins, the loser 409s. Withdrawn rows land in
// status "cancelled" (already excluded from every reviewer queue / badge count,
// which only look at pending/changes_requested). reviewedAt stays null so the
// player's own action never lights their My Submissions unread badge.
router.post("/requests/:id/withdraw", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(rid) || rid <= 0) { res.status(400).json({ error: "Bad request id" }); return; }
  const result = await db.transaction(async (tx) => {
    const [reqRow] = await tx.select().from(customRequests).where(eq(customRequests.id, rid)).for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    // Strictly owner-only (no admin bypass): withdrawing is the PLAYER backing
    // out. Staff who want a ticket gone use their own reject/close tools so
    // the decision trail correctly attributes who ended it.
    if (reqRow.requestedById !== req.user!.id) {
      return { error: { status: 403, body: { error: "Only the requester can withdraw this request" } } };
    }
    // Player-decided / owner-decided rows have their own decision flows
    // (Inbox / stock-decision); withdrawing them here would strand the decider.
    const blocked = ownerDecidedError(reqRow.type);
    if (blocked) return { error: blocked };
    if (reqRow.status !== "pending" && reqRow.status !== "changes_requested") {
      return { error: { status: 409, body: { error: `Request is ${reqRow.status} — only pending or changes-requested requests can be withdrawn` } } };
    }
    if (reqRow.appliedRef) {
      return { error: { status: 409, body: { error: "Request has already been applied and cannot be withdrawn" } } };
    }
    const [changed] = await tx
      .update(customRequests)
      .set({ status: "cancelled" })
      .where(and(eq(customRequests.id, rid), inArray(customRequests.status, ["pending", "changes_requested"])))
      .returning();
    if (!changed) return { error: { status: 409, body: { error: "Request was decided before it could be withdrawn" } } };
    // Clear any votes already cast so a later staff reopen starts genuinely
    // fresh (mirrors resubmit/reopen semantics).
    await clearReviewVotes({ subjectType: "request", subjectId: rid, conn: tx });
    return { ok: { reqRow: changed } };
  });
  if ("error" in result && result.error) {
    res.status(result.error.status).json(result.error.body);
    return;
  }
  const row = (result as { ok: { reqRow: RequestSelectRow } }).ok.reqRow;
  await recordAudit({
    req,
    category: auditCategoryFor(row.type),
    action: "request_withdrawn",
    targetType: "custom_request",
    targetId: rid,
    message: `Withdrawn by player: ${row.type} request "${row.title}"`,
  });
  // Best-effort note into the cs-approver review thread so reviewers see the
  // ticket left the queue. Fire-and-forget; a Discord miss never blocks.
  if (row.discordThreadId) {
    void postToChannel(row.discordThreadId, `This request was withdrawn by the player and has left the review queue.`).catch((err) =>
      logger.warn({ err, requestId: rid }, "withdraw thread note failed"),
    );
  }
  const [shaped] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(shaped));
});

// POST /requests/:id/submit — the requester promotes their own draft into the
// review queue. Mirrors the sheet draft→submit flow: flips status to pending,
// re-reserves the on-map building (if any) under a FOR UPDATE lock, and fires
// the cs-approver announce.
router.post("/requests/:id/submit", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can submit this request" });
    return;
  }
  if (reqRow.status !== "draft") {
    res.status(409).json({ error: `Request is ${reqRow.status}, not a draft` });
    return;
  }
  // Re-run the content gates the create path skipped for drafts, reading the
  // STORED row so an incomplete draft can never reach reviewers (mirrors the
  // sheet submit re-validation).
  if (!reqRow.title?.trim()) {
    res.status(400).json({ error: "Add a title before submitting" });
    return;
  }
  if (isVenueType(reqRow.type)) {
    const det = (reqRow.details ?? {}) as Record<string, unknown>;
    const p = typeof det.purpose === "string" ? det.purpose.trim() : "";
    const d = reqRow.description?.trim() ?? "";
    if (!p || !d) {
      res.status(400).json({ error: "Add a purpose and description before submitting" });
      return;
    }
    if (det.locationKind === "on_map") {
      if (reqRow.reservedListingId == null) {
        res.status(400).json({ error: "Select a building before submitting" });
        return;
      }
    } else {
      const l = typeof det.location === "string" ? det.location.trim() : "";
      if (!l) {
        res.status(400).json({ error: "Add a location before submitting" });
        return;
      }
    }
  }
  if (reqRow.reservedListingId != null) {
    // On-map venue: re-validate + claim the building under a lock exactly like
    // the create path, so a draft submitted late can't double-book a building
    // that was leased/reserved while it sat in drafts.
    const lid = reqRow.reservedListingId;
    const ok = await db.transaction(async (tx) => {
      const [lk] = await tx
        .select({ id: catalogRent.id, leasable: catalogRent.leasable })
        .from(catalogRent)
        .where(eq(catalogRent.id, lid))
        .for("update");
      if (!lk || !lk.leasable) return false;
      const [existingLease] = await tx
        .select({ id: housing.id })
        .from(housing)
        .where(eq(housing.listingId, lid))
        .limit(1);
      if (existingLease || (await isListingReserved(lid, tx))) return false;
      const [changed] = await tx
        .update(customRequests)
        .set({ status: "pending" })
        .where(and(eq(customRequests.id, rid), eq(customRequests.status, "draft")))
        .returning({ id: customRequests.id });
      return !!changed;
    });
    if (!ok) { res.status(409).json({ error: "That building is no longer available" }); return; }
  } else {
    const [changed] = await db
      .update(customRequests)
      .set({ status: "pending" })
      .where(and(eq(customRequests.id, rid), eq(customRequests.status, "draft")))
      .returning({ id: customRequests.id });
    if (!changed) { res.status(409).json({ error: "Request is no longer a draft" }); return; }
  }
  const [row] = await selectWhere(eq(customRequests.id, rid));
  const [c] = await db.select().from(characters).where(eq(characters.id, reqRow.characterId));
  void announceRequest(rid, reqRow.type, reqRow.title, c?.name ?? "(unknown)", req.user!.username);
  res.json(shape(row));
});

// DELETE /requests/:id — the requester discards their own draft. Only drafts can
// be deleted; submitted requests are cancelled/closed through the review flow.
router.delete("/requests/:id", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const [reqRow] = await db.select().from(customRequests).where(eq(customRequests.id, rid));
  if (!reqRow) { res.status(404).json({ error: "Request not found" }); return; }
  if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
    res.status(403).json({ error: "Only the requester can delete this request" });
    return;
  }
  if (reqRow.status !== "draft") {
    res.status(409).json({ error: "Only draft requests can be deleted" });
    return;
  }
  await db.delete(customRequests).where(and(eq(customRequests.id, rid), eq(customRequests.status, "draft")));
  res.status(204).end();
});

// Venue-owner decision on a fixer/admin-proposed `stock_cost` request. Unlike
// the staff approve/reject above, this is gated to the VENUE OWNER (the
// requestedById) — or an admin acting on their behalf. Approving debits the
// venue balance and adds the stock atomically (FOR UPDATE lock + status guard
// keep it idempotent and crash-safe); rejecting moves nothing.
router.post("/requests/:id/stock-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "approve" && decision !== "reject") {
    res.status(400).json({ error: 'decision must be "approve" or "reject"' });
    return;
  }
  const note =
    typeof req.body?.reviewerNote === "string" && req.body.reviewerNote.trim()
      ? req.body.reviewerNote.trim()
      : null;

  type StockDetails = {
    kind: "store" | "ripperdoc";
    venueId: number;
    venueName?: string;
    catalogId?: number;
    name: string;
    category: string | null;
    qty: number;
    unitCost: number;
    totalCost: number;
    retail: number;
    requestedByFixerId?: string;
    requestedByFixerName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "stock_cost") {
      return { error: { status: 400, body: { error: "Not a stock-cost request" } } };
    }
    const det = (reqRow.details ?? {}) as StockDetails;
    // Authorize against the venue's CURRENT owner, not the stored requestedById:
    // if the venue was reassigned after the request was created, the old owner
    // must no longer be able to approve spending the new owner's balance.
    const ownerVenueTable = det.kind === "store" ? stores : ripperdocs;
    const [ownerVenue] = await tx
      .select({ ownerId: ownerVenueTable.ownerId })
      .from(ownerVenueTable)
      .where(eq(ownerVenueTable.id, det.venueId));
    if (!ownerVenue) {
      return { error: { status: 404, body: { error: "Venue no longer exists" } } };
    }
    // Only the venue's current owner or an admin may decide.
    if (ownerVenue.ownerId !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the venue owner can decide this request" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }

    if (decision === "reject") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date(), reviewerNote: note })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision, newBalance: null as number | null } };
    }

    // Approve: guarded venue debit + stock merge/insert + ledger, all atomic.
    const venueTable = det.kind === "store" ? stores : ripperdocs;
    const stockTable = det.kind === "store" ? storeStock : ripperdocStock;
    const stockVenueCol = det.kind === "store" ? storeStock.storeId : ripperdocStock.ripperdocId;
    const totalCost = Math.max(0, Math.round(Number(det.totalCost) || 0));
    const qty = Math.max(1, Math.round(Number(det.qty) || 1));
    const retail = Math.max(0, Math.round(Number(det.retail) || 0));
    // Shop cost is seeded from the per-unit price the venue just paid (the
    // fixer-approved unitCost) so commission (price − cost) is correct out of the
    // box. On restock of an existing row the established cost is preserved.
    const unitCost = Math.max(0, Math.round(Number(det.unitCost) || 0));

    const [debited] = await tx
      .update(venueTable)
      .set({ balance: sql`${venueTable.balance} - ${totalCost}` })
      .where(and(eq(venueTable.id, det.venueId), gte(venueTable.balance, totalCost)))
      .returning();
    if (!debited) {
      return { error: { status: 400, body: { error: "Venue account has insufficient funds" } } };
    }
    const newBalance = debited.balance;
    const previousBalance = newBalance + totalCost;

    const [existing] = await tx
      .select()
      .from(stockTable)
      .where(and(eq(stockVenueCol, det.venueId), eq(stockTable.name, det.name)));
    let stockId: number;
    if (existing) {
      const [u] = await tx
        .update(stockTable)
        .set({ quantity: existing.quantity + qty, price: retail, category: existing.category ?? det.category })
        .where(eq(stockTable.id, existing.id))
        .returning();
      stockId = u.id;
    } else {
      const [ins] = await tx
        .insert(stockTable)
        .values({
          [det.kind === "store" ? "storeId" : "ripperdocId"]: det.venueId,
          name: det.name,
          category: det.category,
          price: retail,
          quantity: qty,
          cost: unitCost,
        } as never)
        .returning();
      stockId = ins.id;
    }

    await tx.insert(walletTransactions).values({
      storeId: det.kind === "store" ? det.venueId : null,
      ripperdocId: det.kind === "ripperdoc" ? det.venueId : null,
      amount: -totalCost,
      kind: "stock_purchase",
      source: det.kind,
      counterpartyName: "Catalog (fixer-stocked)",
      memo: `Bought ${det.name} x${qty} @ €$${det.unitCost} (approved fixer stocking)`,
      previousBalance,
      newBalance,
    });

    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        reviewerNote: note,
        appliedRef: `${det.kind}-stock:${stockId}`,
      })
      .where(eq(customRequests.id, rid));

    return { ok: { reqRow, det, decision, newBalance } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { det, decision: dec } = txResult.ok;
  // Activity feed + fixer DM, best-effort (decision already committed).
  try {
    await db.insert(activityEvents).values({
      kind: "shop",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "approve"
          ? `${det.venueName ?? "Venue"} approved stocking ${det.name} x${det.qty} (€$${det.totalCost})`
          : `${det.venueName ?? "Venue"} rejected stocking ${det.name} x${det.qty}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "stock-decision activity-feed write failed");
  }
  if (det.requestedByFixerId) {
    try {
      const [fixer] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.requestedByFixerId));
      if (fixer?.discordId) {
        await sendDirectMessage(
          fixer.discordId,
          dec === "approve"
            ? `Your proposal to stock "${det.venueName ?? "the venue"}" with ${det.name} x${det.qty} was approved.`
            : `Your proposal to stock "${det.venueName ?? "the venue"}" with ${det.name} x${det.qty} was rejected.${note ? `\nReason: ${note}` : ""}`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "stock-decision fixer DM failed");
    }
  }
  await recordAudit({
    req,
    category: "shop",
    action: dec === "approve" ? "stock_cost_approve" : "stock_cost_reject",
    targetType: "custom_request",
    targetId: rid,
    message: `${dec === "approve" ? "Approved" : "Rejected"} stocking ${det.name} x${det.qty} for ${det.venueName ?? "venue"}`,
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// The invited character's player (or an admin) accepts or denies an
// `employee_invite`. Gated to the requestedById (the invited player) or admin.
// Accepting inserts the venue employee row (idempotent against a double-accept)
// and marks the request approved; denying marks it rejected. FOR UPDATE +
// pending guard keep concurrent accept/deny crash-safe.
router.post("/requests/:id/employee-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "accept" && decision !== "deny") {
    res.status(400).json({ error: 'decision must be "accept" or "deny"' });
    return;
  }

  type InviteDetails = {
    kind: "store" | "ripperdoc";
    venueId: number;
    venueName?: string;
    role?: string;
    commissionPct?: number;
    invitedById?: string;
    invitedByName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "employee_invite") {
      return { error: { status: 400, body: { error: "Not an employee invitation" } } };
    }
    // Only the invited player (requestedById) or an admin may decide.
    if (reqRow.requestedById !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the invited player can decide this invitation" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Invitation already ${reqRow.status}` } } };
    }
    const det = (reqRow.details ?? {}) as InviteDetails;

    if (decision === "deny") {
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date() })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision, employeeId: null as number | null } };
    }

    // Accept: confirm the venue still exists, then insert the employee row
    // (skip if somehow already employed) and approve the invite.
    const venueTable = det.kind === "store" ? stores : ripperdocs;
    const [venue] = await tx
      .select({ id: venueTable.id })
      .from(venueTable)
      .where(eq(venueTable.id, det.venueId));
    if (!venue) {
      return { error: { status: 404, body: { error: "Venue no longer exists" } } };
    }
    const empTable = det.kind === "store" ? storeEmployees : ripperdocEmployees;
    const empVenueCol = det.kind === "store" ? storeEmployees.storeId : ripperdocEmployees.ripperdocId;
    const [existing] = await tx
      .select({ id: empTable.id })
      .from(empTable)
      .where(and(eq(empVenueCol, det.venueId), eq(empTable.characterId, reqRow.characterId)));
    let employeeId: number;
    if (existing) {
      employeeId = existing.id;
    } else {
      const [emp] = await tx
        .insert(empTable)
        .values({
          [det.kind === "store" ? "storeId" : "ripperdocId"]: det.venueId,
          characterId: reqRow.characterId,
          role: det.role || (det.kind === "store" ? "clerk" : "doc"),
          commissionPct: clampPct(det.commissionPct),
        } as never)
        .returning();
      employeeId = emp.id;
    }
    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        appliedRef: `${det.kind}-employee:${employeeId}`,
      })
      .where(eq(customRequests.id, rid));
    return { ok: { reqRow, det, decision, employeeId } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, det, decision: dec } = txResult.ok;
  const venueName = det.venueName ?? "the venue";
  const [charRow] = await db
    .select({ name: characters.name })
    .from(characters)
    .where(eq(characters.id, reqRow.characterId));
  const charName = charRow?.name ?? "A character";
  // Activity feed + DM the inviting owner, best-effort (decision committed).
  try {
    await db.insert(activityEvents).values({
      kind: dec === "accept" ? "request_approved" : "request_rejected",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "accept"
          ? `${charName} accepted the invitation to work at ${venueName}`
          : `${charName} declined the invitation to work at ${venueName}`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "employee-decision activity-feed write failed");
  }
  if (det.invitedById) {
    try {
      const [owner] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.invitedById));
      if (owner?.discordId) {
        await sendDirectMessage(
          owner.discordId,
          dec === "accept"
            ? `${charName} accepted your invitation to work at ${venueName}.`
            : `${charName} declined your invitation to work at ${venueName}.`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "employee-decision owner DM failed");
    }
  }
  await recordAudit({
    req,
    category: "shop",
    action: dec === "accept" ? "employee_invite_accept" : "employee_invite_deny",
    targetType: "custom_request",
    targetId: rid,
    message:
      dec === "accept"
        ? `${charName} accepted employment at ${venueName}`
        : `${charName} declined employment at ${venueName}`,
    after: { kind: det.kind, venueId: det.venueId, employeeId: txResult.ok.employeeId },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

// The assigned character's player (or an admin) approves or declines a fixer's
// mission assignment. Approving leaves the mission_assignment row in place;
// declining removes the (unpaid) assignment so the player is no longer on the
// roster. Gated to the requestedById (the owning player) or admin. FOR UPDATE +
// pending guard keep concurrent approve/decline crash-safe.
router.post("/requests/:id/participation-decision", requireAuth, async (req, res): Promise<void> => {
  const rid = parseInt(String(req.params.id), 10);
  const decision = String(req.body?.decision ?? "");
  if (decision !== "accept" && decision !== "deny") {
    res.status(400).json({ error: 'decision must be "accept" or "deny"' });
    return;
  }

  type ParticipationDetails = {
    missionId: number;
    missionTitle?: string;
    characterId?: number;
    characterName?: string;
    invitedById?: string;
    invitedByName?: string;
  };

  const txResult = await db.transaction(async (tx) => {
    const [reqRow] = await tx
      .select()
      .from(customRequests)
      .where(eq(customRequests.id, rid))
      .for("update");
    if (!reqRow) return { error: { status: 404, body: { error: "Request not found" } } };
    if (reqRow.type !== "mission_participation") {
      return { error: { status: 400, body: { error: "Not a mission-participation request" } } };
    }
    // Authorize against the character's CURRENT owner (not the snapshotted
    // requestedById), so a post-creation ownership transfer can't let a stale
    // owner decide. Admins may always decide.
    const [charOwner] = await tx
      .select({ ownerId: characters.ownerId })
      .from(characters)
      .where(eq(characters.id, reqRow.characterId));
    if (charOwner?.ownerId !== req.user!.id && !isAdmin(req.user!)) {
      return { error: { status: 403, body: { error: "Only the assigned character's player can decide this request" } } };
    }
    if (reqRow.status !== "pending") {
      return { error: { status: 409, body: { error: `Request already ${reqRow.status}` } } };
    }
    const det = (reqRow.details ?? {}) as ParticipationDetails;

    if (decision === "deny") {
      // Drop the (unpaid) assignment so the player is removed from the roster.
      if (Number.isFinite(Number(det.missionId))) {
        await tx
          .delete(missionAssignments)
          .where(
            and(
              eq(missionAssignments.missionId, Number(det.missionId)),
              eq(missionAssignments.characterId, reqRow.characterId),
              eq(missionAssignments.paymentStatus, "unpaid"),
            ),
          );
      }
      await tx
        .update(customRequests)
        .set({ status: "rejected", reviewedById: req.user!.id, reviewedAt: new Date() })
        .where(eq(customRequests.id, rid));
      return { ok: { reqRow, det, decision } };
    }

    await tx
      .update(customRequests)
      .set({
        status: "approved",
        reviewedById: req.user!.id,
        reviewedAt: new Date(),
        appliedRef: `mission:${det.missionId}`,
      })
      .where(eq(customRequests.id, rid));
    // Keep the player's mission application in sync: when a fixer added the
    // character via the roster editor the application row is left 'pending', so
    // flip it to 'accepted' on confirmation. Without this, "My Applications"
    // shows pending even though the player is on the roster (and may be paid).
    // Only do this when the character is STILL on the roster — a fixer can
    // remove the (unpaid) assignment before the player responds, leaving this
    // request stale; canonicalizing then would falsely mark them accepted with
    // no roster membership (and diverge from the read-time derivation).
    if (Number.isFinite(Number(det.missionId))) {
      const [assignment] = await tx
        .select({ id: missionAssignments.id })
        .from(missionAssignments)
        .where(
          and(
            eq(missionAssignments.missionId, Number(det.missionId)),
            eq(missionAssignments.characterId, reqRow.characterId),
          ),
        );
      if (assignment) {
        await tx
          .update(missionApplications)
          .set({
            status: "accepted",
            reviewedBy: det.invitedById ?? null,
            reviewedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(missionApplications.missionId, Number(det.missionId)),
              eq(missionApplications.characterId, reqRow.characterId),
              eq(missionApplications.status, "pending"),
            ),
          );
      }
    }
    return { ok: { reqRow, det, decision } };
  });

  if (!("ok" in txResult) || !txResult.ok) {
    const err = (txResult as { error: { status: number; body: { error: string } } }).error;
    res.status(err.status).json(err.body);
    return;
  }
  const { reqRow, det, decision: dec } = txResult.ok;
  const missionTitle = det.missionTitle ?? "a mission";
  const [charRow] = await db
    .select({ name: characters.name })
    .from(characters)
    .where(eq(characters.id, reqRow.characterId));
  const charName = charRow?.name ?? det.characterName ?? "A character";
  // Activity feed + DM the assigning fixer, best-effort (decision committed).
  try {
    await db.insert(activityEvents).values({
      kind: dec === "accept" ? "request_approved" : "request_rejected",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorAvatarUrl: req.user!.avatarUrl,
      message:
        dec === "accept"
          ? `${charName} accepted the assignment to "${missionTitle}"`
          : `${charName} declined the assignment to "${missionTitle}"`,
    });
  } catch (err) {
    logger.warn({ err, requestId: rid }, "participation-decision activity-feed write failed");
  }
  if (det.invitedById) {
    try {
      const [fixer] = await db
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.id, det.invitedById));
      if (fixer?.discordId) {
        await sendDirectMessage(
          fixer.discordId,
          dec === "accept"
            ? `${charName} accepted the assignment to "${missionTitle}".`
            : `${charName} declined the assignment to "${missionTitle}".`,
        );
      }
    } catch (err) {
      logger.warn({ err, requestId: rid }, "participation-decision fixer DM failed");
    }
  }
  await recordAudit({
    req,
    category: "mission",
    action: dec === "accept" ? "mission_participation_accept" : "mission_participation_deny",
    targetType: "custom_request",
    targetId: rid,
    message:
      dec === "accept"
        ? `${charName} accepted participation in "${missionTitle}"`
        : `${charName} declined participation in "${missionTitle}"`,
    after: { missionId: det.missionId, characterId: reqRow.characterId },
  });
  const [row] = await selectWhere(eq(customRequests.id, rid));
  res.json(shape(row));
});

export default router;

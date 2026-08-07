import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, desc, or, sql, notInArray, inArray } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  characterUpdates,
  inventoryItems,
  inventoryEvents,
  walletTransactions,
  users,
  activityEvents,
  auditLog,
  lifestyleTiers,
  housing,
  shopOpens,
  botBusinessOpenLog,
  stores,
  ripperdocs,
  ripperdocStock,
  classifyWalletCategory,
  customRequests,
  characterTagOptions,
  type Character,
} from "@workspace/db";
import { gte } from "drizzle-orm";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { getBalance, patchBalance } from "../lib/unbelievaboat";
import { recordSettledWalletMovement } from "../lib/economy";
import { mergeTags, splitDesiredTags, resolveRegistryTags } from "../lib/characterTags";
import { syncTagRolesForCharacter } from "../lib/tagRoles";
import { announceRequest } from "./requests";
import { createPendingEdit } from "./pending-edits";
import { recordInventoryEvent } from "../lib/inventoryEvents";
import { installSlotClashError } from "../lib/cyberwareSlots";
import { isSessionWindowOpen, nextSessionWindowStart, SESSION_WINDOW_HINT } from "../lib/sessionWindow";
import { parseCwp } from "../lib/cyberware";
import { isStaffRoles } from "../lib/roleChecks";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { normalizeName } from "../lib/strings";
import { isStaffUser, loadOwnedChar, loadOwnedOrStaffChar } from "../lib/access";

const router: IRouter = Router();

// Fixed cash paid to a shop owner each time they open shop during a live
// session (mirrors the weekly attendance bonus). Exactly one payout per
// session — enforced by the open-shop endpoint's session guard.
const SHOP_OPEN_PAYOUT = 150;

router.get("/characters", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(characters)
    .where(eq(characters.ownerId, req.user!.id))
    .orderBy(desc(characters.createdAt));
  res.json(rows);
});

router.post("/characters", requireAuth, async (req, res): Promise<void> => {
  const { name: rawName, kind, archetype, background, portraitUrl } = req.body ?? {};
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || !kind) {
    res.status(400).json({ error: "name and kind required" });
    return;
  }
  // Mirror the OpenAPI CharacterInput contract: name 1..64, kind ∈ {pc, npc}.
  // Without this the column (unenforced text) accepts arbitrary kinds that break
  // downstream PC/NPC assumptions (fixer roster, autobill, etc.).
  if (name.length > 64) {
    res.status(400).json({ error: "name must be 64 characters or fewer" });
    return;
  }
  if (kind !== "pc" && kind !== "npc") {
    res.status(400).json({ error: "kind must be 'pc' or 'npc'" });
    return;
  }
  const [c] = await db
    .insert(characters)
    .values({
      ownerId: req.user!.id,
      name,
      kind,
      archetype: archetype ?? null,
      background: background ?? null,
      portraitUrl: portraitUrl ?? null,
    })
    .returning();
  await db.insert(characterStatus).values({ characterId: c.id });
  await db.insert(activityEvents).values({
    kind: "character_created",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} created ${c.name}`,
  });
  await recordAudit({
    req,
    category: "character",
    action: "create",
    targetType: "character",
    targetId: c.id,
    message: `Created character ${c.name}`,
    after: { name: c.name, kind: c.kind, archetype: c.archetype },
  });
  res.status(201).json(c);
});

router.get("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Staff (admin/fixer) may read ANY character's detail — the admin archive
  // page renders the full owner tab panel for moderation. Players stay scoped
  // to their own characters.
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  let lifestyleTier = null;
  if (c.lifestyleTierId != null) {
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, c.lifestyleTierId));
    lifestyleTier = t ?? null;
  }
  // Actual last checkup VISIT date from the audit trail. Under the temporary
  // "checkup reset floor" event, characters.lastCheckupAt is backdated so
  // billing stays capped at week N — showing that date to players reads as
  // "the system lost my checkup". lastCheckupAt stays the billing-effective
  // date; this field is display-only truth about when the doc actually saw
  // them. Falls back to lastCheckupAt for pre-audit/imported checkups.
  const [lastVisit] = await db
    .select({ createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "character"),
        eq(auditLog.targetId, String(id)),
        eq(auditLog.action, "checkup"),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const lastCheckupActualAt = lastVisit?.createdAt ?? c.lastCheckupAt ?? null;
  // `tags` = the merged display list (Discord-applied ∪ manual), same shape the
  // public archive serves — the owner page renders and edits this list.
  res.json({ ...c, lifestyleTier, lastCheckupActualAt, tags: mergeTags(c.appliedTags, c.manualTags) });
});

// PATCH /characters/:id/tags — owner OR staff (fixer/admin) replaces the
// character's FULL desired tag list. Tags apply instantly (no review): they're
// cosmetic archive labels, they don't overlap any field carried in a queued
// pending-edit diff, and the vocabulary is locked to the staff-managed
// tag-option registry, so a player can't invent free-form tags. Tags the
// character already carries stay allowed even if they've since left the
// registry (e.g. Discord-imported ones), so an unrelated edit never fails.
const CharacterTagsSchema = z
  .object({ tags: z.array(z.string().trim().min(1).max(60)).max(30) })
  .strict();

router.patch("/characters/:id/tags", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const parsed = CharacterTagsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid tags", details: parsed.error.issues });
    return;
  }
  const current = mergeTags(c.appliedTags, c.manualTags);
  const resolved = await resolveRegistryTags(parsed.data.tags, current);
  if (resolved.unknown.length > 0) {
    res.status(400).json({ error: `Unknown tag(s): ${resolved.unknown.join(", ")}. Tags must come from the shared tag list.` });
    return;
  }
  // Approval gate: tag options flagged requiresApproval don't apply instantly
  // for players — each NEW such tag is diverted into a pending "character_tag"
  // custom request that fixers approve from the Misc Requests queue (which
  // adds the tag + grants the linked Discord role at close). Staff edits
  // bypass the gate. Tags the character already carries are never diverted —
  // removing/keeping existing tags stays instant.
  const isStaffActor = isStaffRoles(req.user!.roles);
  const currentLower = new Set(current.map((t) => t.toLowerCase()));
  let desiredTags = resolved.tags;
  const queuedForApproval: string[] = [];
  if (!isStaffActor) {
    const addedNames = resolved.tags.filter((t) => !currentLower.has(t.toLowerCase()));
    if (addedNames.length > 0) {
      const gatedOptions = await db
        .select({ name: characterTagOptions.name })
        .from(characterTagOptions)
        .where(eq(characterTagOptions.requiresApproval, true));
      const gatedLower = new Set(gatedOptions.map((o) => o.name.toLowerCase()));
      const gatedAdds = addedNames.filter((t) => gatedLower.has(t.toLowerCase()));
      if (gatedAdds.length > 0) {
        desiredTags = resolved.tags.filter((t) => !gatedAdds.some((g) => g.toLowerCase() === t.toLowerCase()));
        for (const tag of gatedAdds) {
          // Dedupe: at most one live request per character+tag. The read is a
          // fast-path; the partial unique index custom_requests_character_tag_
          // live_idx is the real guard — a concurrent duplicate insert hits it
          // and onConflictDoNothing makes the loser a silent no-op.
          const [existing] = await db
            .select({ id: customRequests.id })
            .from(customRequests)
            .where(
              and(
                eq(customRequests.type, "character_tag"),
                eq(customRequests.characterId, id),
                inArray(customRequests.status, ["pending", "changes_requested"]),
                sql`lower(${customRequests.details} ->> 'tag') = ${tag.toLowerCase()}`,
              ),
            )
            .limit(1);
          if (existing) {
            queuedForApproval.push(tag);
            continue;
          }
          const [inserted] = await db
            .insert(customRequests)
            .values({
              type: "character_tag",
              characterId: id,
              requestedById: req.user!.id,
              title: `Tag: ${tag}`,
              description: `Requesting the "${tag}" tag for ${c.name}.`,
              details: { tag } as never,
            })
            // Untargeted DO NOTHING: drizzle can't type an expression column in
            // `target`, and the only unique index this insert can hit is
            // custom_requests_character_tag_live_idx (reservedListingId is null).
            .onConflictDoNothing()
            .returning({ id: customRequests.id });
          queuedForApproval.push(tag);
          // Conflict (concurrent duplicate) returns no row — the winner's
          // request already announced; nothing to do for the loser.
          if (inserted) {
            void announceRequest(inserted.id, "character_tag", `Tag: ${tag}`, c.name, req.user!.username);
          }
        }
      }
    }
  }
  // Mutation + audit row land together (traceability rule for direct edits).
  // The row is locked and re-read inside the tx so a concurrent importer
  // rewrite of appliedTags can't be clobbered by the pre-tx snapshot.
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd?.toString().split(",")[0] ?? req.ip)) ?? null;
  const ua = req.headers["user-agent"]?.toString().slice(0, 500) ?? null;
  const result = await db.transaction(async (tx) => {
    const [fresh] = await tx
      .select({ appliedTags: characters.appliedTags, manualTags: characters.manualTags })
      .from(characters)
      .where(eq(characters.id, id))
      .for("update");
    if (!fresh) return null;
    const before = mergeTags(fresh.appliedTags, fresh.manualTags);
    const { applied, manual } = splitDesiredTags(desiredTags, fresh.appliedTags);
    const next = mergeTags(applied, manual);
    if (JSON.stringify(before) === JSON.stringify(next)) return { before, next };
    await tx
      .update(characters)
      .set({ appliedTags: applied, manualTags: manual })
      .where(eq(characters.id, id));
    await tx.insert(auditLog).values({
      category: "character",
      action: "tags_edit",
      actorId: req.user!.id,
      actorName: req.user!.username,
      actorIp: ip,
      actorUa: ua,
      targetType: "character",
      targetId: String(id),
      message: `Tags updated for ${c.name}`,
      beforeJson: { tags: before },
      afterJson: { tags: next },
    });
    return { before, next };
  });
  if (result === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Sync role-linked Discord roles for tags that actually changed, AFTER the
  // tag write committed. Fire-and-forget; approval-gated adds are handled at
  // request close, not here.
  const beforeLower = new Set(result.before.map((t) => t.toLowerCase()));
  const nextLower = new Set(result.next.map((t) => t.toLowerCase()));
  const addedApplied = result.next.filter((t) => !beforeLower.has(t.toLowerCase()));
  const removedApplied = result.before.filter((t) => !nextLower.has(t.toLowerCase()));
  if (addedApplied.length > 0 || removedApplied.length > 0) {
    void syncTagRolesForCharacter(id, addedApplied, removedApplied, `tags edited by ${req.user!.username}`);
  }
  res.json({ tags: result.next, queuedForApproval });
});

router.put("/characters/:id/lifestyle", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const raw = (req.body ?? {}).lifestyleTierId;
  let tierId: number | null = null;
  if (raw !== null && raw !== undefined && raw !== "") {
    const parsed = parseInt(String(raw), 10);
    if (!Number.isFinite(parsed)) {
      res.status(400).json({ error: "lifestyleTierId must be an integer or null" });
      return;
    }
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, parsed));
    if (!t) {
      res.status(404).json({ error: "Lifestyle tier not found" });
      return;
    }
    if (t.archived) {
      res.status(400).json({ error: "Lifestyle tier is archived" });
      return;
    }
    tierId = parsed;
  }
  const prevTierId = c.lifestyleTierId ?? null;
  const [u] = await db
    .update(characters)
    .set({ lifestyleTierId: tierId })
    .where(eq(characters.id, id))
    .returning();
  let lifestyleTier = null;
  if (u.lifestyleTierId != null) {
    const [t] = await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, u.lifestyleTierId));
    lifestyleTier = t ?? null;
  }
  if (prevTierId !== tierId) {
    const prevName = prevTierId
      ? (await db.select().from(lifestyleTiers).where(eq(lifestyleTiers.id, prevTierId)))[0]?.name ?? `#${prevTierId}`
      : "none";
    const nextName = lifestyleTier?.name ?? "none";
    await db.insert(characterUpdates).values({
      characterId: id,
      authorId: req.user!.id,
      note: `Lifestyle changed: ${prevName} → ${nextName}`,
    });
  }
  res.json({ ...u, lifestyleTier });
});

const LIFE_STATUSES = ["active", "dead", "missing", "loa", "retired"] as const;

const CharacterUpdateSchema = z
  .object({
    name: z.string().trim().min(1),
    archetype: z.string().nullable(),
    background: z.string().nullable(),
    portraitUrl: z.string().nullable(),
    portraitUrls: z.array(z.string()),
    statsImageUrls: z.array(z.string()),
    // Mirrors the live EditableSchema in pending-edits.ts: sheet-created
    // characters keep discrete story fields + gear/guns/identity at the top
    // level of sheetData, so the inner object must passthrough unknown keys.
    sheetData: z
      .object({
        preamble: z.string(),
        sections: z.record(z.string(), z.string()),
        physicalDescription: z.string().optional(),
        appearance: z.string().optional(),
        psychProfile: z.string().optional(),
        hooks: z.string().optional(),
        skills: z.string().optional(),
        knownAffiliation: z.string().optional(),
      })
      .passthrough(),
    lifeStatus: z.enum(LIFE_STATUSES),
    updateNote: z.string().trim().min(1).max(2000),
  })
  .partial()
  .strict();

// PATCH /characters/:id no longer auto-applies. Edits are queued as
// `pending_character_edits` rows requiring a majority of FIXER /
// CS_APPROVER / ADMIN reviewers (excluding the submitter) to approve
// before they hit the live `characters` row. See pending-edits.ts for
// the review/vote/apply pipeline. Returns 202 with the queued edit id.
router.patch("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Staff (fixers/admins) may edit ANY character's sheet — mirroring the
  // inventory/cyberware "one-stop-shop" loader — not just their own. Without
  // this, an admin editing another player's sheet 404s here, so portrait/stat
  // image changes silently fail (the reported "can't add/remove pictures").
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await createPendingEdit({ character: c, submitter: req.user!, body: req.body });
  if (result.ok && result.autoApplied) {
    await recordAudit({
      req,
      category: "character",
      action: "edit_applied",
      targetType: "character",
      targetId: id,
      message: `Cosmetic edit auto-applied for ${c.name} (no review required)`,
      after: { autoApplied: true },
    });
    res.status(200).json({
      autoApplied: true,
      characterId: id,
      status: "applied",
      character: result.character,
      message: "Your changes were saved.",
    });
    return;
  }
  if (result.ok) {
    await recordAudit({
      req,
      category: "character",
      action: "edit_submitted",
      targetType: "character",
      targetId: id,
      message: `Edit queued for ${c.name} (pending fixer review)`,
      after: { pendingEditId: result.edit.id },
    });
  }
  if (!result.ok) {
    switch (result.error.kind) {
      case "no_changes":
        res.status(400).json({ error: "No changes detected" });
        return;
      case "edit_already_pending":
        res.status(409).json({ error: "A pending edit already exists for this character", pendingEditId: result.error.editId });
        return;
      case "edit_already_decided":
        res.status(409).json({ error: "This review was just decided by a reviewer — refresh to see the result", pendingEditId: result.error.editId });
        return;
      case "forbidden":
        res.status(403).json({ error: result.error.message });
        return;
      case "invalid":
        res.status(400).json({ error: "Invalid update", details: result.error.details });
        return;
    }
  }
  res.status(202).json({
    pendingEditId: result.edit.id,
    characterId: id,
    status: "pending",
    submittedAt: result.edit.submittedAt,
    message: "Your edit was submitted for fixer review.",
  });
});

router.get("/characters/:id/updates", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Owner or staff (admin/fixer) — the admin archive page surfaces the update
  // log alongside the rest of the owner tabs for moderation.
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db
    .select({
      id: characterUpdates.id,
      characterId: characterUpdates.characterId,
      note: characterUpdates.note,
      createdAt: characterUpdates.createdAt,
      authorId: characterUpdates.authorId,
      authorName: users.username,
      authorAvatarUrl: users.avatarUrl,
    })
    .from(characterUpdates)
    .leftJoin(users, eq(users.id, characterUpdates.authorId))
    .where(eq(characterUpdates.characterId, id))
    .orderBy(desc(characterUpdates.createdAt));
  res.json(rows);
});

// Permanent, irreversible deletion. ADMIN / ARCHIVIST / COORDINATOR — players
// archive their own characters via /deactivate instead. All character-scoped
// rows (inventory, wallet, status, updates, housing, shop opens, …) are removed
// automatically by ON DELETE CASCADE foreign keys.
router.delete("/characters/:id", requireAnyRole(["ADMIN", "ARCHIVIST", "COORDINATOR"]), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.delete(characters).where(eq(characters.id, id));
  await recordAudit({
    req,
    category: "character",
    action: "deleted",
    targetType: "character",
    targetId: id,
    message: `${req.user!.username} permanently deleted ${c.name}`,
    before: { id: c.id, name: c.name, ownerId: c.ownerId },
  });
  res.sendStatus(204);
});

router.post("/characters/:id/deactivate", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(characters).set({ archived: true, archivedAt: new Date() }).where(eq(characters.id, id));
  res.json({ success: true, archived: true });
});

router.post("/characters/:id/reactivate", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db.update(characters).set({ archived: false, archivedAt: null }).where(eq(characters.id, id));
  res.json({ success: true, archived: false });
});

// Inventory
router.get("/characters/:id/inventory", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await db.select().from(inventoryItems).where(eq(inventoryItems.characterId, id));
  res.json(rows);
});

router.post("/characters/:id/inventory", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Direct, no-review item creation is staff-only. Players add items by
  // submitting a custom-item request (routed to fixers), which materializes
  // into inventory on approval.
  if (!isStaffUser(req.user!)) {
    res.status(403).json({ error: "Only staff can add inventory items directly. Submit a custom item request instead." });
    return;
  }
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, quantity, notes, equipped, cyberwareReq } = req.body ?? {};
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  if (typeof name === "string" && name.length > 500) {
    res.status(400).json({ error: "name must be 500 characters or fewer" });
    return;
  }
  // Canonicalize the category once so whitespace/case variants ("Cyberware ")
  // can't slip past the cap gate or land an off-canon value in the column.
  const canonCategory =
    typeof category === "string" && normalizeName(category) === "cyberware"
      ? "cyberware"
      : category;
  // Installed-cyberware guards for (player) characters: only one installed
  // copy of any item, one item per capped slot, no installed qty > 1. Applies
  // only when the new row is INSTALLED (carries a "CWP n" note tag) — adding
  // an uninstalled spare to the stash is always allowed. NPCs are exempt.
  if (canonCategory === "cyberware" && c.kind !== "npc" && parseCwp(notes ?? null) != null) {
    const clashErr = await installSlotClashError({
      buyer: { id, kind: c.kind },
      item: { name, notes: notes ?? null },
      qty: Number(quantity) || 1,
    });
    if (clashErr) {
      res.status(409).json({ error: clashErr });
      return;
    }
  }
  const [it] = await db
    .insert(inventoryItems)
    .values({
      characterId: id,
      ownerId: c.ownerId ?? req.user!.id,
      name,
      category: canonCategory ?? null,
      quantity: quantity ?? 1,
      notes: notes ?? null,
      cyberwareReq:
        typeof cyberwareReq === "string" && cyberwareReq.trim() ? cyberwareReq.trim() : null,
      equipped: !!equipped,
    })
    .returning();
  await db.insert(characterUpdates).values({
    characterId: id,
    authorId: req.user!.id,
    note: `Added inventory item: ${name}${quantity && quantity > 1 ? ` ×${quantity}` : ""}${category ? ` [${category}]` : ""}`,
  });
  await recordInventoryEvent({
    instanceUuid: it.instanceUuid,
    kind: "created",
    actorId: req.user!.id,
    actorName: req.user!.username,
    toCharacterId: c.id,
    toCharacterName: c.name,
    itemName: it.name,
    quantity: it.quantity,
    reason: "Player added item to inventory",
  });
  res.status(201).json(it);
});

router.patch("/characters/:cid/inventory/:itemId", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const c = await loadOwnedOrStaffChar(req.user!, cid);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { name, category, quantity, notes, equipped, cyberwareReq } = req.body ?? {};
  if (typeof name === "string" && name.length > 500) {
    res.status(400).json({ error: "name must be 500 characters or fewer" });
    return;
  }
  const [before] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (!before) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  // Players may not self-modify cyberware — installs/removals (the `equipped`
  // toggle), stat/notes/name edits, and recategorizations must all go through a
  // ripperdoc/review. Block any non-staff PATCH that touches a cyberware item OR
  // tries to turn an item INTO cyberware; staff (admin/fixer) retain direct
  // control for corrections.
  const beforeIsCyber = normalizeName(before.category ?? "") === "cyberware";
  const targetIsCyber = typeof category === "string" && normalizeName(category) === "cyberware";
  if ((beforeIsCyber || targetIsCyber) && !isStaffUser(req.user!)) {
    res.status(403).json({ error: "Cyberware changes must go through review. Submit a cyberware request instead." });
    return;
  }
  const [u] = await db
    .update(inventoryItems)
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(cyberwareReq !== undefined
        ? { cyberwareReq: typeof cyberwareReq === "string" && cyberwareReq.trim() ? cyberwareReq.trim() : null }
        : {}),
      ...(equipped !== undefined ? { equipped } : {}),
    })
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)))
    .returning();
  // Log meaningful adjustments: rename, recategorize, requantify, or notes
  // change. Skip equip toggles (too chatty for the audit log).
  const changedFields: string[] = [];
  if (name !== undefined && name !== before.name) changedFields.push("name");
  if (category !== undefined && category !== before.category) changedFields.push("category");
  if (quantity !== undefined && quantity !== before.quantity) changedFields.push("quantity");
  if (notes !== undefined && notes !== before.notes) changedFields.push("notes");
  if (changedFields.length > 0) {
    await recordInventoryEvent({
      instanceUuid: before.instanceUuid,
      kind: "adjusted",
      actorId: req.user!.id,
      actorName: req.user!.username,
      toCharacterId: c.id,
      toCharacterName: c.name,
      itemName: u.name,
      quantity: u.quantity,
      reason: `Owner edited: ${changedFields.join(", ")}`,
      metadata: {
        before: { name: before.name, category: before.category, quantity: before.quantity, notes: before.notes },
        after: { name: u.name, category: u.category, quantity: u.quantity, notes: u.notes },
      },
    });
  }
  const diffs: string[] = [];
  if (name !== undefined && name !== before.name) diffs.push(`name: "${before.name}" → "${name}"`);
  if (quantity !== undefined && quantity !== before.quantity) diffs.push(`qty: ${before.quantity} → ${quantity}`);
  if (equipped !== undefined && equipped !== before.equipped) diffs.push(equipped ? "equipped" : "unequipped");
  if (category !== undefined && category !== before.category) diffs.push(`category: ${before.category ?? "—"} → ${category ?? "—"}`);
  if (notes !== undefined && notes !== before.notes) diffs.push("notes updated");
  {
    const nextReq = typeof cyberwareReq === "string" && cyberwareReq.trim() ? cyberwareReq.trim() : null;
    if (cyberwareReq !== undefined && nextReq !== (before.cyberwareReq ?? null))
      diffs.push(`cyberware req: ${before.cyberwareReq ?? "—"} → ${nextReq ?? "—"}`);
  }
  if (diffs.length) {
    await db.insert(characterUpdates).values({
      characterId: cid,
      authorId: req.user!.id,
      note: `Inventory item "${u.name}": ${diffs.join(", ")}`,
    });
  }
  res.json(u);
});

router.delete("/characters/:cid/inventory/:itemId", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const c = await loadOwnedOrStaffChar(req.user!, cid);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [doomed] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  // Cyberware removals must go through review for players — only staff may delete
  // a cyberware item directly (corrections). Players use the request flow.
  if (
    doomed &&
    normalizeName(doomed.category ?? "") === "cyberware" &&
    !isStaffUser(req.user!)
  ) {
    res.status(403).json({ error: "Cyberware changes must go through review. Submit a cyberware request instead." });
    return;
  }
  await db.delete(inventoryItems).where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (doomed) {
    await db.insert(characterUpdates).values({
      characterId: cid,
      authorId: req.user!.id,
      note: `Removed inventory item: ${doomed.name}${doomed.quantity > 1 ? ` ×${doomed.quantity}` : ""}`,
    });
    await recordInventoryEvent({
      instanceUuid: doomed.instanceUuid,
      kind: "destroyed",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: c.id,
      fromCharacterName: c.name,
      itemName: doomed.name,
      quantity: doomed.quantity,
      reason: "Removed from inventory",
    });
  }
  res.sendStatus(204);
});

// P2P inventory transfer (give or sell to another character).
// For mode=sell, UB authoritative debit of recipient + credit of sender must
// both succeed before the item moves; on credit failure the recipient is
// refunded so UB stays consistent (same compensation pattern as wallet/transfer).
router.post("/characters/:cid/inventory/:itemId/transfer", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const sender = await loadOwnedChar(req.user!.id, cid);
  if (!sender) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (sender.archived) {
    res.status(400).json({ error: "Cannot transfer from an archived character" });
    return;
  }
  const { toCharacterId, mode, quantity, price, memo } = req.body ?? {};
  if (!toCharacterId || (mode !== "give" && mode !== "sell")) {
    res.status(400).json({ error: "toCharacterId and mode (give|sell) required" });
    return;
  }
  if (toCharacterId === cid) {
    res.status(400).json({ error: "Cannot transfer to the same character" });
    return;
  }
  const qty = Math.max(1, Number(quantity) || 1);
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  if (qty > item.quantity) {
    res.status(400).json({ error: "Quantity exceeds available stock" });
    return;
  }
  // Installed chrome can't change bodies by mail. The transfer would carry the
  // "CWP n · Installed at ..." tag with it, so the recipient would instantly
  // count it as INSTALLED cyberware (risk band + weekly meds billing) without
  // any ripperdoc involved. Route these through a ripperdoc remove first —
  // the removed item ("cyberware (removed)") transfers fine.
  if (normalizeName(item.category ?? "") === "cyberware" && parseCwp(item.notes) != null) {
    res.status(400).json({
      error: "This cyberware is currently installed. Have a ripperdoc remove it first — then the removed piece can be given or sold.",
    });
    return;
  }
  const [to] = await db.select().from(characters).where(eq(characters.id, toCharacterId));
  if (!to) {
    res.status(404).json({ error: "Recipient not found" });
    return;
  }
  if (to.archived) {
    res.status(400).json({ error: "Recipient character is archived" });
    return;
  }
  if (!to.ownerId) {
    res.status(409).json({ error: "Recipient character is unclaimed (no owner)" });
    return;
  }
  const [toOwner] = await db.select().from(users).where(eq(users.id, to.ownerId));
  if (!toOwner) {
    res.status(409).json({ error: "Recipient owner account missing" });
    return;
  }

  // Optimistic concurrency: only proceed with the wallet half if the item row
  // hasn't been mutated between the read and now.
  let moneyDebited = false;
  if (mode === "sell") {
    const amount = Number(price);
    if (!amount || amount <= 0) {
      res.status(400).json({ error: "price (positive integer) required for sell" });
      return;
    }
    const buyerBal = await getBalance(toOwner.discordId);
    if (!buyerBal) {
      res.status(502).json({ error: "Wallet provider unavailable" });
      return;
    }
    if (buyerBal.cash < amount) {
      res.status(400).json({ error: "Recipient has insufficient funds" });
      return;
    }
    const debited = await patchBalance(toOwner.discordId, {
      cash: -amount,
      reason: memo ?? `Purchase: ${item.name} x${qty} from ${sender.name}`,
    });
    if (!debited) {
      res.status(502).json({ error: "Wallet provider rejected debit" });
      return;
    }
    moneyDebited = true;
    const credited = await patchBalance(req.user!.discordId, {
      cash: amount,
      reason: memo ?? `Sale: ${item.name} x${qty} to ${to.name}`,
    });
    if (!credited) {
      await patchBalance(toOwner.discordId, {
        cash: amount,
        reason: `Refund: credit to ${sender.name} failed`,
      });
      res.status(502).json({ error: "Wallet provider rejected credit; recipient refunded" });
      return;
    }
    // Record both legs through recordSettledWalletMovement so each owner's
    // website wallet balance advances immediately (instead of drifting until the
    // next reconcile), matching the documented economy invariant.
    await recordSettledWalletMovement({
      userId: req.user!.id,
      amount,
      ubTotalAfter: credited.total,
      source: "website",
      kind: "shop",
      memo: memo ?? `Sold ${item.name} x${qty}`,
      characterId: cid,
      counterpartyCharacterId: to.id,
      counterpartyName: to.name,
    });
    await recordSettledWalletMovement({
      userId: toOwner.id,
      amount: -amount,
      ubTotalAfter: debited.total,
      source: "website",
      kind: "shop",
      memo: memo ?? `Bought ${item.name} x${qty}`,
      characterId: to.id,
      counterpartyCharacterId: cid,
      counterpartyName: sender.name,
    });
  }

  // Move the item. If sender keeps any (partial transfer) decrement and insert
  // a new instance for the recipient (the split creates a new chain); otherwise
  // reassign characterId so the same instanceUuid persists across owners.
  let movedUuid: string = item.instanceUuid;
  let movedName: string = item.name;
  let splitParentUuid: string | null = null;
  try {
    if (qty === item.quantity) {
      // Whole stack moves: reassign characterId + ownerId. Preserve instanceUuid.
      await db
        .update(inventoryItems)
        .set({ characterId: to.id, ownerId: to.ownerId, equipped: false })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
    } else {
      await db
        .update(inventoryItems)
        .set({ quantity: item.quantity - qty })
        .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
      const [inserted] = await db.insert(inventoryItems).values({
        characterId: to.id,
        ownerId: to.ownerId,
        name: item.name,
        category: item.category,
        quantity: qty,
        notes: item.notes,
        equipped: false,
        pricePaid: mode === "sell" ? Number(price) : null,
        acquiredAt: new Date(),
      }).returning();
      splitParentUuid = item.instanceUuid;
      movedUuid = inserted.instanceUuid;
      movedName = inserted.name;
    }
  } catch (err) {
    // If item move fails after a successful sale, we cannot easily un-debit
    // (UB credit/debit are not atomic), so log and surface a 500.
    req.log.error({ err, itemId, cid, toCharacterId }, "inventory transfer DB write failed");
    if (moneyDebited) {
      res.status(500).json({ error: "Item move failed after wallet writes; please contact an admin." });
    } else {
      res.status(500).json({ error: "Item move failed" });
    }
    return;
  }

  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message:
      mode === "sell"
        ? `${sender.name} sold ${item.name} x${qty} to ${to.name} for €$${price}`
        : `${sender.name} gave ${item.name} x${qty} to ${to.name}`,
  });

  // Per-character audit log entries for both sender and recipient so the
  // transfer shows up in each character's UpdatesLog. Sender row is
  // authored by req.user; recipient row is authored by the recipient's
  // owner so it reads "<owner> received ..." in their feed.
  const senderNote =
    mode === "sell"
      ? `Sold ${item.name} x${qty} to ${to.name} for €$${Number(price)}`
      : `Gave ${item.name} x${qty} to ${to.name}`;
  const recipientNote =
    mode === "sell"
      ? `Bought ${item.name} x${qty} from ${sender.name} for €$${Number(price)}`
      : `Received ${item.name} x${qty} from ${sender.name}`;
  await db.insert(characterUpdates).values([
    { characterId: cid, authorId: req.user!.id, note: senderNote },
    { characterId: to.id, authorId: to.ownerId, note: recipientNote },
  ]);

  // Per-instance audit log. For a partial transfer we record two events:
  // a "split" against the source instance and a "created" for the new
  // recipient instance (so its chain begins at the split point). For a
  // whole-stack move there is one event against the persistent uuid.
  if (splitParentUuid) {
    await recordInventoryEvent({
      instanceUuid: splitParentUuid,
      kind: "split",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      itemName: item.name,
      quantity: qty,
      reason: `Split ${qty} of ${item.quantity} for ${mode} to ${to.name}`,
      metadata: { childInstanceUuid: movedUuid, mode, toCharacterId: to.id },
    });
    await recordInventoryEvent({
      instanceUuid: movedUuid,
      kind: mode === "sell" ? "sold" : "transferred",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      toCharacterId: to.id,
      toCharacterName: to.name,
      itemName: movedName,
      quantity: qty,
      price: mode === "sell" ? Number(price) : null,
      reason: memo ?? null,
      metadata: { splitFromInstanceUuid: splitParentUuid, mode },
    });
  } else {
    await recordInventoryEvent({
      instanceUuid: movedUuid,
      kind: mode === "sell" ? "sold" : "transferred",
      actorId: req.user!.id,
      actorName: req.user!.username,
      fromCharacterId: sender.id,
      fromCharacterName: sender.name,
      toCharacterId: to.id,
      toCharacterName: to.name,
      itemName: movedName,
      quantity: qty,
      price: mode === "sell" ? Number(price) : null,
      reason: memo ?? null,
      metadata: { mode },
    });
  }

  const [moved] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.instanceUuid, movedUuid));
  res.json(moved ?? item);
});

// Give uninstalled/removed cyberware from a character's personal inventory to
// a ripperdoc clinic's stock. Complements the ripperdoc removal flow's
// "clinic" destination for pieces that were removed to the patient (category
// "cyberware (removed)") and only later donated to a clinic. Owner-initiated,
// no money moves; the clinic sets a resale price afterwards.
router.post("/characters/:cid/inventory/:itemId/give-to-clinic", requireAuth, async (req, res): Promise<void> => {
  const cid = parseInt(String(req.params.cid), 10);
  const itemId = parseInt(String(req.params.itemId), 10);
  const sender = await loadOwnedChar(req.user!.id, cid);
  if (!sender) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (sender.archived) {
    res.status(400).json({ error: "Cannot give from an archived character" });
    return;
  }
  const { ripperdocId, quantity, memo } = req.body ?? {};
  const clinicId = parseInt(String(ripperdocId), 10);
  if (!Number.isFinite(clinicId)) {
    res.status(400).json({ error: "ripperdocId required" });
    return;
  }
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.characterId, cid)));
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return;
  }
  const qty = Math.max(1, Number(quantity) || 1);
  if (qty > item.quantity) {
    res.status(400).json({ error: "Quantity exceeds available stock" });
    return;
  }
  // Only chrome belongs in a ripperdoc's parts bin: loose (uninstalled)
  // "cyberware" or previously removed "cyberware (removed)" pieces.
  const cat = normalizeName(item.category ?? "");
  if (cat !== "cyberware" && cat !== "cyberware (removed)") {
    res.status(400).json({ error: "Only cyberware can be given to a clinic's stock" });
    return;
  }
  if (cat === "cyberware" && parseCwp(item.notes) != null) {
    res.status(400).json({
      error: "This cyberware is currently installed. Have a ripperdoc remove it first — then the removed piece can be given to a clinic.",
    });
    return;
  }
  const [clinic] = await db.select().from(ripperdocs).where(eq(ripperdocs.id, clinicId));
  if (!clinic) {
    res.status(404).json({ error: "Clinic not found" });
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  // Keep a "CWP n" tag on the stock notes — it's the floor a future install
  // charges when the catalog has no authoritative value (parity with the
  // removal flow's clinic destination). Removed items usually still carry
  // their original "CWP n · Installed ..." note, so parse from there.
  const partCwp = parseCwp(item.notes) ?? 0;
  let moved = false;
  await db.transaction(async (tx) => {
    // Optimistic concurrency: writes are conditioned on the quantity we read,
    // so a concurrent transfer/consume makes this a no-op → 409.
    if (qty === item.quantity) {
      const [gone] = await tx
        .delete(inventoryItems)
        .where(and(
          eq(inventoryItems.id, itemId),
          eq(inventoryItems.characterId, cid),
          eq(inventoryItems.quantity, item.quantity),
        ))
        .returning();
      if (!gone) return;
    } else {
      const [updated] = await tx
        .update(inventoryItems)
        .set({ quantity: item.quantity - qty })
        .where(and(
          eq(inventoryItems.id, itemId),
          eq(inventoryItems.characterId, cid),
          eq(inventoryItems.quantity, item.quantity),
        ))
        .returning();
      if (!updated) return;
    }
    await tx.insert(ripperdocStock).values({
      ripperdocId: clinic.id,
      name: item.name,
      category: "cyberware",
      price: 0,
      cost: 0,
      quantity: qty,
      notes: `CWP ${partCwp} · Given by ${sender.name} on ${today}`,
    });
    moved = true;
  });
  if (!moved) {
    res.status(409).json({ error: "Item changed while giving; please retry" });
    return;
  }
  // Custody: a whole-stack give means the instance left the player entirely
  // ("transferred"); a partial give must be recorded as a "split" (mirroring
  // the P2P transfer route) so the source instance's chain doesn't claim the
  // whole instance departed while part of it remains in inventory. The
  // clinic-stock side has no per-instance chain (parity with the removal
  // flow's clinic destination, which also lands parts as plain stock rows).
  const givenReason = memo ? `Given to clinic stock: ${clinic.name} — ${memo}` : `Given to clinic stock: ${clinic.name}`;
  await recordInventoryEvent({
    instanceUuid: item.instanceUuid,
    kind: qty === item.quantity ? "transferred" : "split",
    actorId: req.user!.id,
    actorName: req.user!.username,
    fromCharacterId: sender.id,
    fromCharacterName: sender.name,
    itemName: item.name,
    quantity: qty,
    reason: qty === item.quantity ? givenReason : `Split ${qty} of ${item.quantity} — ${givenReason}`,
    metadata: { destination: "clinic_stock", ripperdocId: clinic.id, ripperdocName: clinic.name },
  });
  await db.insert(activityEvents).values({
    kind: "transfer",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${sender.name} gave ${item.name} x${qty} to ${clinic.name}'s clinic stock`,
  });
  await db.insert(characterUpdates).values([
    { characterId: cid, authorId: req.user!.id, note: `Gave ${item.name} x${qty} to clinic stock at ${clinic.name}` },
  ]);
  res.sendStatus(204);
});

// ===== Per-item chain of custody =====
// Returns an item by its stable instanceUuid, plus the full event chain.
// Scope: the current owner of the live item, OR any FIXER/ADMIN. If the
// instance no longer exists (consumed/destroyed) only fixers/admins can
// view it — there is no current player owner to authorize against.
router.get("/inventory-items/:uuid", requireAuth, async (req, res): Promise<void> => {
  const uuidParam = String(req.params.uuid);
  if (!/^[0-9a-f-]{36}$/i.test(uuidParam)) {
    res.status(400).json({ error: "Invalid instance uuid" });
    return;
  }
  const [live] = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.instanceUuid, uuidParam));
  const isStaff = isStaffRoles(req.user!.roles);
  if (!live && !isStaff) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (live && !isStaff) {
    // Owner check — match by characterId belonging to the caller.
    if (live.characterId == null) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const owned = await loadOwnedChar(req.user!.id, live.characterId);
    if (!owned) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }
  const events = await db
    .select()
    .from(inventoryEvents)
    .where(eq(inventoryEvents.instanceUuid, uuidParam))
    .orderBy(inventoryEvents.createdAt);
  let currentCharacter: { id: number; name: string } | null = null;
  if (live?.characterId != null) {
    const [c] = await db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(eq(characters.id, live.characterId));
    currentCharacter = c ?? null;
  }
  res.json({ item: live ?? null, currentCharacter, events });
});

// Wallet
router.get("/characters/:id/wallet", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // UB is the source of truth — never fall back to a local-sum read.
  const ub = await getBalance(req.user!.discordId);
  if (!ub) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  // Conform to the OpenAPI Wallet schema (characterId + balance required); keep
  // cash/bank for the detailed breakdown. `balance` is the UB total.
  res.json({ characterId: id, balance: ub.total, cash: ub.cash, bank: ub.bank, source: "unbelievaboat" });
});

router.get("/characters/:id/wallet/transactions", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  // Owner or staff (admin/fixer) — staff view the history on the admin archive
  // page. Account-level rows are keyed off the character's OWNER, not the
  // caller, so a staff viewer sees the owner's ledger (not their own).
  const c = await loadOwnedOrStaffChar(req.user!, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Return character-scoped rows plus account-level history rows for the
  // owner (imported legacy ledger has userId set / characterId null).
  const rows = await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        or(
          eq(walletTransactions.characterId, id),
          c.ownerId ? eq(walletTransactions.userId, c.ownerId) : sql`false`,
        ),
        // Hide net-zero bank<->cash move rows (they only carry an idempotency
        // key; the total never changed so they'd read as a "+0" entry).
        notInArray(walletTransactions.kind, ["bank_withdraw", "bank_deposit"]),
      ),
    )
    .orderBy(desc(walletTransactions.createdAt))
    .limit(100);
  // Guarantee `category` is populated even for rows written before the backfill
  // or by paths that don't set it (derive from kind+memo on the fly).
  res.json(
    rows.map((r) => ({
      ...r,
      category: r.category ?? classifyWalletCategory(r.kind, r.memo),
    })),
  );
});

// Shared eddie-transfer implementation. `fromChar` is the sender's character
// when transferring from a character context, or null for the account-level
// route (players with no approved character still have a UB account — money is
// account-level; characters are only ledger attribution). The recipient may be
// a character (toCharacterId) OR a bare player account (toUserId) so players
// without an approved character can still receive money.
async function handleEddieTransfer(
  req: Parameters<Parameters<typeof router.post>[1]>[0],
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  fromChar: { id: number; name: string } | null,
): Promise<void> {
  const { toCharacterId, toUserId, amount, memo } = req.body ?? {};
  if (!amount || amount <= 0 || (!toCharacterId && !toUserId) || (toCharacterId && toUserId)) {
    res.status(400).json({ error: "positive amount and exactly one of toCharacterId / toUserId required" });
    return;
  }
  let to: { id: number; name: string } | null = null;
  let toOwner: typeof users.$inferSelect | undefined;
  if (toCharacterId) {
    const [toRow] = await db.select().from(characters).where(eq(characters.id, toCharacterId));
    if (!toRow) {
      res.status(404).json({ error: "Recipient not found" });
      return;
    }
    // Refuse to transfer into an unclaimed character — there is no UB account
    // to credit, so the sender's debit would have no offsetting credit.
    if (!toRow.ownerId) {
      res.status(409).json({ error: "Recipient character is unclaimed (no owner)" });
      return;
    }
    [toOwner] = await db.select().from(users).where(eq(users.id, toRow.ownerId));
    to = { id: toRow.id, name: toRow.name };
  } else {
    [toOwner] = await db.select().from(users).where(eq(users.id, String(toUserId)));
  }
  if (!toOwner) {
    res.status(409).json({ error: "Recipient account missing" });
    return;
  }
  const fromName = fromChar?.name ?? req.user!.username;
  const toName = to?.name ?? (toOwner.globalName || toOwner.username);
  // Idempotency: a client may pass a key (UUID generated once per submit) so a
  // retry / double-click can't run the debit+credit twice. If we've already
  // settled this exact transfer, return success without touching UB again.
  const transferKey =
    typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
      ? `transfer:${req.body.idempotencyKey.trim().slice(0, 80)}`
      : null;
  if (transferKey) {
    const [done] = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.idempotencyKey, `${transferKey}:out`), eq(walletTransactions.syncStatus, "synced")));
    if (done) {
      const cur = await getBalance(req.user!.discordId);
      res.json({
        ...(fromChar ? { characterId: fromChar.id } : {}),
        balance: cur?.total ?? 0,
        cash: cur?.cash ?? 0,
        bank: cur?.bank ?? 0,
        source: cur?.source ?? "unbelievaboat",
      });
      return;
    }
  }
  // UB is authoritative — require a successful balance read before attempting writes.
  const senderBal = await getBalance(req.user!.discordId);
  if (!senderBal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (senderBal.cash < amount) {
    // Distinguish "you genuinely don't have enough" from "you have enough total
    // but it's sitting in the bank" — transfers only spend cash, so the latter
    // is fixable by withdrawing first. Point the player there instead of the
    // old generic message.
    if (senderBal.total >= amount) {
      res.status(400).json({
        error: `Not enough cash on hand. You have ${senderBal.cash.toLocaleString()} €$ in cash — withdraw at least ${(amount - senderBal.cash).toLocaleString()} €$ from your bank first, then try again.`,
      });
      return;
    }
    res.status(400).json({ error: "Insufficient funds" });
    return;
  }
  // Debit sender via UB — must succeed.
  const debited = await patchBalance(req.user!.discordId, { cash: -amount, reason: memo ?? `Transfer to ${toName}` });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  const credited = await patchBalance(toOwner.discordId, { cash: amount, reason: memo ?? `From ${fromName}` });
  if (!credited) {
    // Compensate: refund sender to keep UB consistent. If the refund itself
    // fails the sender has been debited with no offsetting credit and no
    // record — surface a loud, structured log so an operator can reconcile by
    // hand, and tell the caller the truth rather than a clean refund message.
    const refund = await patchBalance(req.user!.discordId, { cash: amount, reason: `Refund: credit to ${toName} failed` });
    if (!refund) {
      logger.error(
        { fromDiscordId: req.user!.discordId, toCharacterId: to?.id ?? null, toUserId: toOwner.id, amount },
        "TRANSFER_REFUND_FAILED: sender debited but credit AND refund failed — manual reconciliation required",
      );
      res.status(502).json({ error: "Transfer failed and refund failed; contact staff for reconciliation." });
      return;
    }
    res.status(502).json({ error: "Wallet provider rejected credit; sender refunded" });
    return;
  }
  // Only after confirmed UB writes do we record local history. Route both legs
  // through recordSettledWalletMovement so each owner's website wallet balance
  // (users.walletBalance) advances immediately instead of drifting until the
  // next reconcile, and so a keyed retry never double-records.
  await recordSettledWalletMovement({
    userId: req.user!.id,
    amount: -amount,
    ubTotalAfter: debited.total,
    source: "website",
    kind: "transfer_out",
    memo: memo ?? null,
    characterId: fromChar?.id ?? null,
    counterpartyCharacterId: to?.id ?? null,
    counterpartyName: toName,
    idempotencyKey: transferKey ? `${transferKey}:out` : null,
  });
  await recordSettledWalletMovement({
    userId: toOwner.id,
    amount,
    ubTotalAfter: credited.total,
    source: "website",
    kind: "transfer_in",
    memo: memo ?? null,
    characterId: to?.id ?? null,
    counterpartyCharacterId: fromChar?.id ?? null,
    counterpartyName: fromName,
    idempotencyKey: transferKey ? `${transferKey}:in` : null,
  });
  const ub = await getBalance(req.user!.discordId);
  await recordAudit({
    req,
    category: "wallet",
    action: "transfer",
    targetType: fromChar ? "character" : "user",
    targetId: fromChar?.id ?? null,
    message: `${fromName} → ${toName}: ${amount}`,
    after: {
      fromCharacterId: fromChar?.id ?? null,
      toCharacterId: to?.id ?? null,
      toUserId: toOwner.id,
      amount,
      memo: memo ?? null,
    },
  });
  // Return the documented Wallet shape (characterId + balance) for the sender's
  // post-transfer balance, instead of the raw UbBalance (which used `total`).
  res.json({
    ...(fromChar ? { characterId: fromChar.id } : {}),
    balance: ub?.total ?? 0,
    cash: ub?.cash ?? 0,
    bank: ub?.bank ?? 0,
    source: ub?.source ?? "unbelievaboat",
  });
}

router.post("/characters/:id/wallet/transfer", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await handleEddieTransfer(req, res, { id: c.id, name: c.name });
});

// Account-level transfer: players with no approved character still have a UB
// wallet, so they can send money without a character context. Ledger legs are
// recorded with a null characterId (account-level rows).
router.post("/wallet/transfer", requireAuth, async (req, res): Promise<void> => {
  await handleEddieTransfer(req, res, null);
});

// Money sink: pay "Night City Bot" to burn eddies out of the economy. Unlike a
// transfer this has ONLY a debit leg — there is no counterparty account to
// credit, so the eddies simply leave circulation. Mirrors the transfer debit
// path exactly (UB-authoritative balance read, cash check with bank-withdraw
// hint, keyed idempotency) so a retry / double-click can't burn twice.
router.post("/characters/:id/wallet/sink", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { amount, memo } = req.body ?? {};
  if (!amount || amount <= 0) {
    res.status(400).json({ error: "positive amount required" });
    return;
  }
  const sinkKey =
    typeof req.body?.idempotencyKey === "string" && req.body.idempotencyKey.trim()
      ? `sink:${req.body.idempotencyKey.trim().slice(0, 80)}`
      : null;
  if (sinkKey) {
    const [done] = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(and(eq(walletTransactions.idempotencyKey, sinkKey), eq(walletTransactions.syncStatus, "synced")));
    if (done) {
      const cur = await getBalance(req.user!.discordId);
      res.json({
        characterId: id,
        balance: cur?.total ?? 0,
        cash: cur?.cash ?? 0,
        bank: cur?.bank ?? 0,
        source: cur?.source ?? "unbelievaboat",
      });
      return;
    }
  }
  // UB is authoritative — require a successful balance read before writing.
  const bal = await getBalance(req.user!.discordId);
  if (!bal) {
    res.status(502).json({ error: "Wallet provider unavailable" });
    return;
  }
  if (bal.cash < amount) {
    if (bal.total >= amount) {
      res.status(400).json({
        error: `Not enough cash on hand. You have ${bal.cash.toLocaleString()} €$ in cash — withdraw at least ${(amount - bal.cash).toLocaleString()} €$ from your bank first, then try again.`,
      });
      return;
    }
    res.status(400).json({ error: "Insufficient funds" });
    return;
  }
  const debited = await patchBalance(req.user!.discordId, {
    cash: -amount,
    reason: memo ?? "Paid Night City Bot",
  });
  if (!debited) {
    res.status(502).json({ error: "Wallet provider rejected debit" });
    return;
  }
  await recordSettledWalletMovement({
    userId: req.user!.id,
    amount: -amount,
    ubTotalAfter: debited.total,
    source: "website",
    kind: "sink",
    memo: memo ?? null,
    characterId: id,
    counterpartyName: "Night City Bot",
    idempotencyKey: sinkKey,
  });
  await recordAudit({
    req,
    category: "wallet",
    action: "sink",
    targetType: "character",
    targetId: id,
    message: `${c.name} paid Night City Bot: ${amount}`,
    after: { characterId: id, amount, memo: memo ?? null },
  });
  const ub = await getBalance(req.user!.discordId);
  res.json({
    characterId: id,
    balance: ub?.total ?? 0,
    cash: ub?.cash ?? 0,
    bank: ub?.bank ?? 0,
    source: ub?.source ?? "unbelievaboat",
  });
});

// Status
router.get("/characters/:id/status", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [s] = await db.select().from(characterStatus).where(eq(characterStatus.characterId, id));
  // Include updatedAt to satisfy the documented CharacterStatus schema even when
  // no status row exists yet (first read for a character).
  res.json(s ?? { characterId: id, loa: false, attending: false, openShop: false, updatedAt: new Date().toISOString() });
});

router.patch("/characters/:id/status", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { loa, loaReturnsAt, attending, openShop, statusMessage } = req.body ?? {};
  const patch = {
    ...(loa !== undefined ? { loa } : {}),
    ...(loaReturnsAt !== undefined ? { loaReturnsAt: loaReturnsAt ? new Date(loaReturnsAt) : null } : {}),
    ...(attending !== undefined ? { attending } : {}),
    ...(openShop !== undefined ? { openShop } : {}),
    ...(statusMessage !== undefined ? { statusMessage } : {}),
  };
  const [existing] = await db.select().from(characterStatus).where(eq(characterStatus.characterId, id));
  let result;
  if (existing) {
    [result] = await db.update(characterStatus).set(patch).where(eq(characterStatus.characterId, id)).returning();
  } else {
    [result] = await db.insert(characterStatus).values({ characterId: id, ...patch }).returning();
  }
  const flips: string[] = [];
  if (loa !== undefined && loa !== (existing?.loa ?? false)) flips.push(loa ? "set LOA" : "returned from LOA");
  if (attending !== undefined && attending !== (existing?.attending ?? false)) flips.push(attending ? "marked attending" : "no longer attending");
  if (openShop !== undefined && openShop !== (existing?.openShop ?? false)) flips.push(openShop ? "opened shop" : "closed shop");
  if (statusMessage !== undefined && statusMessage !== (existing?.statusMessage ?? null)) flips.push("updated status message");
  if (loaReturnsAt !== undefined) {
    const prevMs = existing?.loaReturnsAt ? new Date(existing.loaReturnsAt).getTime() : null;
    const nextMs = loaReturnsAt ? new Date(loaReturnsAt).getTime() : null;
    if (prevMs !== nextMs) {
      flips.push(nextMs ? `LOA return date set to ${new Date(nextMs).toISOString().slice(0, 10)}` : "cleared LOA return date");
    }
  }
  if (flips.length) {
    await db.insert(characterUpdates).values({
      characterId: id,
      authorId: req.user!.id,
      note: `Status: ${flips.join(", ")}`,
    });
  }
  res.json(result);
});

// Open-shop: a character with an active `business` lease can press this
// once per UTC day. The button drives passive income on the next
// monthly_rent run — see SHOP_T0_PAYOUTS / SHOP_TIER_PLUS_MULT in
// lib/jobs.ts. The UNIQUE (characterId, openedOn) index in `shop_opens`
// is the idempotency guarantee; we still pre-count in this month so the
// UI can honestly show "X / 4 paying opens this month" without round-trip
// math on the client.
router.get("/characters/:id/shop", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const leases = await db
    .select()
    .from(housing)
    .where(and(eq(housing.characterId, id), eq(housing.kind, "business")));
  // A character is a "shop owner" if it holds a business lease OR owns a
  // storefront / ripperdoc clinic. Venue owners have no rent base, so they
  // earn the flat Tier-0 schedule on the monthly run (see lib/jobs.ts).
  const [ownedStores, ownedClinics] = await Promise.all([
    db.select({ id: stores.id, name: stores.name }).from(stores).where(eq(stores.ownerCharacterId, id)),
    db.select({ id: ripperdocs.id, name: ripperdocs.name }).from(ripperdocs).where(eq(ripperdocs.ownerCharacterId, id)),
  ]);
  const venues = [
    ...ownedStores.map((s) => ({ kind: "store" as const, id: s.id, name: s.name })),
    ...ownedClinics.map((r) => ({ kind: "ripperdoc" as const, id: r.id, name: r.name })),
  ];
  // Start of current UTC month.
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const opens = await db
    .select()
    .from(shopOpens)
    .where(and(eq(shopOpens.characterId, id), gte(shopOpens.openedAt, monthStart)))
    .orderBy(desc(shopOpens.openedAt));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  const openedToday = opens.some((o) => o.openedOn === today);
  // Label the shop: lease address for lease-holders (with rent), else the
  // venue name for storefront / clinic owners.
  const shopLabel = leases[0]?.address ?? venues[0]?.name ?? null;
  const windowOpen = isSessionWindowOpen();
  res.json({
    characterId: id,
    businessLeases: leases.map((l) => ({
      id: l.id,
      listingId: l.listingId,
      address: l.address,
      monthlyRent: l.monthlyRent,
    })),
    venues,
    shopLabel,
    canOpen: leases.length > 0 || venues.length > 0,
    // Shop can only be opened during the live session window (Sundays
    // 2-9pm Pacific), mirroring the weekly attendance claim.
    windowOpen,
    windowHint: SESSION_WINDOW_HINT,
    nextWindowOpensAt: windowOpen ? null : nextSessionWindowStart().toISOString(),
    openedToday,
    opensThisMonth: opens.length,
    opensCountedForIncome: Math.min(opens.length, 4),
    history: opens.slice(0, 12).map((o) => ({
      openedOn: o.openedOn,
      openedAt: o.openedAt,
      listingId: o.listingId,
    })),
  });
});

// Full open-shop history: this character's portal-era opens (shop_opens, all
// time) merged with the player's imported bot-era opens (bot_business_open_log,
// keyed by Discord id — account-wide, since the bot logged opens per player not
// per character). Read-only — powers the "OPEN SHOP HISTORY" dialog.
router.get("/characters/:id/shop-history", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const discordId = req.user!.discordId;
  const [portalOpens, botOpens] = await Promise.all([
    db
      .select()
      .from(shopOpens)
      .where(eq(shopOpens.characterId, id))
      .orderBy(desc(shopOpens.openedAt))
      .limit(500),
    db
      .select()
      .from(botBusinessOpenLog)
      .where(eq(botBusinessOpenLog.userId, discordId))
      .orderBy(desc(botBusinessOpenLog.openedAt))
      .limit(500),
  ]);

  const entries = [
    ...portalOpens.map((o) => ({
      source: "portal" as const,
      at: new Date(o.openedAt),
      date: o.openedOn,
    })),
    ...botOpens.map((o) => ({
      source: "bot" as const,
      at: new Date(o.openedAt),
      date: new Date(o.openedAt).toISOString().slice(0, 10),
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  res.json({
    characterId: id,
    totalCount: entries.length,
    portalCount: portalOpens.length,
    botCount: botOpens.length,
    entries: entries.map((e) => ({
      source: e.source,
      date: e.date,
      at: e.at.toISOString(),
    })),
  });
});

router.post("/characters/:id/open-shop", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const c = await loadOwnedChar(req.user!.id, id);
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Shop can only be opened during the live session window (Sundays
  // 2-9pm Pacific), mirroring the weekly attendance claim. The frontend
  // disables the button outside the window, but the server is authoritative.
  if (!isSessionWindowOpen()) {
    res.status(403).json({
      error: `Shop can only be opened during Sunday sessions (${SESSION_WINDOW_HINT}).`,
      nextWindowOpensAt: nextSessionWindowStart().toISOString(),
    });
    return;
  }
  const leases = await db
    .select()
    .from(housing)
    .where(and(eq(housing.characterId, id), eq(housing.kind, "business")));
  // Venue owners (storefront / ripperdoc clinic) can open shop too, even
  // without a business lease — they earn the flat Tier-0 schedule monthly.
  const [ownedStores, ownedClinics] = await Promise.all([
    db.select({ id: stores.id, name: stores.name }).from(stores).where(eq(stores.ownerCharacterId, id)),
    db.select({ id: ripperdocs.id, name: ripperdocs.name }).from(ripperdocs).where(eq(ripperdocs.ownerCharacterId, id)),
  ]);
  const venueName = ownedStores[0]?.name ?? ownedClinics[0]?.name ?? null;
  if (leases.length === 0 && !venueName) {
    res.status(403).json({ error: "Character does not own a shop" });
    return;
  }
  // If the body specifies a leaseId, validate it belongs to this character;
  // otherwise default to the first business lease (if any).
  const requestedLeaseId = Number(req.body?.leaseId);
  const lease = requestedLeaseId
    ? leases.find((l) => l.id === requestedLeaseId)
    : leases[0];
  if (requestedLeaseId && !lease) {
    res.status(400).json({ error: "Lease not owned by this character" });
    return;
  }
  const shopLabel = lease?.address ?? venueName ?? "their shop";
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString()
    .slice(0, 10);
  // One paid open per live session. Opens are already gated to the Sunday
  // 2–9pm Pacific window, so any open within the last 8 hours belongs to the
  // SAME session (the window is 7h; sessions are a week apart) — an 8h lookback
  // is timezone-math-free and can't bleed into a neighbouring session.
  const sessionLookback = new Date(now.getTime() - 8 * 60 * 60 * 1000);

  // Atomically claim this session's open. A per-character advisory lock
  // serializes concurrent open-shop attempts so the check-then-insert is
  // race-safe. This closes the UTC-midnight straddle where two requests could
  // both pass the lookback and then insert on DIFFERENT `openedOn` dates
  // (Sun/Mon), each slipping past the (characterId, openedOn) per-day unique
  // index and getting paid twice. The transaction commits — releasing the lock
  // — BEFORE the external UB credit, so no HTTP call is held inside the lock; a
  // request that was blocked then sees the committed row on re-check and 409s.
  let outcome:
    | { kind: "already"; openedAt: Date }
    | { kind: "opened"; row: typeof shopOpens.$inferSelect };
  try {
    outcome = await db.transaction(async (tx): Promise<typeof outcome> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(8123, ${id})`);
      const [prior] = await tx
        .select({ id: shopOpens.id, openedAt: shopOpens.openedAt })
        .from(shopOpens)
        .where(and(eq(shopOpens.characterId, id), gte(shopOpens.openedAt, sessionLookback)))
        .limit(1);
      if (prior) return { kind: "already", openedAt: prior.openedAt };
      const [inserted] = await tx
        .insert(shopOpens)
        .values({
          characterId: id,
          listingId: lease?.listingId ?? null,
          openedOn: today,
          notes: typeof req.body?.notes === "string" ? req.body.notes : null,
        })
        .returning();
      return { kind: "opened", row: inserted };
    });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "23505") {
      res.status(409).json({ error: "Shop already opened this session", openedOn: today });
      return;
    }
    throw err;
  }
  if (outcome.kind === "already") {
    res.status(409).json({ error: "Shop already opened this session", openedAt: outcome.openedAt });
    return;
  }
  const row = outcome.row;

  // Instant shop income: credit the owner's cash the moment they open shop,
  // like the weekly attendance bonus. loadOwnedChar guarantees the caller IS
  // the owner, so req.user is the payee. On a clean UB failure we roll the open
  // back so the owner can retry cleanly (no money moved).
  const payoutMemo = `Shop income: ${shopLabel}`;
  const ub = await patchBalance(req.user!.discordId, { cash: SHOP_OPEN_PAYOUT, reason: payoutMemo });
  if (!ub) {
    await db.delete(shopOpens).where(eq(shopOpens.id, row.id)).catch(() => {});
    res.status(502).json({ error: "UnbelievaBoat unavailable, try again shortly" });
    return;
  }
  // Record the settled ledger row + advance the website wallet balance. Keyed
  // on the open row id so a retry can never double-record.
  await recordSettledWalletMovement({
    userId: req.user!.id,
    amount: SHOP_OPEN_PAYOUT,
    ubTotalAfter: ub.total,
    source: "website",
    kind: "shop_income",
    memo: payoutMemo,
    characterId: id,
    idempotencyKey: `shop-open:${row.id}`,
  });

  await db.insert(activityEvents).values({
    kind: "shop_opened",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${c.name} opened shop at ${shopLabel} (+€${SHOP_OPEN_PAYOUT})`,
  });
  await recordAudit({
    req,
    category: "shop",
    action: "open",
    targetType: "character",
    targetId: id,
    message: `${c.name} opened shop at ${shopLabel} (+€${SHOP_OPEN_PAYOUT})`,
    after: { leaseId: lease?.id ?? null, address: shopLabel, openedOn: today, payout: SHOP_OPEN_PAYOUT },
  });
  res.json({
    characterId: id,
    openedOn: row.openedOn,
    openedAt: row.openedAt,
    leaseAddress: shopLabel,
    payout: SHOP_OPEN_PAYOUT,
  });
});

export default router;

import { db, inventoryEvents } from "@workspace/db";
import { logger } from "./logger";

export type InventoryEventInput = {
  instanceUuid: string;
  kind:
    | "created"
    | "transferred"
    | "sold"
    | "split"
    | "adjusted"
    | "consumed"
    | "destroyed"
    | "history_begins";
  actorId?: string | null;
  actorName?: string | null;
  fromCharacterId?: number | null;
  fromCharacterName?: string | null;
  toCharacterId?: number | null;
  toCharacterName?: string | null;
  itemName: string;
  quantity?: number | null;
  price?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
};

// Best-effort append to the per-instance audit log. We never want a logging
// failure to abort the surrounding mutation, so any error is swallowed and
// only logged. Callers should treat this as fire-and-forget.
export async function recordInventoryEvent(ev: InventoryEventInput): Promise<void> {
  try {
    await db.insert(inventoryEvents).values({
      instanceUuid: ev.instanceUuid,
      kind: ev.kind,
      actorId: ev.actorId ?? null,
      actorName: ev.actorName ?? null,
      fromCharacterId: ev.fromCharacterId ?? null,
      fromCharacterName: ev.fromCharacterName ?? null,
      toCharacterId: ev.toCharacterId ?? null,
      toCharacterName: ev.toCharacterName ?? null,
      itemName: ev.itemName,
      quantity: ev.quantity ?? null,
      price: ev.price ?? null,
      reason: ev.reason ?? null,
      metadata: (ev.metadata as object | null | undefined) ?? null,
    });
  } catch (err) {
    logger.error({ err, ev }, "inventory event log write failed");
  }
}

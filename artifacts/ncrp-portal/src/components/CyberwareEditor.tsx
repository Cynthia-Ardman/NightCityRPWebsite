import { useMemo } from "react";
import { useListCyberware } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

// One editable cyberware row. `id` is the backing inventory_items.id when the
// row is loaded from an existing character (edit flow); freshly added rows have
// no id until they are persisted.
export type CyberRow = {
  id?: number;
  slot: string;
  name: string;
  points: number;
  notes: string;
  isCustom?: boolean;
  // True when the user opted to type a free-text name under a normal (catalog)
  // slot, instead of picking from that slot's catalog name dropdown.
  customName?: boolean;
};

const CUSTOM_SLOT = "__custom__";
const CUSTOM_NAME = "__custom_name__";

// Encode a cyberware row into the inventory_items.notes convention shared with
// the sheet seeder: "CWP <n> · <user notes> · slot: <slot>". The "slot: …" part
// MUST stay last — CharacterDetail's slot regex swallows everything after it.
export function buildCyberNotes(row: { points: number; notes: string; slot: string }): string {
  const parts = [`CWP ${Number(row.points) || 0}`];
  const userNotes = (row.notes ?? "").trim();
  if (userNotes) parts.push(userNotes);
  const slot = (row.slot ?? "").trim();
  if (slot) parts.push(`slot: ${slot}`);
  return parts.join(" · ");
}

// Sentinel the bulk cyberware importer (scripts/src/import-cyberware-inventory.ts)
// stamps into inventory_items.notes so reruns can find its own rows. It must
// never be shown to users — strip it everywhere a note is parsed for display.
const CYBER_IMPORT_TAG_RE = /\s*\[cyberware-import:[^\]]*\]/gi;

// Strip the bulk-importer sentinel from a note for display. Use this on any
// user-facing surface that renders raw inventory notes (e.g. the generic
// Inventory tab) so imported cyberware never shows "[cyberware-import:v1]".
export function stripImportSentinel(notes: string | null | undefined): string {
  return (notes ?? "").replace(CYBER_IMPORT_TAG_RE, "").trim();
}

// Inverse of buildCyberNotes — pull CWP, free-text notes and slot back out of a
// stored inventory note so an existing item can be edited.
//
// Two stored shapes exist: the editor's canonical "CWP n · <notes> · slot: <x>"
// and the bulk importer's "CWP n · <slot> · <notes> [cyberware-import:v1]", where
// the slot is a BARE segment with no "slot:" prefix. Pass the catalog slot names
// as `knownSlots` so a bare segment matching a real slot is recognised as the
// slot (and pulled out of the displayed notes) instead of leaking into the notes
// text. The import sentinel is always stripped.
export function parseCyberNotes(
  notes: string | null | undefined,
  knownSlots?: Iterable<string | null | undefined>,
): {
  points: number;
  notes: string;
  slot: string;
} {
  const slotLookup = new Map<string, string>();
  if (knownSlots) {
    for (const s of knownSlots) {
      const v = (s ?? "").trim();
      if (v) slotLookup.set(v.toLowerCase(), v);
    }
  }
  const cleaned = stripImportSentinel(notes);
  const parts = cleaned.split(" · ");
  let points = 0;
  let slot = "";
  const userNotes: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const cwp = t.match(/^CWP\s+(\d+)$/i);
    if (cwp) {
      points = Number(cwp[1]) || 0;
      continue;
    }
    const sl = t.match(/^slot:\s*(.+)$/i);
    if (sl) {
      slot = sl[1].trim();
      continue;
    }
    if (!slot && slotLookup.has(t.toLowerCase())) {
      slot = slotLookup.get(t.toLowerCase()) as string;
      continue;
    }
    userNotes.push(t);
  }
  return { points, notes: userNotes.join(" · "), slot };
}

// Lenient CWP extractor mirroring the server's parseCwp (artifacts/api-server/
// src/lib/cyberware.ts): accepts "CWP 2", "CWP: 1.0", "C.W.P 3", and the
// reversed "2 CWP" / "3 points" / "2 pts" forms, so a character's DISPLAYED
// risk band is computed from exactly the same chrome the billing cron charges
// off. parseCyberNotes (above) is the STRICT round-trip parser for the editor's
// canonical "CWP <int>" form; use this one only for read-only band totals where
// legacy/free-typed notes must still be counted.
const CWP_PATTERNS = [
  /\bcwp\b[\s:=-]*?(\d+(?:\.\d+)?)/i,
  /\bc\.w\.p\.?\b[\s:=-]*?(\d+(?:\.\d+)?)/i,
  /(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\b/i,
];
export function cwpFromNotes(notes: string | null | undefined): number {
  if (!notes) return 0;
  for (const re of CWP_PATTERNS) {
    const m = notes.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

// Whether the notes carry a CWP install tag at all — distinct from
// cwpFromNotes, which returns 0 both for "no tag" and a legitimate "CWP 0"
// install. Installed-ness must key on tag PRESENCE (mirrors the server's
// parseCwp(notes) != null), or zero-point chrome renders as uninstalled.
export function hasCwpTag(notes: string | null | undefined): boolean {
  if (!notes) return false;
  return CWP_PATTERNS.some((re) => {
    const m = notes.match(re);
    return !!m && Number.isFinite(parseFloat(m[1]));
  });
}

// Bucket a total CWP load into the same risk band the server derives
// (artifacts/api-server/src/lib/jobs.ts deriveCyberwareBand) and that the
// weekly meds-billing cron charges off: 0-6 none · 7-9 medium · 10-12 high ·
// 13+ extreme. Kept here next to parseCyberNotes so any client surface showing
// a character's chrome load derives the band from real installed cyberware
// (the billed source of truth) instead of the stale cyberwareLevel column.
export function deriveCwpBand(totalCwp: number): "none" | "medium" | "high" | "extreme" {
  if (totalCwp >= 13) return "extreme";
  if (totalCwp >= 10) return "high";
  if (totalCwp >= 7) return "medium";
  return "none";
}

// Mutation callbacks the reconcile needs. These mirror the orval-generated
// inventory hooks' `mutateAsync` signatures, kept narrow so the helper stays
// decoupled from the hook objects themselves.
export type CyberReconcileMutations = {
  add: (args: {
    id: number;
    data: { name: string; category: string; quantity: number; notes: string; equipped: boolean };
  }) => Promise<{ id: number }>;
  update: (args: { id: number; itemId: number; data: { name: string; notes: string } }) => Promise<unknown>;
  remove: (args: { id: number; itemId: number }) => Promise<unknown>;
};

// Apply cyberware row edits immediately by diffing `working` against the
// `survivingOriginal` snapshot: delete removed rows, patch changed rows, insert
// new ones. Shared by the edit dialog and the character-detail staff card so the
// reconcile (and its partial-failure resumability) lives in exactly one place.
//
// Both `working` and `survivingOriginal` are CALLER-OWNED and mutated in place:
// `working` mirrors the user's full row list (server-assigned ids are folded in
// as rows persist, so nothing typed is lost even on a mid-sequence failure), and
// `survivingOriginal` tracks what is actually on the server keyed by id. Because
// the caller holds both, its `finally` can commit partial progress after a throw
// — a retry then neither re-creates already-created rows nor re-deletes
// already-deleted ones.
export async function reconcileCyberware(opts: {
  characterId: number;
  working: CyberRow[];
  survivingOriginal: Map<number, CyberRow>;
  mutations: CyberReconcileMutations;
}): Promise<void> {
  const { characterId, working, survivingOriginal, mutations } = opts;

  const liveIds = new Set(working.filter((r) => r.id != null).map((r) => r.id));
  const removed = Array.from(survivingOriginal.values()).filter(
    (r) => r.id != null && !liveIds.has(r.id),
  );
  for (const r of removed) {
    await mutations.remove({ id: characterId, itemId: r.id as number });
    survivingOriginal.delete(r.id as number);
  }

  for (let i = 0; i < working.length; i++) {
    const r = working[i];
    const name = r.name.trim() || r.slot.trim();
    if (!name) continue; // skip empty rows entirely
    const notes = buildCyberNotes({ points: r.points, notes: r.notes, slot: r.slot });
    if (r.id != null) {
      const orig = survivingOriginal.get(r.id);
      const origNotes = orig
        ? buildCyberNotes({ points: orig.points, notes: orig.notes, slot: orig.slot })
        : "";
      if (!orig || orig.name !== name || origNotes !== notes) {
        await mutations.update({ id: characterId, itemId: r.id, data: { name, notes } });
      }
      survivingOriginal.set(r.id, { ...r, name });
    } else {
      const created = await mutations.add({
        id: characterId,
        data: { name, category: "cyberware", quantity: 1, notes, equipped: true },
      });
      working[i] = { ...r, id: created.id, name };
      survivingOriginal.set(created.id, working[i]);
    }
  }
}

// Controlled editor for a list of cyberware rows. Used by both the admin
// create-character form and the edit-character dialog. No CWP cap is enforced
// here — staff managing NPCs / existing characters are intentionally uncapped;
// the running total is shown for reference only.
export default function CyberwareEditor({
  rows,
  onChange,
  testIdPrefix = "cyber",
}: {
  rows: CyberRow[];
  onChange: (rows: CyberRow[]) => void;
  testIdPrefix?: string;
}) {
  const { data: catalog } = useListCyberware();

  const catalogSlots = useMemo(() => {
    const set = new Set<string>();
    (catalog ?? []).forEach((c) => {
      if (c.slot) set.add(c.slot);
    });
    return Array.from(set).sort();
  }, [catalog]);
  const catalogSlotSet = useMemo(() => new Set(catalogSlots), [catalogSlots]);

  const total = rows.reduce((s, r) => s + (Number(r.points) || 0), 0);

  // A row renders in "custom" mode when explicitly chosen, or when its slot
  // isn't part of the catalog (e.g. legacy / free-text slots from old data).
  const rowIsCustom = (r: CyberRow) => !!r.isCustom || (r.slot !== "" && !catalogSlotSet.has(r.slot));

  function update(i: number, patch: Partial<CyberRow>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    onChange(rows.filter((_, j) => j !== i));
  }
  function add() {
    onChange([...rows, { slot: "", name: "", points: 0, notes: "", isCustom: false, customName: false }]);
  }
  function onSlotChange(i: number, value: string) {
    // Changing the slot resets the slot-specific name/points selection, but must
    // preserve any notes the user has already typed for this row.
    if (value === CUSTOM_SLOT) {
      update(i, { isCustom: true, customName: false, slot: "", name: "", points: 0 });
    } else {
      update(i, { isCustom: false, customName: false, slot: value, name: "", points: 0 });
    }
  }
  function onNameChange(i: number, name: string, slot: string) {
    // "Custom name…" lets the user type a free-text name under a normal catalog
    // slot. Flip the row into custom-name mode and clear the catalog-derived
    // name/points so they start fresh.
    if (name === CUSTOM_NAME) {
      update(i, { customName: true, name: "", points: 0, notes: "" });
      return;
    }
    const item = (catalog ?? []).find((c) => c.slot === slot && c.name === name);
    update(i, {
      customName: false,
      name,
      points: item ? Number(item.cwp) || 0 : 0,
      notes: item?.description ?? "",
    });
  }

  return (
    <div className="space-y-3" data-testid={`cyberware-editor-${testIdPrefix}`}>
      <div className="flex items-center justify-between border-b border-border pb-2">
        <Label className="text-xs tracking-widest text-nc-cyan">CYBERWARE</Label>
        <span
          className="text-[10px] font-mono text-muted-foreground"
          data-testid={`text-cyber-total-${testIdPrefix}`}
        >
          {total} CWP total
        </span>
      </div>

      {rows.length === 0 && (
        <div className="text-muted-foreground italic text-xs">No cyberware. Add chrome below.</div>
      )}

      {rows.map((row, idx) => {
        const custom = rowIsCustom(row);
        const namesForSlot = (catalog ?? []).filter((c) => c.slot === row.slot);
        // Custom-name mode: either explicitly chosen via "Custom name…", or an
        // existing row whose stored name isn't one of its slot's catalog names
        // (so it round-trips as free text instead of an unmatched dropdown).
        const customName =
          !custom &&
          (!!row.customName ||
            (row.name.trim() !== "" &&
              namesForSlot.length > 0 &&
              !namesForSlot.some((c) => c.name === row.name)));
        const showNameInput = custom || customName || namesForSlot.length === 0;
        return (
          <div
            key={row.id ?? `new-${idx}`}
            className="border border-border/40 p-3 space-y-2 bg-card/30"
            data-testid={`cyber-row-${testIdPrefix}-${idx}`}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">SLOT</Label>
                <select
                  value={custom ? CUSTOM_SLOT : row.slot}
                  onChange={(e) => onSlotChange(idx, e.target.value)}
                  className="flex h-9 w-full rounded-none border border-input bg-background px-2 text-sm font-mono text-nc-cyan focus:outline-none focus:ring-1 focus:ring-nc-cyan"
                  data-testid={`select-cyber-slot-${testIdPrefix}-${idx}`}
                >
                  <option value="">— Select slot —</option>
                  {catalogSlots.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value={CUSTOM_SLOT}>Custom…</option>
                </select>
                {custom && (
                  <Input
                    value={row.slot}
                    onChange={(e) => update(idx, { slot: e.target.value })}
                    placeholder="Custom slot"
                    className="h-9"
                    data-testid={`input-cyber-customslot-${testIdPrefix}-${idx}`}
                  />
                )}
              </div>

              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">NAME</Label>
                {showNameInput ? (
                  <Input
                    value={row.name}
                    onChange={(e) =>
                      update(idx, { name: e.target.value, ...(custom ? {} : { customName: true }) })
                    }
                    placeholder="Cyberware name"
                    className="h-9"
                    data-testid={`input-cyber-name-${testIdPrefix}-${idx}`}
                  />
                ) : (
                  <select
                    value={row.name}
                    onChange={(e) => onNameChange(idx, e.target.value, row.slot)}
                    className="flex h-9 w-full rounded-none border border-input bg-background px-2 text-sm font-mono text-nc-cyan focus:outline-none focus:ring-1 focus:ring-nc-cyan"
                    data-testid={`select-cyber-name-${testIdPrefix}-${idx}`}
                  >
                    <option value="">— Select —</option>
                    {namesForSlot.map((c) => (
                      <option key={c.id} value={c.name}>
                        {c.name}
                        {c.cwp ? ` (${c.cwp} CWP)` : ""}
                      </option>
                    ))}
                    <option value={CUSTOM_NAME}>Custom name…</option>
                  </select>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">CWP</Label>
                <Input
                  type="number"
                  min={0}
                  value={row.points}
                  onChange={(e) => update(idx, { points: Number(e.target.value) || 0 })}
                  className="h-9"
                  data-testid={`input-cyber-points-${testIdPrefix}-${idx}`}
                />
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label className="text-[10px] text-muted-foreground">NOTES</Label>
                <Input
                  value={row.notes}
                  onChange={(e) => update(idx, { notes: e.target.value })}
                  placeholder="Optional notes"
                  className="h-9"
                  data-testid={`input-cyber-notes-${testIdPrefix}-${idx}`}
                />
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive h-7"
                onClick={() => remove(idx)}
                data-testid={`button-cyber-remove-${testIdPrefix}-${idx}`}
              >
                <Trash2 className="w-3 h-3 mr-1" /> REMOVE
              </Button>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rounded-none font-display"
        onClick={add}
        data-testid={`button-cyber-add-${testIdPrefix}`}
      >
        <Plus className="w-3 h-3 mr-1" /> ADD CYBERWARE
      </Button>
    </div>
  );
}

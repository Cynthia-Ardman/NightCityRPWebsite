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
};

const CUSTOM_SLOT = "__custom__";

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

// Inverse of buildCyberNotes — pull CWP, free-text notes and slot back out of a
// stored inventory note so an existing item can be edited.
export function parseCyberNotes(notes: string | null | undefined): {
  points: number;
  notes: string;
  slot: string;
} {
  const parts = (notes ?? "").split(" · ");
  let points = 0;
  let slot = "";
  const userNotes: string[] = [];
  for (const p of parts) {
    const cwp = p.match(/^CWP\s+(\d+)$/i);
    if (cwp) {
      points = Number(cwp[1]) || 0;
      continue;
    }
    const sl = p.match(/^slot:\s*(.+)$/i);
    if (sl) {
      slot = sl[1].trim();
      continue;
    }
    if (p.trim()) userNotes.push(p);
  }
  return { points, notes: userNotes.join(" · "), slot };
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
    onChange([...rows, { slot: "", name: "", points: 0, notes: "", isCustom: false }]);
  }
  function onSlotChange(i: number, value: string) {
    if (value === CUSTOM_SLOT) {
      update(i, { isCustom: true, slot: "", name: "", points: 0, notes: "" });
    } else {
      update(i, { isCustom: false, slot: value, name: "", points: 0, notes: "" });
    }
  }
  function onNameChange(i: number, name: string, slot: string) {
    const item = (catalog ?? []).find((c) => c.slot === slot && c.name === name);
    update(i, {
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
                {custom || namesForSlot.length === 0 ? (
                  <Input
                    value={row.name}
                    onChange={(e) => update(idx, { name: e.target.value })}
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

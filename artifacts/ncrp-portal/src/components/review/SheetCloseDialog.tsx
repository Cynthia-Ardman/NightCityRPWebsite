import { useEffect, useMemo, useState } from "react";
import {
  useCloseReviewTicket,
  useGetSheet,
  useListCyberware,
  useListGuns,
  getGetSheetQueryKey,
  getListCyberwareQueryKey,
  getListGunsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import SelectOrCustom from "@/components/SelectOrCustom";
import { CYBERWARE_SLOTS } from "@/lib/cyberwareOptions";
import {
  GUN_CATEGORIES,
  GUN_WEAPON_TYPES,
  GUN_POWER_LEVELS,
  FIRE_MODES,
  GUN_WEAPON_TYPE_ALIASES,
  GUN_POWER_LEVEL_ALIASES,
} from "@/components/catalog/gunTypes";

// CLOSE & APPLY dialog specialised for character sheets. When the sheet carries
// CUSTOM (non-catalog) cyberware or guns, the reviewer must supply the
// mechanical attributes here before the character is materialized — reaching
// parity with the standalone custom cyberware/gun request close flow. Catalog
// items auto-resolve server-side and are never prompted.
//
// Used in place of the generic CloseTicketDialog for subjectType==="sheet". The
// close mutation is owned by the caller so its onSuccess/onError + invalidation
// stay in one place.

type SheetCyberware = { slot?: string; name?: string; points?: number; notes?: string };

type CustomCyberRow = { index: number; name: string; cwp: string; slot: string };
type CustomGunRow = {
  index: number;
  name: string;
  category: string;
  weaponType: string;
  fireMode: string;
  powerLevel: string;
  manufacturer: string;
};

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

export function SheetCloseDialog({
  id,
  status,
  close,
  disabled,
  triggerClassName,
  onClosed,
}: {
  id: number;
  status: string;
  close: ReturnType<typeof useCloseReviewTicket>;
  disabled?: boolean;
  triggerClassName?: string;
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [cyberRows, setCyberRows] = useState<CustomCyberRow[]>([]);
  const [gunRows, setGunRows] = useState<CustomGunRow[]>([]);
  const pendingApply = status === "approved";
  const busy = close.isPending;

  // Only fetch the sheet + catalogs once the dialog is open and we actually need
  // to compute custom items (i.e. on an approved sheet awaiting apply).
  const enabled = open && pendingApply;
  const { data: sheet, isLoading: sheetLoading } = useGetSheet(id, {
    query: { enabled, queryKey: getGetSheetQueryKey(id) },
  });
  const { data: cyberCatalog } = useListCyberware({
    query: { enabled, queryKey: getListCyberwareQueryKey() },
  });
  const { data: gunCatalog } = useListGuns({
    query: { enabled, queryKey: getListGunsQueryKey() },
  });

  const cyberNameSet = useMemo(
    () => new Set((cyberCatalog ?? []).map((c) => norm(c.name))),
    [cyberCatalog],
  );
  const gunNameSet = useMemo(
    () => new Set((gunCatalog ?? []).map((g) => norm(g.name))),
    [gunCatalog],
  );

  // Derive the custom items from the sheet whenever the data (or catalogs) load.
  // Pre-fill cyberware CWP + slot from the player's typed values; guns have no
  // mechanical detail on the sheet so they start blank.
  useEffect(() => {
    if (!enabled || !sheet) return;
    const data = (sheet.data ?? {}) as unknown as Record<string, unknown>;
    const cw = (Array.isArray(data.cyberware) ? data.cyberware : []) as SheetCyberware[];
    const guns = (Array.isArray(data.guns) ? data.guns : []) as unknown[];

    const customCyber: CustomCyberRow[] = [];
    cw.forEach((item, index) => {
      const name = String(item?.name ?? "").trim() || String(item?.slot ?? "").trim();
      if (!name) return;
      if (cyberNameSet.has(norm(name))) return; // catalog → auto-resolves
      customCyber.push({
        index,
        name,
        cwp: item?.points != null ? String(item.points) : "",
        slot: String(item?.slot ?? "").trim(),
      });
    });

    const customGuns: CustomGunRow[] = [];
    guns.forEach((raw, index) => {
      const name = String(raw ?? "").trim();
      if (!name) return;
      if (gunNameSet.has(norm(name))) return; // catalog → auto-resolves
      customGuns.push({
        index,
        name,
        category: "",
        weaponType: "",
        fireMode: "",
        powerLevel: "",
        manufacturer: "",
      });
    });

    setCyberRows(customCyber);
    setGunRows(customGuns);
  }, [enabled, sheet, cyberNameSet, gunNameSet]);

  const hasCustom = cyberRows.length > 0 || gunRows.length > 0;
  const loading = enabled && (sheetLoading || !sheet);

  const cyberValid = cyberRows.every(
    (r) => r.cwp.trim() !== "" && Number(r.cwp) >= 0 && r.slot.trim() !== "",
  );
  const gunsValid = gunRows.every(
    (r) =>
      r.category.trim() !== "" &&
      r.weaponType.trim() !== "" &&
      r.fireMode.trim() !== "" &&
      r.powerLevel.trim() !== "",
  );
  const paramsValid = !loading && cyberValid && gunsValid;

  const setCyber = (index: number, patch: Partial<CustomCyberRow>) =>
    setCyberRows((rows) => rows.map((r) => (r.index === index ? { ...r, ...patch } : r)));
  const setGun = (index: number, patch: Partial<CustomGunRow>) =>
    setGunRows((rows) => rows.map((r) => (r.index === index ? { ...r, ...patch } : r)));

  const reset = () => {
    setNote("");
    setCyberRows([]);
    setGunRows([]);
  };

  const submit = () => {
    const trimmedNote = note.trim();
    const data: Record<string, unknown> = {};
    if (trimmedNote) data.note = trimmedNote;
    if (cyberRows.length > 0) {
      data.sheetCyberware = cyberRows.map((r) => ({
        index: r.index,
        cwp: Number(r.cwp) || 0,
        slot: r.slot.trim(),
      }));
    }
    if (gunRows.length > 0) {
      data.sheetGuns = gunRows.map((r) => ({
        index: r.index,
        category: r.category.trim(),
        weaponType: r.weaponType.trim(),
        fireMode: r.fireMode.trim(),
        powerLevel: r.powerLevel.trim(),
        ...(r.manufacturer.trim() ? { manufacturer: r.manufacturer.trim() } : {}),
      }));
    }
    close.mutate(
      { subjectType: "sheet", id, data: Object.keys(data).length ? data : undefined },
      {
        onSuccess: () => {
          setOpen(false);
          reset();
          onClosed?.();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return;
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          className={
            triggerClassName ??
            "rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
          }
          disabled={disabled}
          data-testid={`button-close-sheet-${id}`}
        >
          {pendingApply ? "CLOSE & APPLY" : "CLOSE TICKET"}
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none border-border bg-background sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan uppercase">
            {pendingApply ? "Close & apply" : "Close ticket"}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs leading-snug">
            {pendingApply
              ? "Finalizes the sheet and creates the character. Custom (non-catalog) cyberware and guns need their mechanical attributes before they can be added to the new character."
              : "Archives this sheet as resolved."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {loading ? (
            <p className="font-mono text-xs text-muted-foreground" data-testid="sheet-close-loading">
              Loading sheet…
            </p>
          ) : null}

          {!loading && pendingApply && hasCustom ? (
            <p
              className="font-mono text-[11px] text-nc-yellow leading-snug"
              data-testid="sheet-close-custom-hint"
            >
              This sheet has custom items not in the catalog. Set their attributes below before applying.
            </p>
          ) : null}

          {cyberRows.map((r) => (
            <div
              key={`cw-${r.index}`}
              className="space-y-3 border border-nc-magenta/40 bg-nc-magenta/5 p-3"
              data-testid={`sheet-close-cyber-${r.index}`}
            >
              <div className="font-display text-xs tracking-widest text-nc-magenta uppercase">
                Custom cyberware · {r.name}
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  CWP (chrome point cost)
                </Label>
                <Input
                  type="number"
                  min={0}
                  value={r.cwp}
                  onChange={(e) => setCyber(r.index, { cwp: e.target.value })}
                  placeholder="e.g. 2"
                  className="rounded-none font-mono"
                  data-testid={`input-sheet-close-cwp-${r.index}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  Slot (body system)
                </Label>
                <SelectOrCustom
                  value={r.slot}
                  onChange={(v) => setCyber(r.index, { slot: v })}
                  options={CYBERWARE_SLOTS}
                  allowEmpty={false}
                  placeholder="Select a slot…"
                  customPlaceholder="Custom slot"
                  testId={`select-sheet-close-slot-${r.index}`}
                />
              </div>
            </div>
          ))}

          {gunRows.map((r) => (
            <div
              key={`gun-${r.index}`}
              className="space-y-3 border border-nc-magenta/40 bg-nc-magenta/5 p-3"
              data-testid={`sheet-close-gun-${r.index}`}
            >
              <div className="font-display text-xs tracking-widest text-nc-magenta uppercase">
                Custom gun · {r.name}
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Category</Label>
                <SelectOrCustom
                  value={r.category}
                  onChange={(v) => setGun(r.index, { category: v })}
                  options={GUN_CATEGORIES}
                  allowEmpty={false}
                  placeholder="Power / Tech / Smart…"
                  customPlaceholder="Custom category"
                  testId={`select-sheet-close-gun-category-${r.index}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Weapon Type</Label>
                <SelectOrCustom
                  value={r.weaponType}
                  onChange={(v) => setGun(r.index, { weaponType: v })}
                  options={GUN_WEAPON_TYPES}
                  aliases={GUN_WEAPON_TYPE_ALIASES}
                  allowEmpty={false}
                  placeholder="Pistol / SMG / …"
                  customPlaceholder="Custom weapon type"
                  testId={`select-sheet-close-gun-type-${r.index}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Fire Mode</Label>
                <SelectOrCustom
                  value={r.fireMode}
                  onChange={(v) => setGun(r.index, { fireMode: v })}
                  options={FIRE_MODES}
                  allowEmpty={false}
                  placeholder="Semi-Auto / Burst / Full-Auto…"
                  customPlaceholder="Custom fire mode"
                  testId={`select-sheet-close-gun-fire-${r.index}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  Power Level (L/M/H)
                </Label>
                <SelectOrCustom
                  value={r.powerLevel}
                  onChange={(v) => setGun(r.index, { powerLevel: v })}
                  options={GUN_POWER_LEVELS}
                  aliases={GUN_POWER_LEVEL_ALIASES}
                  allowEmpty={false}
                  placeholder="L / M / H…"
                  customPlaceholder="Custom power level"
                  testId={`select-sheet-close-gun-power-${r.index}`}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                  Manufacturer (optional)
                </Label>
                <Input
                  value={r.manufacturer}
                  onChange={(e) => setGun(r.index, { manufacturer: e.target.value })}
                  placeholder="e.g. Militech"
                  className="rounded-none font-mono"
                  data-testid={`input-sheet-close-gun-manufacturer-${r.index}`}
                />
              </div>
            </div>
          ))}

          <div className="space-y-2">
            <Label
              htmlFor={`close-note-sheet-${id}`}
              className="text-[10px] uppercase tracking-widest font-display text-nc-cyan"
            >
              Closing note (optional)
            </Label>
            <Textarea
              id={`close-note-sheet-${id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              rows={3}
              className="rounded-none font-mono text-sm"
              placeholder="Optional note for the audit trail"
              data-testid={`input-close-note-sheet-${id}`}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="rounded-none font-display text-xs tracking-widest"
            disabled={busy}
            onClick={() => setOpen(false)}
            data-testid={`button-cancel-close-sheet-${id}`}
          >
            CANCEL
          </Button>
          <Button
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs tracking-widest"
            disabled={busy || !paramsValid}
            onClick={submit}
            data-testid={`button-confirm-close-sheet-${id}`}
          >
            {busy ? "WORKING..." : pendingApply ? "CLOSE & APPLY" : "CLOSE TICKET"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

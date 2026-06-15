import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateGun, useDeleteGun, getListGunsQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import GunFormFields from "./GunFormFields";
import {
  type Gun,
  formFromGun,
  formToPatch,
  humanize,
  canonicalLabel,
  FIRE_MODES,
  GUN_CATEGORIES,
  GUN_POWER_LEVELS,
  GUN_POWER_LEVEL_ALIASES,
  GUN_RESTRICTIONS,
  GUN_WEAPON_TYPES,
  GUN_WEAPON_TYPE_ALIASES,
} from "./gunTypes";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/30 py-2">
      <span className="text-[10px] uppercase tracking-widest text-nc-cyan font-display">
        {label}
      </span>
      <span className="font-mono text-sm text-right">{value}</span>
    </div>
  );
}

export default function GunDetailDialog({
  gun,
  isStaff,
  showPrice = true,
  open,
  onOpenChange,
}: {
  gun: Gun | null;
  isStaff: boolean;
  showPrice?: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  // Local copy of the weapon so the read-only view reflects saved edits
  // immediately, without waiting for the list query to refetch + reopen.
  const [current, setCurrent] = useState<Gun | null>(gun);
  const [form, setForm] = useState(() => (gun ? formFromGun(gun) : null));

  // Reset edit state whenever a different weapon is opened/closed.
  useEffect(() => {
    setEditing(false);
    setCurrent(gun);
    setForm(gun ? formFromGun(gun) : null);
  }, [gun]);

  const update = useUpdateGun({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListGunsQueryKey() });
        toast({ title: "Weapon updated" });
        // Reflect the saved values back as the new baseline, then exit edit.
        const saved = res as Gun;
        setCurrent(saved);
        setForm(formFromGun(saved));
        setEditing(false);
      },
      onError: (e: unknown) => {
        const msg = (e as { error?: string })?.error;
        toast({
          title: "Update failed",
          description: msg === "No changes" ? "No changes to save." : "Could not save the weapon.",
          variant: "destructive",
        });
      },
    },
  });

  const del = useDeleteGun({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListGunsQueryKey() });
        toast({ title: "Weapon deleted" });
        onOpenChange(false);
      },
      onError: () => toast({ title: "Could not delete the weapon.", variant: "destructive" }),
    },
  });

  if (!current) return null;

  const remove = () => {
    if (
      !window.confirm(
        `Delete "${current.name}" from the weapon catalog? This cannot be undone. Weapons already owned by characters are not affected.`,
      )
    )
      return;
    del.mutate({ id: current.id });
  };

  const save = () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const patch = formToPatch(form, current);
    if (Object.keys(patch).length === 0) {
      toast({ title: "No changes to save." });
      return;
    }
    update.mutate({ id: current.id, data: patch });
  };

  const status = (current.status ?? "live").toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            {editing ? "EDIT WEAPON" : current.name.toUpperCase()}
            {!editing && isStaff && status === "draft" && (
              <Badge
                variant="outline"
                className="rounded-none border-nc-yellow text-nc-yellow text-[9px] tracking-widest"
              >
                DRAFT
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            {editing
              ? "Changes apply immediately and are recorded in the audit log."
              : "Weapon registry entry."}
          </DialogDescription>
        </DialogHeader>

        {editing && form ? (
          <GunFormFields form={form} setForm={setForm as React.Dispatch<React.SetStateAction<typeof form>>} />
        ) : (
          <div className="space-y-1">
            {current.imageUrl && (
              <img
                src={current.imageUrl}
                alt={current.name}
                className="w-full max-h-72 object-contain border border-border bg-black/40 mb-3"
                data-testid="img-gun-detail"
              />
            )}
            <Row label="Manufacturer" value={humanize(current.manufacturer)} />
            <Row label="Category" value={canonicalLabel(current.category, GUN_CATEGORIES)} />
            <Row
              label="Weapon Type"
              value={canonicalLabel(current.weaponType, GUN_WEAPON_TYPES, GUN_WEAPON_TYPE_ALIASES)}
            />
            <Row label="Fire Mode" value={canonicalLabel(current.fireMode, FIRE_MODES)} />
            <Row
              label="Power Level"
              value={canonicalLabel(current.powerLevel, GUN_POWER_LEVELS, GUN_POWER_LEVEL_ALIASES)}
            />
            <Row
              label="Restriction"
              value={
                <span className="text-nc-magenta">
                  {canonicalLabel(current.restriction, GUN_RESTRICTIONS)}
                </span>
              }
            />
            {showPrice && (
              <Row
                label="Price"
                value={<span className="text-nc-yellow">{current.price.toLocaleString()} €$</span>}
              />
            )}
            {current.cyberwareReq && current.cyberwareReq.trim() && (
              <Row
                label="Requires"
                value={
                  <Badge
                    variant="outline"
                    className="rounded-none border-nc-magenta text-nc-magenta text-[10px] tracking-widest"
                  >
                    {current.cyberwareReq}
                  </Badge>
                }
              />
            )}
            {current.wikiUrl && current.wikiUrl.trim() && (
              <Row
                label="Wiki"
                value={
                  <a
                    href={current.wikiUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-nc-cyan underline hover:text-nc-cyan/80"
                    data-testid="link-gun-wiki"
                  >
                    Cyberpunk Wiki →
                  </a>
                }
              />
            )}
            {current.prefabThreadUrl && current.prefabThreadUrl.trim() && (
              <Row
                label="Prefab"
                value={
                  <a
                    href={current.prefabThreadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-nc-cyan underline hover:text-nc-cyan/80"
                    data-testid="link-gun-prefab"
                  >
                    Discord Thread →
                  </a>
                }
              />
            )}
            {isStaff && (
              <Row label="Status" value={humanize(current.status)} />
            )}
            {current.notes && current.notes.trim() && (
              <div className="pt-3">
                <div className="text-[10px] uppercase tracking-widest text-nc-cyan font-display mb-1">
                  Description / Notes
                </div>
                <p className="font-mono text-sm whitespace-pre-wrap text-muted-foreground">
                  {current.notes}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2 pt-4 border-t border-border mt-2">
          {!editing && isStaff && (
            <Button
              variant="ghost"
              className="rounded-none text-nc-magenta hover:text-nc-magenta hover:bg-nc-magenta/10"
              disabled={del.isPending}
              onClick={remove}
              data-testid="button-gun-delete"
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </Button>
          )}
          <div className="flex justify-end gap-2 ml-auto">
            {editing ? (
              <>
                <Button
                  variant="ghost"
                  className="rounded-none"
                  onClick={() => {
                    setEditing(false);
                    setForm(formFromGun(current));
                  }}
                  data-testid="button-gun-cancel-edit"
                >
                  Cancel
                </Button>
                <Button
                  className="rounded-none"
                  disabled={update.isPending}
                  onClick={save}
                  data-testid="button-gun-save"
                >
                  {update.isPending ? "Saving…" : "Save changes"}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  className="rounded-none"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-gun-close"
                >
                  Close
                </Button>
                {isStaff && (
                  <Button
                    className="rounded-none"
                    onClick={() => setEditing(true)}
                    data-testid="button-gun-edit"
                  >
                    Edit
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

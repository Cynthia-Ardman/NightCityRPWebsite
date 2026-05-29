import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateGun, getListGunsQueryKey } from "@workspace/api-client-react";
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
  open,
  onOpenChange,
}: {
  gun: Gun | null;
  isStaff: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => (gun ? formFromGun(gun) : null));

  // Reset edit state whenever a different weapon is opened/closed.
  useEffect(() => {
    setEditing(false);
    setForm(gun ? formFromGun(gun) : null);
  }, [gun]);

  const update = useUpdateGun({
    mutation: {
      onSuccess: (_res, vars) => {
        void qc.invalidateQueries({ queryKey: getListGunsQueryKey() });
        toast({ title: "Weapon updated" });
        // Reflect the saved values back as the new baseline, then exit edit.
        setEditing(false);
        void vars;
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

  if (!gun) return null;

  const save = () => {
    if (!form) return;
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    const patch = formToPatch(form, gun);
    if (Object.keys(patch).length === 0) {
      toast({ title: "No changes to save." });
      return;
    }
    update.mutate({ id: gun.id, data: patch });
  };

  const status = (gun.status ?? "live").toLowerCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            {editing ? "EDIT WEAPON" : gun.name.toUpperCase()}
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
            <Row label="Manufacturer" value={humanize(gun.manufacturer)} />
            <Row label="Category" value={humanize(gun.category)} />
            <Row label="Weapon Type" value={humanize(gun.weaponType)} />
            <Row label="Power Level" value={humanize(gun.powerLevel)} />
            <Row label="Restriction" value={<span className="text-nc-magenta">{humanize(gun.restriction)}</span>} />
            <Row label="Damage" value={humanize(gun.damage)} />
            <Row label="Mag Size" value={gun.magSize ?? "—"} />
            <Row
              label="Price"
              value={<span className="text-nc-yellow">{gun.price.toLocaleString()} €$</span>}
            />
            {isStaff && (
              <>
                <Row
                  label="Wholesale"
                  value={
                    <span className="text-nc-yellow">
                      {gun.wholesalePrice == null ? "—" : `${gun.wholesalePrice.toLocaleString()} €$`}
                    </span>
                  }
                />
                <Row label="Status" value={humanize(gun.status)} />
              </>
            )}
            {gun.notes && gun.notes.trim() && (
              <div className="pt-3">
                <div className="text-[10px] uppercase tracking-widest text-nc-cyan font-display mb-1">
                  Description / Notes
                </div>
                <p className="font-mono text-sm whitespace-pre-wrap text-muted-foreground">
                  {gun.notes}
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          {editing ? (
            <>
              <Button
                variant="ghost"
                className="rounded-none"
                onClick={() => {
                  setEditing(false);
                  setForm(formFromGun(gun));
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
      </DialogContent>
    </Dialog>
  );
}

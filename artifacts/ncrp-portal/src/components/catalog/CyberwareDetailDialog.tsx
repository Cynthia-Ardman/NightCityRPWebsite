import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateCyberware, useDeleteCyberware, getListCyberwareQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export type Cyber = {
  id: number;
  name: string;
  slot: string;
  humanityLoss: number;
  price: number;
  installCost?: number | null;
  description?: string | null;
  cwp?: string | null;
  wholesalePrice?: number | null;
};

type CyberForm = {
  name: string;
  slot: string;
  humanityLoss: string;
  cwp: string;
  price: string;
  wholesalePrice: string;
  installCost: string;
  description: string;
};

function formFromCyber(c: Cyber): CyberForm {
  return {
    name: c.name,
    slot: c.slot,
    humanityLoss: String(c.humanityLoss ?? 0),
    cwp: c.cwp ?? "",
    price: String(c.price ?? 0),
    wholesalePrice: c.wholesalePrice == null ? "" : String(c.wholesalePrice),
    installCost: c.installCost == null ? "" : String(c.installCost),
    description: c.description ?? "",
  };
}

// Build a minimal patch of only the fields that actually changed, coercing
// the string-backed inputs to the int/text shapes the API expects.
function formToPatch(form: CyberForm, cur: Cyber): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const name = form.name.trim();
  if (name !== cur.name) patch.name = name;
  const slot = form.slot.trim();
  if (slot !== cur.slot) patch.slot = slot;

  const hl = Math.max(0, Math.trunc(Number(form.humanityLoss) || 0));
  if (hl !== (cur.humanityLoss ?? 0)) patch.humanityLoss = hl;

  const price = Math.max(0, Math.trunc(Number(form.price) || 0));
  if (price !== (cur.price ?? 0)) patch.price = price;

  const cwp = form.cwp.trim() || null;
  if (cwp !== (cur.cwp ?? null)) patch.cwp = cwp;

  const wholesale = form.wholesalePrice.trim() === "" ? null : Math.max(0, Math.trunc(Number(form.wholesalePrice) || 0));
  if (wholesale !== (cur.wholesalePrice ?? null)) patch.wholesalePrice = wholesale;

  const install = form.installCost.trim() === "" ? null : Math.max(0, Math.trunc(Number(form.installCost) || 0));
  if (install !== (cur.installCost ?? null)) patch.installCost = install;

  const desc = form.description.trim() || null;
  if (desc !== (cur.description ?? null)) patch.description = desc;

  return patch;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border/30 py-2">
      <span className="text-[10px] uppercase tracking-widest text-nc-cyan font-display">{label}</span>
      <span className="font-mono text-sm text-right">{value}</span>
    </div>
  );
}

export default function CyberwareDetailDialog({
  cyber,
  isStaff,
  open,
  onOpenChange,
}: {
  cyber: Cyber | null;
  isStaff: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<Cyber | null>(cyber);
  const [form, setForm] = useState<CyberForm | null>(() => (cyber ? formFromCyber(cyber) : null));

  useEffect(() => {
    setEditing(false);
    setCurrent(cyber);
    setForm(cyber ? formFromCyber(cyber) : null);
  }, [cyber]);

  const update = useUpdateCyberware({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListCyberwareQueryKey() });
        toast({ title: "Cyberware updated" });
        const saved = res as Cyber;
        setCurrent(saved);
        setForm(formFromCyber(saved));
        setEditing(false);
      },
      onError: (e: unknown) => {
        const msg = (e as { error?: string })?.error;
        toast({
          title: "Update failed",
          description: msg === "No changes" ? "No changes to save." : "Could not save the cyberware.",
          variant: "destructive",
        });
      },
    },
  });

  const del = useDeleteCyberware({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListCyberwareQueryKey() });
        toast({ title: "Cyberware deleted" });
        onOpenChange(false);
      },
      onError: () => toast({ title: "Could not delete the cyberware.", variant: "destructive" }),
    },
  });

  if (!current) return null;

  const remove = () => {
    if (
      !window.confirm(
        `Delete "${current.name}" from the cyberware catalog? This cannot be undone. Cyberware already installed on characters is not affected.`,
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
    if (!form.slot.trim()) {
      toast({ title: "Slot is required", variant: "destructive" });
      return;
    }
    const patch = formToPatch(form, current);
    if (Object.keys(patch).length === 0) {
      toast({ title: "No changes to save." });
      return;
    }
    update.mutate({ id: current.id, data: patch });
  };

  const set = (k: keyof CyberForm, v: string) =>
    setForm((prev) => (prev ? { ...prev, [k]: v } : prev));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">
            {editing ? "EDIT CYBERWARE" : current.name.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            {editing
              ? "Changes apply immediately and are recorded in the audit log."
              : "Cyberware registry entry."}
          </DialogDescription>
        </DialogHeader>

        {editing && form ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Name</Label>
              <Input
                className="rounded-none font-mono"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                data-testid="input-cyberware-name"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Slot</Label>
              <Input
                className="rounded-none font-mono"
                value={form.slot}
                onChange={(e) => set("slot", e.target.value)}
                data-testid="input-cyberware-slot"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">CWP</Label>
              <Input
                className="rounded-none font-mono"
                value={form.cwp}
                onChange={(e) => set("cwp", e.target.value)}
                data-testid="input-cyberware-cwp"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Price (€$)</Label>
              <Input
                type="number"
                className="rounded-none font-mono"
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
                data-testid="input-cyberware-price"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Install Cost (€$)</Label>
              <Input
                type="number"
                className="rounded-none font-mono"
                value={form.installCost}
                onChange={(e) => set("installCost", e.target.value)}
                data-testid="input-cyberware-install"
              />
            </div>
            <div className="col-span-2">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
              <Textarea
                className="rounded-none font-mono"
                rows={3}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                data-testid="input-cyberware-description"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <Row label="Slot" value={current.slot} />
            <Row label="CWP" value={current.cwp ?? "—"} />
            <Row
              label="Price"
              value={<span className="text-nc-yellow">{current.price.toLocaleString()} €$</span>}
            />
            <Row
              label="Install Cost"
              value={current.installCost == null ? "Ripperdoc determined" : `${current.installCost.toLocaleString()} €$`}
            />
            {current.description && current.description.trim() && (
              <div className="pt-3">
                <div className="text-[10px] uppercase tracking-widest text-nc-cyan font-display mb-1">
                  Description
                </div>
                <p className="font-mono text-sm whitespace-pre-wrap text-muted-foreground">
                  {current.description}
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
              data-testid="button-cyberware-delete"
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
                    setForm(formFromCyber(current));
                  }}
                  data-testid="button-cyberware-cancel-edit"
                >
                  Cancel
                </Button>
                <Button
                  className="rounded-none"
                  disabled={update.isPending}
                  onClick={save}
                  data-testid="button-cyberware-save"
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
                  data-testid="button-cyberware-close"
                >
                  Close
                </Button>
                {isStaff && (
                  <Button
                    className="rounded-none"
                    onClick={() => setEditing(true)}
                    data-testid="button-cyberware-edit"
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

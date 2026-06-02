import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateCyberware, getListCyberwareQueryKey } from "@workspace/api-client-react";
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

type CyberCreateForm = {
  name: string;
  slot: string;
  humanityLoss: string;
  cwp: string;
  price: string;
  wholesalePrice: string;
  installCost: string;
  description: string;
};

function emptyForm(): CyberCreateForm {
  return {
    name: "",
    slot: "",
    humanityLoss: "0",
    cwp: "",
    price: "0",
    wholesalePrice: "",
    installCost: "",
    description: "",
  };
}

function textOrNull(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

function intOrNull(s: string): number | null {
  const t = s.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export default function CyberwareCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    if (open) setForm(emptyForm());
  }, [open]);

  const set = <K extends keyof CyberCreateForm>(key: K, value: CyberCreateForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const create = useCreateCyberware({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListCyberwareQueryKey() });
        toast({ title: "Cyberware created", description: `${res.name} added to the catalog.` });
        onOpenChange(false);
      },
      onError: () => {
        toast({
          title: "Create failed",
          description: "Could not create the cyberware.",
          variant: "destructive",
        });
      },
    },
  });

  const canSave = !!form.name.trim() && !!form.slot.trim();

  const save = () => {
    if (!canSave) {
      toast({ title: "Name and slot are required", variant: "destructive" });
      return;
    }
    create.mutate({
      data: {
        name: form.name.trim(),
        slot: form.slot.trim(),
        humanityLoss: intOrNull(form.humanityLoss) ?? 0,
        cwp: textOrNull(form.cwp),
        price: intOrNull(form.price) ?? 0,
        wholesalePrice: intOrNull(form.wholesalePrice),
        installCost: intOrNull(form.installCost),
        description: textOrNull(form.description),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-magenta/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-magenta">
            ADD NEW CYBERWARE
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Add an augmentation to the server cyberware catalog.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name *">
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-name"
              />
            </Field>
            <Field label="Slot *">
              <Input
                value={form.slot}
                onChange={(e) => set("slot", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-slot"
              />
            </Field>
            <Field label="Humanity Loss">
              <Input
                type="number"
                value={form.humanityLoss}
                onChange={(e) => set("humanityLoss", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-humanityLoss"
              />
            </Field>
            <Field label="CWP">
              <Input
                value={form.cwp}
                onChange={(e) => set("cwp", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-cwp"
              />
            </Field>
            <Field label="Price (€$)">
              <Input
                type="number"
                value={form.price}
                onChange={(e) => set("price", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-price"
              />
            </Field>
            <Field label="Wholesale Price (€$)">
              <Input
                type="number"
                value={form.wholesalePrice}
                onChange={(e) => set("wholesalePrice", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-wholesalePrice"
              />
            </Field>
            <Field label="Install Cost (€$)">
              <Input
                type="number"
                value={form.installCost}
                onChange={(e) => set("installCost", e.target.value)}
                className="rounded-none"
                data-testid="input-cyberware-installCost"
              />
            </Field>
          </div>

          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="rounded-none font-mono text-sm"
              rows={4}
              data-testid="input-cyberware-description"
            />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          <Button
            variant="ghost"
            className="rounded-none"
            onClick={() => onOpenChange(false)}
            data-testid="button-cyberware-create-cancel"
          >
            Cancel
          </Button>
          <Button
            className="rounded-none"
            disabled={create.isPending || !canSave}
            onClick={save}
            data-testid="button-cyberware-create-save"
          >
            {create.isPending ? "Creating…" : "Create cyberware"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

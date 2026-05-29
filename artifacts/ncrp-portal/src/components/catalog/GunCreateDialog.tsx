import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCreateGun, getListGunsQueryKey } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import GunFormFields from "./GunFormFields";
import { emptyForm, formToCreatePayload } from "./gunTypes";

export default function GunCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);

  // Start from a fresh blank form each time the dialog opens.
  useEffect(() => {
    if (open) setForm(emptyForm());
  }, [open]);

  const create = useCreateGun({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListGunsQueryKey() });
        toast({
          title: "Weapon created",
          description: `${res.name} saved as ${(res.status ?? "draft").toUpperCase()}.`,
        });
        onOpenChange(false);
      },
      onError: () => {
        toast({
          title: "Create failed",
          description: "Could not create the weapon.",
          variant: "destructive",
        });
      },
    },
  });

  const save = () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    create.mutate({ data: formToCreatePayload(form) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-magenta/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-magenta">
            ADD NEW WEAPON
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            New weapons default to DRAFT — staff-only until you promote them to live.
          </DialogDescription>
        </DialogHeader>

        <GunFormFields form={form} setForm={setForm} />

        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          <Button
            variant="ghost"
            className="rounded-none"
            onClick={() => onOpenChange(false)}
            data-testid="button-gun-create-cancel"
          >
            Cancel
          </Button>
          <Button
            className="rounded-none"
            disabled={create.isPending || !form.name.trim()}
            onClick={save}
            data-testid="button-gun-create-save"
          >
            {create.isPending ? "Creating…" : "Create weapon"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

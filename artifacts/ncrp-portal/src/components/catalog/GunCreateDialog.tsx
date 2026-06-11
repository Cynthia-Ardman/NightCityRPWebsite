import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateGun,
  useCreateCustomGun,
  getListGunsQueryKey,
  getListCustomCatalogItemsQueryKey,
} from "@workspace/api-client-react";
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
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import { useToast } from "@/hooks/use-toast";
import GunFormFields from "./GunFormFields";
import SingleImageField from "./SingleImageField";
import { emptyForm, formToCreatePayload } from "./gunTypes";

type Mode = "catalog" | "custom";

export default function GunCreateDialog({
  open,
  onOpenChange,
  onCustomCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCustomCreated?: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>("catalog");
  const [form, setForm] = useState(emptyForm());

  // Custom-grant form: a bespoke gun bound to one character.
  const [customChar, setCustomChar] = useState<CharacterPickerValue>(null);
  const [customName, setCustomName] = useState("");
  const [customDesc, setCustomDesc] = useState("");
  const [customImage, setCustomImage] = useState("");

  // Start from a fresh blank form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setMode("catalog");
      setForm(emptyForm());
      setCustomChar(null);
      setCustomName("");
      setCustomDesc("");
      setCustomImage("");
    }
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

  const createCustom = useCreateCustomGun({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({
          queryKey: getListCustomCatalogItemsQueryKey({ type: "gun" }),
        });
        toast({
          title: "Custom gun granted",
          description: `${res.title} granted to ${res.characterName ?? "the character"}.`,
        });
        onOpenChange(false);
        onCustomCreated?.();
      },
      onError: () => {
        toast({
          title: "Grant failed",
          description: "Could not grant the custom gun.",
          variant: "destructive",
        });
      },
    },
  });

  const pending = create.isPending || createCustom.isPending;
  const canSave =
    mode === "catalog" ? form.name.trim().length > 0 : !!customChar && customName.trim().length > 0;

  const save = () => {
    if (mode === "catalog") {
      if (!form.name.trim()) {
        toast({ title: "Name is required", variant: "destructive" });
        return;
      }
      create.mutate({ data: formToCreatePayload(form) });
      return;
    }
    if (!customChar) {
      toast({ title: "Pick a character", variant: "destructive" });
      return;
    }
    if (!customName.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    createCustom.mutate({
      data: {
        characterId: customChar.id,
        name: customName.trim(),
        description: customDesc.trim() || null,
        imageUrl: customImage.trim() || null,
      },
    });
  };

  const modeBtn = (m: Mode, label: string) => (
    <button
      key={m}
      type="button"
      onClick={() => setMode(m)}
      className={`px-4 py-2 border font-display text-xs uppercase tracking-widest ${
        mode === m
          ? "border-nc-magenta text-nc-magenta bg-nc-magenta/10"
          : "border-border text-muted-foreground hover:border-nc-magenta/40"
      }`}
      data-testid={`toggle-gun-mode-${m}`}
    >
      {label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-magenta/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-magenta">
            ADD NEW WEAPON
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            {mode === "catalog"
              ? "CATALOG: a purchasable registry entry. New weapons default to DRAFT — staff-only until you promote them to live."
              : "CUSTOM: grant a one-off bespoke gun straight to a character's inventory (auto-approved, no vote). It shows in the CUSTOM tab."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-2">
          {modeBtn("catalog", "Catalog")}
          {modeBtn("custom", "Custom")}
        </div>

        {mode === "catalog" ? (
          <GunFormFields form={form} setForm={setForm} />
        ) : (
          <div className="space-y-5">
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Owning Character *
              </Label>
              <CharacterPicker
                value={customChar}
                onChange={setCustomChar}
                scope="all"
                placeholder="Search by character or player name…"
                testId="input-custom-gun-character"
              />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Name *
              </Label>
              <Input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="rounded-none"
                placeholder="e.g. Custom Malorian Arms 3516"
                data-testid="input-custom-gun-name"
              />
            </div>
            <div>
              <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Description / Notes
              </Label>
              <Textarea
                value={customDesc}
                onChange={(e) => setCustomDesc(e.target.value)}
                className="rounded-none font-mono text-sm"
                rows={4}
                data-testid="input-custom-gun-notes"
              />
            </div>
            <SingleImageField
              label="Image"
              value={customImage}
              onChange={setCustomImage}
              testIdPrefix="custom-gun-image"
            />
          </div>
        )}

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
            disabled={pending || !canSave}
            onClick={save}
            data-testid="button-gun-create-save"
          >
            {pending
              ? mode === "catalog"
                ? "Creating…"
                : "Granting…"
              : mode === "catalog"
                ? "Create weapon"
                : "Grant custom gun"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateRentListing,
  useListDistricts,
  useCreateDistrict,
  getListRentListingsQueryKey,
  getListDistrictsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import SingleImageField from "./SingleImageField";

const KINDS = ["residential", "business"] as const;
type Kind = (typeof KINDS)[number];

const CUSTOM_DISTRICT = "__custom__";
const CUSTOM_TIER = "Custom";

// Tier → monthly rent, keyed by property kind. Custom is manual-entry only.
const TIER_RENTS: Record<Kind, Record<string, number>> = {
  residential: { T1: 1500, T2: 2000, T3: 3000 },
  business: { T0: 0, T1: 2000, T2: 3000, T3: 5000 },
};

function tierOptions(kind: Kind): string[] {
  return [...Object.keys(TIER_RENTS[kind]), CUSTOM_TIER];
}

type RentCreateForm = {
  name: string;
  kind: Kind;
  district: string;
  districtIsCustom: boolean;
  tier: string;
  monthlyRent: string;
  description: string;
  imageUrl: string;
};

function emptyForm(): RentCreateForm {
  return {
    name: "",
    kind: "residential",
    district: "",
    districtIsCustom: false,
    tier: "",
    monthlyRent: "0",
    description: "",
    imageUrl: "",
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

export default function RentCreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const { data: districts } = useListDistricts();

  const isCustomTier = form.tier === CUSTOM_TIER;
  const tiers = useMemo(() => tierOptions(form.kind), [form.kind]);

  useEffect(() => {
    if (open) setForm(emptyForm());
  }, [open]);

  const set = <K extends keyof RentCreateForm>(key: K, value: RentCreateForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Switching kind resets the tier (T-numbers differ) and the derived rent.
  const onKindChange = (k: Kind) =>
    setForm((f) => ({ ...f, kind: k, tier: "", monthlyRent: "0" }));

  // Picking a non-custom tier auto-fills the rent (read-only); Custom unlocks it.
  const onTierChange = (tier: string) =>
    setForm((f) => {
      if (tier === CUSTOM_TIER) return { ...f, tier };
      const rent = TIER_RENTS[f.kind][tier];
      return { ...f, tier, monthlyRent: rent == null ? f.monthlyRent : String(rent) };
    });

  const onDistrictSelect = (value: string) => {
    if (value === CUSTOM_DISTRICT) {
      setForm((f) => ({ ...f, districtIsCustom: true, district: "" }));
    } else {
      setForm((f) => ({ ...f, districtIsCustom: false, district: value }));
    }
  };

  const addDistrict = useCreateDistrict({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListDistrictsQueryKey() });
        setForm((f) => ({ ...f, districtIsCustom: false, district: res.name }));
        toast({ title: "District added", description: `${res.name} is now in the list.` });
      },
      onError: () =>
        toast({ title: "Could not add district", variant: "destructive" }),
    },
  });

  const create = useCreateRentListing({
    mutation: {
      onSuccess: (res) => {
        void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
        toast({ title: "Property created", description: `${res.name} added to the catalog.` });
        onOpenChange(false);
      },
      onError: () => {
        toast({
          title: "Create failed",
          description: "Could not create the property.",
          variant: "destructive",
        });
      },
    },
  });

  const canSave = !!form.name.trim();

  const save = () => {
    if (!canSave) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    create.mutate({
      data: {
        name: form.name.trim(),
        kind: form.kind,
        district: textOrNull(form.district),
        tier: textOrNull(form.tier),
        monthlyRent: intOrNull(form.monthlyRent) ?? 0,
        description: textOrNull(form.description),
        imageUrl: textOrNull(form.imageUrl),
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-magenta/40 bg-card max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-magenta">
            ADD NEW PROPERTY
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Add a housing or business property to the server catalog.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Type">
            <div className="flex gap-2 flex-wrap">
              {KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => onKindChange(k)}
                  className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                    form.kind === k
                      ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                      : "border-border text-muted-foreground hover:border-nc-cyan/40"
                  }`}
                  data-testid={`toggle-rent-kind-${k}`}
                >
                  {k === "residential" ? "Housing" : "Business"}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Name *">
              <Input
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                className="rounded-none"
                data-testid="input-rent-name"
              />
            </Field>
            <Field label="District">
              <Select
                value={form.districtIsCustom ? CUSTOM_DISTRICT : form.district || undefined}
                onValueChange={onDistrictSelect}
              >
                <SelectTrigger className="rounded-none" data-testid="select-rent-district">
                  <SelectValue placeholder="Select district" />
                </SelectTrigger>
                <SelectContent>
                  {(districts ?? []).map((d) => (
                    <SelectItem key={d.id} value={d.name}>
                      {d.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_DISTRICT}>Custom / off-map…</SelectItem>
                </SelectContent>
              </Select>
              {form.districtIsCustom && (
                <div className="flex gap-2 mt-2">
                  <Input
                    value={form.district}
                    onChange={(e) => set("district", e.target.value)}
                    placeholder="District name"
                    className="rounded-none"
                    data-testid="input-rent-district-custom"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-none whitespace-nowrap"
                    disabled={!form.district.trim() || addDistrict.isPending}
                    onClick={() => addDistrict.mutate({ data: { name: form.district.trim() } })}
                    data-testid="button-rent-district-add"
                    title="Save this district to the managed list"
                  >
                    + Add to list
                  </Button>
                </div>
              )}
            </Field>
            <Field label="Tier">
              <Select value={form.tier || undefined} onValueChange={onTierChange}>
                <SelectTrigger className="rounded-none" data-testid="select-rent-tier">
                  <SelectValue placeholder="Select tier" />
                </SelectTrigger>
                <SelectContent>
                  {tiers.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Rent / month (€$)">
              <Input
                type="number"
                value={form.monthlyRent}
                onChange={(e) => set("monthlyRent", e.target.value)}
                className="rounded-none"
                readOnly={!!form.tier && !isCustomTier}
                data-testid="input-rent-monthlyRent"
              />
              {!!form.tier && !isCustomTier && (
                <p className="text-[10px] font-mono text-muted-foreground mt-1">
                  Auto-set by tier. Choose “Custom” to enter a manual rent.
                </p>
              )}
            </Field>
          </div>

          <Field label="Description">
            <Textarea
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              className="rounded-none font-mono text-sm"
              rows={4}
              data-testid="input-rent-description"
            />
          </Field>

          <SingleImageField
            label="Image"
            value={form.imageUrl}
            onChange={(v) => set("imageUrl", v)}
            testIdPrefix="rent-image"
          />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          <Button
            variant="ghost"
            className="rounded-none"
            onClick={() => onOpenChange(false)}
            data-testid="button-rent-create-cancel"
          >
            Cancel
          </Button>
          <Button
            className="rounded-none"
            disabled={create.isPending || !canSave}
            onClick={save}
            data-testid="button-rent-create-save"
          >
            {create.isPending ? "Creating…" : "Create property"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

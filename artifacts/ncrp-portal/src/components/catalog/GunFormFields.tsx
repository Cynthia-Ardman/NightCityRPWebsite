import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import SelectOrCustom from "@/components/SelectOrCustom";
import SingleImageField from "./SingleImageField";
import {
  FIRE_MODES,
  GUN_CATEGORIES,
  GUN_POWER_LEVELS,
  GUN_POWER_LEVEL_ALIASES,
  GUN_RESTRICTIONS,
  GUN_STATUSES,
  GUN_WEAPON_TYPES,
  GUN_WEAPON_TYPE_ALIASES,
  type GunFormState,
  type GunStatus,
} from "./gunTypes";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

// The shared set of editable inputs used by both the create and edit dialogs.
export default function GunFormFields({
  form,
  setForm,
}: {
  form: GunFormState;
  setForm: React.Dispatch<React.SetStateAction<GunFormState>>;
}) {
  const set = <K extends keyof GunFormState>(key: K, value: GunFormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Name *">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-name"
          />
        </Field>
        <Field label="Manufacturer">
          <Input
            value={form.manufacturer}
            onChange={(e) => set("manufacturer", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-manufacturer"
          />
        </Field>
      </div>

      <Field label="Status">
        <div className="flex gap-2 flex-wrap">
          {GUN_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => set("status", s as GunStatus)}
              className={`px-3 py-2 border font-display text-xs uppercase tracking-widest ${
                form.status === s
                  ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
                  : "border-border text-muted-foreground hover:border-nc-cyan/40"
              }`}
              data-testid={`toggle-gun-status-${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Category">
          <SelectOrCustom
            value={form.category}
            onChange={(v) => set("category", v)}
            options={GUN_CATEGORIES}
            placeholder="Select category…"
            testId="input-gun-category"
          />
        </Field>
        <Field label="Weapon Type">
          <SelectOrCustom
            value={form.weaponType}
            onChange={(v) => set("weaponType", v)}
            options={GUN_WEAPON_TYPES}
            aliases={GUN_WEAPON_TYPE_ALIASES}
            placeholder="Select weapon type…"
            testId="input-gun-weaponType"
          />
        </Field>
        <Field label="Fire Mode">
          <SelectOrCustom
            value={form.fireMode}
            onChange={(v) => set("fireMode", v)}
            options={FIRE_MODES}
            placeholder="Select fire mode…"
            testId="input-gun-fireMode"
          />
        </Field>
        <Field label="Power Level">
          <SelectOrCustom
            value={form.powerLevel}
            onChange={(v) => set("powerLevel", v)}
            options={GUN_POWER_LEVELS}
            aliases={GUN_POWER_LEVEL_ALIASES}
            placeholder="Select power level…"
            testId="input-gun-powerLevel"
          />
        </Field>
        <Field label="Restriction">
          <SelectOrCustom
            value={form.restriction}
            onChange={(v) => set("restriction", v)}
            options={GUN_RESTRICTIONS}
            placeholder="Select restriction…"
            testId="input-gun-restriction"
          />
        </Field>
      </div>

      <Field label="Price (€$)">
        <Input
          type="number"
          value={form.price}
          onChange={(e) => set("price", e.target.value)}
          className="rounded-none"
          data-testid="input-gun-price"
        />
      </Field>

      <Field label="Description / Notes">
        <Textarea
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          className="rounded-none font-mono text-sm"
          rows={4}
          data-testid="input-gun-notes"
        />
      </Field>

      <SingleImageField
        label="Image"
        value={form.imageUrl}
        onChange={(v) => set("imageUrl", v)}
        testIdPrefix="gun-image"
      />
    </div>
  );
}

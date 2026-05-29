import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GUN_STATUSES, type GunFormState, type GunStatus } from "./gunTypes";

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
          <Input
            value={form.category}
            onChange={(e) => set("category", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-category"
          />
        </Field>
        <Field label="Weapon Type">
          <Input
            value={form.weaponType}
            onChange={(e) => set("weaponType", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-weaponType"
          />
        </Field>
        <Field label="Power Level">
          <Input
            value={form.powerLevel}
            onChange={(e) => set("powerLevel", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-powerLevel"
          />
        </Field>
        <Field label="Restriction">
          <Input
            value={form.restriction}
            onChange={(e) => set("restriction", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-restriction"
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Price (€$)">
          <Input
            type="number"
            value={form.price}
            onChange={(e) => set("price", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-price"
          />
        </Field>
        <Field label="Wholesale (€$, staff)">
          <Input
            type="number"
            value={form.wholesalePrice}
            onChange={(e) => set("wholesalePrice", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-wholesalePrice"
          />
        </Field>
        <Field label="Mag Size">
          <Input
            type="number"
            value={form.magSize}
            onChange={(e) => set("magSize", e.target.value)}
            className="rounded-none"
            data-testid="input-gun-magSize"
          />
        </Field>
      </div>

      <Field label="Damage">
        <Input
          value={form.damage}
          onChange={(e) => set("damage", e.target.value)}
          className="rounded-none"
          data-testid="input-gun-damage"
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
    </div>
  );
}

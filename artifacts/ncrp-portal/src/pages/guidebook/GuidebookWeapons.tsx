import { useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateGunMechanicsOverrides,
  getGetGunMechanicsOverridesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Crosshair, Pencil } from "lucide-react";
import {
  GUN_CATEGORY_INFO,
  GUN_POWER_INFO,
  GUN_RESTRICTION_INFO,
  GUN_POWER_COLORS,
  GUN_CALIBERS,
  GUN_MISC_RULES,
  categoryInfo,
  powerInfo,
  restrictionInfo,
  calibersFor,
  miscRules,
  type GunMechanicsOverrides,
} from "@/components/catalog/gunMechanics";
import { useGunMechanicsOverrides } from "@/components/catalog/useGunMechanics";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

const CATEGORY_ORDER = ["Power", "Tech", "Smart"] as const;
const TIER_ORDER = ["L", "M", "H"] as const;
const RESTRICTION_ORDER = ["Basic", "Controlled", "Restricted"] as const;

// Reference page describing how guns work in-game. This is a code-defined
// guidebook page: structure and defaults live in the shared gunMechanics
// module (same source as the catalog hover blurbs, so wording can't drift),
// while admins can override any piece of the text via the EDIT dialog — the
// overrides feed BOTH this page and the catalog hovers.
export default function GuidebookWeapons() {
  const { data: me } = useEffectiveMe();
  const overrides = useGunMechanicsOverrides();
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href="/guidebook">
        <Button
          variant="ghost"
          className="rounded-none font-mono text-xs text-muted-foreground -ml-2"
          data-testid="link-guidebook-back"
        >
          <ArrowLeft className="w-4 h-4 mr-1" /> GUIDEBOOK
        </Button>
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1
            className="text-4xl font-display flex items-center gap-3"
            data-testid="text-guidebook-weapons-title"
          >
            <Crosshair className="w-8 h-8 text-nc-cyan" /> WEAPONS &amp; GUNS
          </h1>
          <p className="font-mono text-sm text-muted-foreground mt-2">
            How guns work in Night City — types, power tiers, restrictions and
            calibers. Hover the Category and Power Level columns on the gun catalog
            to see the matching note for any weapon.
          </p>
        </div>
        {me?.isAdmin && (
          <Button
            className="rounded-none bg-nc-cyan text-background font-display shrink-0"
            onClick={() => setEditOpen(true)}
            data-testid="button-weapons-edit"
          >
            <Pencil className="w-4 h-4 mr-2" /> EDIT
          </Button>
        )}
      </div>

      {/* Gun types */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">TYPES</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {CATEGORY_ORDER.map((key) => {
            const info = categoryInfo(key, overrides)!;
            return (
              <div key={key} data-testid={`weapons-type-${key}`}>
                <div className="font-display text-lg text-nc-cyan tracking-wider">
                  {info.label.toUpperCase()}
                </div>
                <p className="font-mono text-sm text-foreground/90">{info.blurb}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Power levels + color codes */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">POWER LEVELS</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {TIER_ORDER.map((tier) => {
            const info = powerInfo(tier, overrides)!;
            return (
              <div key={tier} data-testid={`weapons-power-${tier}`}>
                <div className="flex items-center gap-3">
                  <span className="font-display text-lg text-foreground tracking-wider">
                    {info.label.toUpperCase()}
                  </span>
                  <span className="flex items-center gap-2">
                    <Swatch color={GUN_POWER_COLORS.power[tier]} title="Power" />
                    <Swatch color={GUN_POWER_COLORS.techSmart[tier]} title="Tech / Smart" />
                  </span>
                </div>
                <p className="font-mono text-sm text-foreground/90 mt-1">{info.blurb}</p>
              </div>
            );
          })}
          <p className="font-mono text-[11px] text-muted-foreground">
            Color codes mark a gun's power tier: warm tones (yellow → orange →
            red) for Power guns, cool tones (cyan → blue → purple) for Tech and
            Smart guns.
          </p>
        </CardContent>
      </Card>

      {/* Restrictions */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">RESTRICTIONS</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {RESTRICTION_ORDER.map((key) => {
            const info = restrictionInfo(key, overrides)!;
            return (
              <div key={key} data-testid={`weapons-restriction-${key}`}>
                <div className="font-display text-lg text-nc-magenta tracking-wider">
                  {info.label.toUpperCase()}
                </div>
                <p className="font-mono text-sm text-foreground/90">{info.blurb}</p>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Calibers */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">CALIBER EXAMPLES</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TIER_ORDER.map((tier) => (
            <div key={tier} data-testid={`weapons-caliber-${tier}`}>
              <div className="font-display text-sm text-nc-cyan tracking-widest mb-2">
                {GUN_POWER_INFO[tier].label.toUpperCase()}
              </div>
              <ul className="font-mono text-sm text-foreground/90 space-y-1">
                {calibersFor(tier, overrides).map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Misc rules */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">MISC RULES</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="font-mono text-sm text-foreground/90 space-y-3 list-disc pl-5">
            {miscRules(overrides).map((rule, i) => (
              <li key={i} data-testid={`weapons-rule-${i}`}>
                {rule}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {me?.isAdmin && editOpen && (
        <WeaponsEditDialog overrides={overrides} onClose={() => setEditOpen(false)} />
      )}
    </div>
  );
}

// Admin editor: every field is prefilled with the EFFECTIVE text (override or
// default). On save we only store fields whose text differs from the code
// default, so untouched copy keeps tracking future default updates.
function WeaponsEditDialog({
  overrides,
  onClose,
}: {
  overrides: GunMechanicsOverrides;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const [cats, setCats] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      CATEGORY_ORDER.map((k) => [k, overrides.categories?.[k] ?? GUN_CATEGORY_INFO[k].blurb]),
    ),
  );
  const [pows, setPows] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      TIER_ORDER.map((k) => [k, overrides.powers?.[k] ?? GUN_POWER_INFO[k].blurb]),
    ),
  );
  const [rests, setRests] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      RESTRICTION_ORDER.map((k) => [
        k,
        overrides.restrictions?.[k] ?? GUN_RESTRICTION_INFO[k].blurb,
      ]),
    ),
  );
  const [cals, setCals] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      TIER_ORDER.map((k) => [k, (overrides.calibers?.[k] ?? GUN_CALIBERS[k]).join("\n")]),
    ),
  );
  const [rules, setRules] = useState<string>(() =>
    (overrides.miscRules ?? GUN_MISC_RULES).join("\n"),
  );

  const save = useUpdateGunMechanicsOverrides({
    mutation: {
      onSuccess: async () => {
        await qc.invalidateQueries({ queryKey: getGetGunMechanicsOverridesQueryKey() });
        onClose();
      },
      onError: (err) => {
        setError(apiErrorMessage(err, String(err)));
      },
    },
  });

  const onSave = () => {
    const next: GunMechanicsOverrides = {};
    for (const k of CATEGORY_ORDER) {
      const v = cats[k].trim();
      if (!v) {
        setError(`The ${k} blurb can't be empty.`);
        return;
      }
      if (v !== GUN_CATEGORY_INFO[k].blurb) (next.categories ??= {})[k] = v;
    }
    for (const k of TIER_ORDER) {
      const v = pows[k].trim();
      if (!v) {
        setError(`The ${GUN_POWER_INFO[k].label} power blurb can't be empty.`);
        return;
      }
      if (v !== GUN_POWER_INFO[k].blurb) (next.powers ??= {})[k] = v;
    }
    for (const k of RESTRICTION_ORDER) {
      const v = rests[k].trim();
      if (!v) {
        setError(`The ${k} restriction blurb can't be empty.`);
        return;
      }
      if (v !== GUN_RESTRICTION_INFO[k].blurb) (next.restrictions ??= {})[k] = v;
    }
    for (const k of TIER_ORDER) {
      const list = cals[k]
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) {
        setError(`List at least one ${GUN_POWER_INFO[k].label} caliber.`);
        return;
      }
      if (list.join("\u0000") !== GUN_CALIBERS[k].join("\u0000")) (next.calibers ??= {})[k] = list;
    }
    const ruleList = rules
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ruleList.length === 0) {
      setError("List at least one misc rule.");
      return;
    }
    if (ruleList.join("\u0000") !== GUN_MISC_RULES.join("\u0000")) next.miscRules = ruleList;

    setError(null);
    save.mutate({ data: next });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-none max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest">
            EDIT WEAPONS &amp; GUNS TEXT
          </DialogTitle>
        </DialogHeader>
        <p className="font-mono text-[11px] text-muted-foreground -mt-2">
          These blurbs also power the hover notes on the gun catalog, so both
          surfaces always show the same wording.
        </p>
        <div className="space-y-5">
          <section className="space-y-3">
            <div className="font-display text-sm tracking-widest text-nc-cyan">TYPES</div>
            {CATEGORY_ORDER.map((k) => (
              <div key={k}>
                <Label className="text-xs font-mono">{k}</Label>
                <Textarea
                  value={cats[k]}
                  onChange={(e) => setCats((p) => ({ ...p, [k]: e.target.value }))}
                  rows={2}
                  maxLength={600}
                  className="rounded-none font-mono text-sm mt-1"
                  data-testid={`input-weapons-cat-${k}`}
                />
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <div className="font-display text-sm tracking-widest text-nc-cyan">POWER LEVELS</div>
            {TIER_ORDER.map((k) => (
              <div key={k}>
                <Label className="text-xs font-mono">{GUN_POWER_INFO[k].label}</Label>
                <Textarea
                  value={pows[k]}
                  onChange={(e) => setPows((p) => ({ ...p, [k]: e.target.value }))}
                  rows={2}
                  maxLength={600}
                  className="rounded-none font-mono text-sm mt-1"
                  data-testid={`input-weapons-power-${k}`}
                />
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <div className="font-display text-sm tracking-widest text-nc-magenta">RESTRICTIONS</div>
            {RESTRICTION_ORDER.map((k) => (
              <div key={k}>
                <Label className="text-xs font-mono">{k}</Label>
                <Textarea
                  value={rests[k]}
                  onChange={(e) => setRests((p) => ({ ...p, [k]: e.target.value }))}
                  rows={2}
                  maxLength={600}
                  className="rounded-none font-mono text-sm mt-1"
                  data-testid={`input-weapons-restriction-${k}`}
                />
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <div className="font-display text-sm tracking-widest text-nc-cyan">
              CALIBER EXAMPLES <span className="font-mono text-[10px] text-muted-foreground normal-case">(one per line)</span>
            </div>
            {TIER_ORDER.map((k) => (
              <div key={k}>
                <Label className="text-xs font-mono">{GUN_POWER_INFO[k].label}</Label>
                <Textarea
                  value={cals[k]}
                  onChange={(e) => setCals((p) => ({ ...p, [k]: e.target.value }))}
                  rows={4}
                  className="rounded-none font-mono text-sm mt-1"
                  data-testid={`input-weapons-calibers-${k}`}
                />
              </div>
            ))}
          </section>
          <section className="space-y-3">
            <div className="font-display text-sm tracking-widest text-nc-cyan">
              MISC RULES <span className="font-mono text-[10px] text-muted-foreground normal-case">(one per line)</span>
            </div>
            <Textarea
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              rows={6}
              className="rounded-none font-mono text-sm"
              data-testid="input-weapons-rules"
            />
          </section>
          {error && (
            <p className="font-mono text-xs text-destructive" data-testid="text-weapons-edit-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              className="rounded-none font-display"
              onClick={onClose}
              data-testid="button-weapons-edit-cancel"
            >
              CANCEL
            </Button>
            <Button
              className="rounded-none bg-nc-cyan text-background font-display"
              disabled={save.isPending}
              onClick={onSave}
              data-testid="button-weapons-edit-save"
            >
              {save.isPending ? "SAVING..." : "PUBLISH"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Swatch({ color, title }: { color: string; title: string }) {
  return (
    <span className="flex items-center gap-1" title={title}>
      <span
        className="inline-block w-4 h-4 border border-border"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <span className="font-mono text-[10px] text-muted-foreground">{title}</span>
    </span>
  );
}

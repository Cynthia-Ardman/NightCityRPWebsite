import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Crosshair } from "lucide-react";
import {
  GUN_CATEGORY_INFO,
  GUN_POWER_INFO,
  GUN_RESTRICTION_INFO,
  GUN_POWER_COLORS,
  GUN_CALIBERS,
  GUN_MISC_RULES,
} from "@/components/catalog/gunMechanics";

const CATEGORY_ORDER = ["Power", "Tech", "Smart"] as const;
const TIER_ORDER = ["L", "M", "H"] as const;

// Reference page describing how guns work in-game. This is a code-defined
// guidebook page (not Discord-imported or DB-edited): it reads from the shared
// gunMechanics module so its wording always matches the catalog hover blurbs.
export default function GuidebookWeapons() {
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

      {/* Gun types */}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">TYPES</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {CATEGORY_ORDER.map((key) => {
            const info = GUN_CATEGORY_INFO[key];
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
            const info = GUN_POWER_INFO[tier];
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
          {Object.entries(GUN_RESTRICTION_INFO).map(([key, info]) => (
            <div key={key} data-testid={`weapons-restriction-${key}`}>
              <div className="font-display text-lg text-nc-magenta tracking-wider">
                {info.label.toUpperCase()}
              </div>
              <p className="font-mono text-sm text-foreground/90">{info.blurb}</p>
            </div>
          ))}
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
                {GUN_CALIBERS[tier].map((c) => (
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
            {GUN_MISC_RULES.map((rule, i) => (
              <li key={i} data-testid={`weapons-rule-${i}`}>
                {rule}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
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

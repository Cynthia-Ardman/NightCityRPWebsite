import { useMemo, useState } from "react";
import { useListGuns } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import CustomCatalogTab from "@/components/catalog/CustomCatalogTab";
import GunDetailDialog from "@/components/catalog/GunDetailDialog";
import GunCreateDialog from "@/components/catalog/GunCreateDialog";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";
import type { Gun } from "@/components/catalog/gunTypes";
import {
  canonicalLabel,
  humanize,
  FIRE_MODES,
  GUN_CATEGORIES,
  GUN_POWER_LEVELS,
  GUN_POWER_LEVEL_ALIASES,
  GUN_RESTRICTIONS,
  GUN_WEAPON_TYPES,
  GUN_WEAPON_TYPE_ALIASES,
} from "@/components/catalog/gunTypes";
import {
  categoryInfo,
  powerInfo,
  powerColor,
} from "@/components/catalog/gunMechanics";
import { useGunMechanicsOverrides } from "@/components/catalog/useGunMechanics";
import { useSort, sortRows, SortableTh } from "@/components/catalog/sortableTable";

const ALL = "__all__";

// Single-select filters surfaced as dropdowns. Status is intentionally not
// here — staff manage drafts per-weapon, and regular players never see draft
// rows in the first place. The optional presets/aliases let us collapse
// synonyms ("smg"/"submachine_gun") and abbreviations ("Low"/"L") into one
// canonical filter option instead of splitting near-duplicate categories.
const FILTER_COLUMNS: Array<{
  key: keyof Gun;
  label: string;
  options?: readonly string[];
  aliases?: Record<string, string>;
}> = [
  { key: "category", label: "Category", options: GUN_CATEGORIES },
  { key: "manufacturer", label: "Manufacturer" },
  {
    key: "weaponType",
    label: "Weapon Type",
    options: GUN_WEAPON_TYPES,
    aliases: GUN_WEAPON_TYPE_ALIASES,
  },
  { key: "fireMode", label: "Fire Mode", options: FIRE_MODES },
  {
    key: "powerLevel",
    label: "Power Level",
    options: GUN_POWER_LEVELS,
    aliases: GUN_POWER_LEVEL_ALIASES,
  },
  { key: "restriction", label: "Restriction", options: GUN_RESTRICTIONS },
];

export default function CatalogGuns() {
  const { data, isLoading } = useListGuns();
  const { data: me } = useEffectiveMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  // Catalog prices are wholesale costs only store owners need; hide them
  // from everyone else (staff still see them for management).
  const canSeePrice = isStaff || !!me?.isStoreOwner;
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Gun | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState("catalog");
  const { sortKey, sortDir, toggle } = useSort<string>();

  const rows = (data ?? []) as Gun[];

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key, options: opts, aliases } of FILTER_COLUMNS) {
      const set = new Set<string>();
      for (const r of rows) {
        const v = r[key];
        // Dedupe on the canonical label so casing/whitespace AND synonym/
        // abbreviation variants ("revolver"/"Revolver", "smg"/"submachine_gun")
        // collapse into one filter option.
        if (typeof v === "string" && v.trim()) set.add(canonicalLabel(v, opts, aliases));
      }
      out[key as string] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [rows]);

  const filtered = rows.filter((g) => {
    for (const { key, options: opts, aliases } of FILTER_COLUMNS) {
      const want = filters[key as string];
      if (want && want !== ALL && canonicalLabel(g[key] as string | null, opts, aliases) !== want)
        return false;
    }
    if (!q) return true;
    const needle = q.toLowerCase();
    // weaponType + category often hold the words a player would type
    // (e.g. "shotgun"), so include them alongside the obvious name fields.
    return (
      g.name.toLowerCase().includes(needle) ||
      (g.manufacturer ?? "").toLowerCase().includes(needle) ||
      (g.category ?? "").toLowerCase().includes(needle) ||
      (g.weaponType ?? "").toLowerCase().includes(needle) ||
      humanize(g.weaponType).toLowerCase().includes(needle) ||
      humanize(g.category).toLowerCase().includes(needle)
    );
  });

  // Sort on the SAME text shown in each cell so the alphabetical order matches
  // what the player reads. Price sorts numerically.
  const sorted = sortRows(filtered, sortKey, sortDir, (g, key) => {
    switch (key) {
      case "name":
        return g.name;
      case "manufacturer":
        return humanize(g.manufacturer);
      case "category":
        return canonicalLabel(g.category, GUN_CATEGORIES);
      case "weaponType":
        return canonicalLabel(g.weaponType, GUN_WEAPON_TYPES, GUN_WEAPON_TYPE_ALIASES);
      case "fireMode":
        return canonicalLabel(g.fireMode, FIRE_MODES);
      case "powerLevel":
        return canonicalLabel(g.powerLevel, GUN_POWER_LEVELS, GUN_POWER_LEVEL_ALIASES);
      case "restriction":
        return canonicalLabel(g.restriction, GUN_RESTRICTIONS);
      case "price":
        return g.price;
      default:
        return null;
    }
  });

  return (
    <div className="max-w-[1600px] mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-catalog-guns-title">
            GUN CATALOG
          </h1>
          <p className="font-mono text-muted-foreground mt-2">
            Official weapon registry.
            {isStaff ? " Click a weapon to view or edit its full record." : " Click a weapon for details."}
          </p>
        </div>
        {isStaff && (
          <Button
            className="rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80"
            onClick={() => setCreateOpen(true)}
            data-testid="button-add-gun"
          >
            + ADD NEW WEAPON
          </Button>
        )}
      </div>

      <CatalogRequestSection
        type="gun"
        buttonLabel="REQUEST A CUSTOM GUN"
        dialogTitle="REQUEST A CUSTOM GUN"
        dialogDescription="Ask staff to add an off-sheet weapon to one of your characters."
        titleLabel="Gun Name"
        titlePlaceholder="e.g. Custom Malorian Arms 3516"
      />

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        {isStaff && (
          <TabsList className="rounded-none bg-card">
            <TabsTrigger value="catalog" className="rounded-none font-display tracking-widest">
              CATALOG
            </TabsTrigger>
            <TabsTrigger value="custom" className="rounded-none font-display tracking-widest">
              CUSTOM
            </TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="catalog" className="space-y-3">
      <div className="space-y-3">
        <Input
          placeholder="SEARCH NAME / MANUFACTURER / TYPE..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-guns"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {FILTER_COLUMNS.map(({ key, label }) => (
            <div key={key as string}>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">
                {label}
              </Label>
              <Select
                value={filters[key as string] ?? ALL}
                onValueChange={(v) =>
                  setFilters((prev) => ({ ...prev, [key as string]: v }))
                }
              >
                <SelectTrigger
                  className="rounded-none font-mono text-xs"
                  data-testid={`filter-gun-${String(key)}`}
                >
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {options[key as string].map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">LOADING...</div>
      ) : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm min-w-[800px]">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <SortableTh label="Name" columnKey="name" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Manufacturer" columnKey="manufacturer" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Category" columnKey="category" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Weapon Type" columnKey="weaponType" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Fire Mode" columnKey="fireMode" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Power Level" columnKey="powerLevel" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                <SortableTh label="Restriction" columnKey="restriction" activeKey={sortKey} dir={sortDir} onSort={toggle} />
                {canSeePrice && (
                  <SortableTh label="Price" columnKey="price" activeKey={sortKey} dir={sortDir} onSort={toggle} align="right" />
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((g) => (
                <tr
                  key={g.id}
                  className="border-b border-border/30 hover:bg-nc-cyan/5 cursor-pointer"
                  onClick={() => setSelected(g)}
                  data-testid={`row-gun-${g.id}`}
                >
                  <td className="p-3 font-bold">
                    <div className="flex items-center gap-2 flex-wrap">
                      {g.imageUrl ? (
                        <HoverCard openDelay={120} closeDelay={60}>
                          <HoverCardTrigger asChild>
                            <span
                              className="text-nc-cyan underline decoration-dotted underline-offset-4 cursor-pointer"
                              data-testid={`hover-gun-name-${g.id}`}
                            >
                              {g.name}
                            </span>
                          </HoverCardTrigger>
                          <HoverCardContent
                            className="rounded-none border-nc-cyan/40 bg-card p-2 w-64"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <img
                              src={g.imageUrl}
                              alt={g.name}
                              className="w-full max-h-48 object-contain border border-border bg-black/40"
                              data-testid={`img-gun-hover-${g.id}`}
                            />
                          </HoverCardContent>
                        </HoverCard>
                      ) : (
                        g.name
                      )}
                      {isStaff && (g.status ?? "").toLowerCase() === "draft" && (
                        <Badge
                          variant="outline"
                          className="rounded-none border-nc-yellow text-nc-yellow text-[9px] tracking-widest"
                        >
                          DRAFT
                        </Badge>
                      )}
                      {g.cyberwareReq && g.cyberwareReq.trim() && (
                        <Badge
                          variant="outline"
                          className="rounded-none border-nc-magenta text-nc-magenta text-[9px] tracking-widest"
                          title={`Requires: ${g.cyberwareReq}`}
                          data-testid={`badge-gun-req-${g.id}`}
                        >
                          REQ: {g.cyberwareReq}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {humanize(g.manufacturer)}
                  </td>
                  <td className="p-3"><GunCategoryCell gun={g} /></td>
                  <td className="p-3">
                    {canonicalLabel(g.weaponType, GUN_WEAPON_TYPES, GUN_WEAPON_TYPE_ALIASES)}
                  </td>
                  <td className="p-3">{canonicalLabel(g.fireMode, FIRE_MODES)}</td>
                  <td className="p-3">
                    <GunPowerCell gun={g} />
                  </td>
                  <td className="p-3 text-nc-magenta">
                    {canonicalLabel(g.restriction, GUN_RESTRICTIONS)}
                  </td>
                  {canSeePrice && (
                    <td className="p-3 text-right text-nc-yellow">
                      {g.price.toLocaleString()} €$
                    </td>
                  )}
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={canSeePrice ? 8 : 7} className="text-center p-8 text-muted-foreground">
                    No results.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
        </TabsContent>
        {isStaff && (
          <TabsContent value="custom">
            <CustomCatalogTab type="gun" />
          </TabsContent>
        )}
      </Tabs>

      <GunDetailDialog
        gun={selected}
        isStaff={isStaff}
        showPrice={canSeePrice}
        open={selected !== null}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      />
      {isStaff && (
        <GunCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCustomCreated={() => setTab("custom")}
        />
      )}
    </div>
  );
}

// Category cell with a hover explanation of how that gun type behaves. Falls
// back to plain text for custom/off-list categories we have no copy for. The
// blurbs come from the shared gunMechanics module (same source as the Weapons
// guidebook page), so wording can never drift.
function GunCategoryCell({ gun }: { gun: Gun }) {
  const overrides = useGunMechanicsOverrides();
  const label = canonicalLabel(gun.category, GUN_CATEGORIES);
  const info = categoryInfo(gun.category, overrides);
  if (!info) return <span>{label}</span>;
  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="cursor-help bg-transparent p-0 text-left underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nc-cyan/60 focus-visible:ring-offset-0"
          data-testid={`gun-category-${gun.id}`}
        >
          {label}
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 rounded-none border-nc-cyan/40 bg-card">
        <div className="font-display text-sm text-nc-cyan tracking-widest mb-1">
          {info.label.toUpperCase()}
        </div>
        <p className="font-mono text-xs text-foreground/90">{info.blurb}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

// Power-level cell: a tier swatch tinted by the gun's category family (Power vs
// Tech/Smart) plus a hover explanation of what that tier means.
function GunPowerCell({ gun }: { gun: Gun }) {
  const overrides = useGunMechanicsOverrides();
  const label = canonicalLabel(gun.powerLevel, GUN_POWER_LEVELS, GUN_POWER_LEVEL_ALIASES);
  const info = powerInfo(gun.powerLevel, overrides);
  const color = powerColor(gun.category, gun.powerLevel);
  return (
    <span className="inline-flex items-center gap-2">
      {color && (
        <span
          className="inline-block w-2.5 h-2.5 rounded-full border border-border/60 shrink-0"
          style={{ backgroundColor: color }}
          aria-hidden
        />
      )}
      {info ? (
        <HoverCard openDelay={120} closeDelay={60}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="cursor-help bg-transparent p-0 text-left underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nc-cyan/60 focus-visible:ring-offset-0"
              data-testid={`gun-power-${gun.id}`}
            >
              {label}
            </button>
          </HoverCardTrigger>
          <HoverCardContent className="w-72 rounded-none border-nc-cyan/40 bg-card">
            <div className="font-display text-sm text-nc-cyan tracking-widest mb-1">
              {info.label.toUpperCase()}
            </div>
            <p className="font-mono text-xs text-foreground/90">{info.blurb}</p>
          </HoverCardContent>
        </HoverCard>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
}

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
import { useAuthMe } from "@/hooks/useAuthMe";
import GunDetailDialog from "@/components/catalog/GunDetailDialog";
import GunCreateDialog from "@/components/catalog/GunCreateDialog";
import type { Gun } from "@/components/catalog/gunTypes";
import { humanize } from "@/components/catalog/gunTypes";

const ALL = "__all__";

// Single-select filters surfaced as dropdowns. Status is intentionally not
// here — staff manage drafts per-weapon, and regular players never see draft
// rows in the first place.
const FILTER_COLUMNS: Array<{ key: keyof Gun; label: string }> = [
  { key: "category", label: "Category" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "weaponType", label: "Weapon Type" },
  { key: "powerLevel", label: "Power Level" },
  { key: "restriction", label: "Restriction" },
];

export default function CatalogGuns() {
  const { data, isLoading } = useListGuns();
  const { data: me } = useAuthMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Gun | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const rows = (data ?? []) as Gun[];

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key } of FILTER_COLUMNS) {
      const set = new Set<string>();
      for (const r of rows) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) set.add(v);
      }
      out[key as string] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [rows]);

  const filtered = rows.filter((g) => {
    for (const { key } of FILTER_COLUMNS) {
      const want = filters[key as string];
      if (want && want !== ALL && g[key] !== want) return false;
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

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
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
                      {humanize(opt)}
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
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Manufacturer</th>
                <th className="text-left p-3">Category</th>
                <th className="text-left p-3">Weapon Type</th>
                <th className="text-left p-3">Power Level</th>
                <th className="text-left p-3">Restriction</th>
                <th className="text-right p-3">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr
                  key={g.id}
                  className="border-b border-border/30 hover:bg-nc-cyan/5 cursor-pointer"
                  onClick={() => setSelected(g)}
                  data-testid={`row-gun-${g.id}`}
                >
                  <td className="p-3 font-bold flex items-center gap-2">
                    {g.name}
                    {isStaff && (g.status ?? "").toLowerCase() === "draft" && (
                      <Badge
                        variant="outline"
                        className="rounded-none border-nc-yellow text-nc-yellow text-[9px] tracking-widest"
                      >
                        DRAFT
                      </Badge>
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">
                    {humanize(g.manufacturer)}
                  </td>
                  <td className="p-3">{humanize(g.category)}</td>
                  <td className="p-3">{humanize(g.weaponType)}</td>
                  <td className="p-3">{humanize(g.powerLevel)}</td>
                  <td className="p-3 text-nc-magenta">{humanize(g.restriction)}</td>
                  <td className="p-3 text-right text-nc-yellow">
                    {g.price.toLocaleString()} €$
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center p-8 text-muted-foreground">
                    No results.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      )}

      <GunDetailDialog
        gun={selected}
        isStaff={isStaff}
        open={selected !== null}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      />
      {isStaff && <GunCreateDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}

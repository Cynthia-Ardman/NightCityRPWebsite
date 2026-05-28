import { useMemo, useState } from "react";
import { useListGuns } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

type Gun = {
  id: number;
  name: string;
  category?: string | null;
  manufacturer?: string | null;
  damage?: string | null;
  magSize?: number | null;
  price: number;
  notes?: string | null;
  wholesalePrice?: number | null;
  restriction?: string | null;
  status?: string | null;
  powerLevel?: string | null;
  weaponType?: string | null;
};

const FILTER_COLUMNS: Array<{ key: keyof Gun; label: string }> = [
  { key: "category", label: "Category" },
  { key: "manufacturer", label: "Manufacturer" },
  { key: "weaponType", label: "Weapon Type" },
  { key: "powerLevel", label: "Power Level" },
  { key: "restriction", label: "Restriction" },
  { key: "status", label: "Status" },
];

export default function CatalogGuns() {
  const { data, isLoading } = useListGuns();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});

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
    return (
      g.name.toLowerCase().includes(needle) ||
      (g.manufacturer ?? "").toLowerCase().includes(needle) ||
      (g.category ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-guns-title">GUN CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Official weapon registry.</p>
      </div>
      <div className="space-y-3">
        <Input
          placeholder="SEARCH NAME / MANUFACTURER / CATEGORY..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-guns"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {FILTER_COLUMNS.map(({ key, label }) => (
            <div key={key as string}>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
              <Select
                value={filters[key as string] ?? ALL}
                onValueChange={(v) => setFilters((prev) => ({ ...prev, [key as string]: v }))}
              >
                <SelectTrigger className="rounded-none font-mono text-xs" data-testid={`filter-gun-${String(key)}`}>
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {options[key as string].map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm min-w-[1100px]">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Manufacturer</th>
                <th className="text-left p-3">Category</th>
                <th className="text-left p-3">Weapon Type</th>
                <th className="text-left p-3">Power Level</th>
                <th className="text-left p-3">Restriction</th>
                <th className="text-left p-3">Status</th>
                <th className="text-right p-3">Damage</th>
                <th className="text-right p-3">Mag</th>
                <th className="text-right p-3">Wholesale</th>
                <th className="text-right p-3">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-gun-${g.id}`}>
                  <td className="p-3 font-bold">{g.name}</td>
                  <td className="p-3 text-muted-foreground">{g.manufacturer ?? "—"}</td>
                  <td className="p-3">{g.category ?? "—"}</td>
                  <td className="p-3">{g.weaponType ?? "—"}</td>
                  <td className="p-3">{g.powerLevel ?? "—"}</td>
                  <td className="p-3 text-nc-magenta">{g.restriction ?? "—"}</td>
                  <td className="p-3">{g.status ?? "—"}</td>
                  <td className="p-3 text-right text-destructive">{g.damage ?? "—"}</td>
                  <td className="p-3 text-right">{g.magSize ?? "—"}</td>
                  <td className="p-3 text-right text-muted-foreground">{g.wholesalePrice != null ? `${g.wholesalePrice.toLocaleString()} €$` : "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{g.price.toLocaleString()} €$</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={11} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

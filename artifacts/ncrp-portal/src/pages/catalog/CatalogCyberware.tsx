import { useMemo, useState } from "react";
import { useListCyberware } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__all__";

type Cyber = {
  id: number;
  name: string;
  slot: string;
  humanityLoss: number;
  price: number;
  installCost?: number | null;
  description?: string | null;
  cwp?: string | null;
  wholesalePrice?: number | null;
};

const FILTER_COLUMNS: Array<{ key: keyof Cyber; label: string }> = [
  { key: "slot", label: "Slot" },
  { key: "cwp", label: "CWP" },
];

export default function CatalogCyberware() {
  const { data, isLoading } = useListCyberware();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});

  const rows = (data ?? []) as Cyber[];

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

  const filtered = rows.filter((c) => {
    for (const { key } of FILTER_COLUMNS) {
      const want = filters[key as string];
      if (want && want !== ALL && c[key] !== want) return false;
    }
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      c.name.toLowerCase().includes(needle) ||
      c.slot.toLowerCase().includes(needle) ||
      (c.description ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-cyberware-title">CYBERWARE CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Approved augmentations.</p>
      </div>
      <div className="space-y-3">
        <Input
          placeholder="SEARCH NAME / SLOT / DESCRIPTION..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-cyberware"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-w-2xl">
          {FILTER_COLUMNS.map(({ key, label }) => (
            <div key={key as string}>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
              <Select
                value={filters[key as string] ?? ALL}
                onValueChange={(v) => setFilters((prev) => ({ ...prev, [key as string]: v }))}
              >
                <SelectTrigger className="rounded-none font-mono text-xs" data-testid={`filter-cyberware-${String(key)}`}>
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
          <table className="w-full font-mono text-sm min-w-[900px]">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Slot</th>
                <th className="text-left p-3">CWP</th>
                <th className="text-left p-3">Description</th>
                <th className="text-right p-3">HL</th>
                <th className="text-right p-3">Wholesale</th>
                <th className="text-right p-3">Price</th>
                <th className="text-right p-3">Install</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-cyberware-${c.id}`}>
                  <td className="p-3 font-bold">{c.name}</td>
                  <td className="p-3 text-nc-magenta">{c.slot}</td>
                  <td className="p-3">{c.cwp ?? "—"}</td>
                  <td className="p-3 text-muted-foreground max-w-md truncate" title={c.description ?? ""}>{c.description ?? "—"}</td>
                  <td className="p-3 text-right text-destructive">{c.humanityLoss}</td>
                  <td className="p-3 text-right text-muted-foreground">{c.wholesalePrice != null ? `${c.wholesalePrice.toLocaleString()} €$` : "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{c.price.toLocaleString()} €$</td>
                  <td className="p-3 text-right">{c.installCost != null ? c.installCost.toLocaleString() : "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={8} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

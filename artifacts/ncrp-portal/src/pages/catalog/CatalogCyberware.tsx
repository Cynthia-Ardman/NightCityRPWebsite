import { useMemo, useState } from "react";
import { useListCyberware } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";

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

// Drop trailing ".0" / ".00" so values like "2.0" display as "2".
function trimZero(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (Number.isFinite(n)) {
    return Number.isInteger(n) ? String(n) : String(n).replace(/\.?0+$/, "");
  }
  return String(v);
}

// Slot color palette — deterministically maps slot name to a color so
// the table is visually scannable. Uses standard Tailwind palette
// colors (not the nc-* theme) so we don't depend on the theme being
// extended for every possible slot category.
const SLOT_PALETTE = [
  "text-cyan-400",
  "text-pink-400",
  "text-yellow-400",
  "text-purple-400",
  "text-orange-400",
  "text-lime-400",
  "text-rose-400",
  "text-blue-400",
  "text-emerald-400",
  "text-fuchsia-400",
  "text-amber-400",
  "text-sky-400",
];

function slotColor(slot: string): string {
  const key = slot.trim().toUpperCase();
  if (!key) return "text-muted-foreground";
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return SLOT_PALETTE[Math.abs(hash) % SLOT_PALETTE.length];
}

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
    <div className="max-w-[1600px] mx-auto space-y-6 pb-12 px-2">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-cyberware-title">CYBERWARE CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Approved augmentations.</p>
      </div>
      <CatalogRequestSection
        type="cyberware"
        buttonLabel="REQUEST CUSTOM CYBERWARE"
        dialogTitle="REQUEST CUSTOM CYBERWARE"
        dialogDescription="Ask staff to add a custom chrome piece to one of your characters."
        titleLabel="Cyberware Name"
        titlePlaceholder="e.g. Custom Sandevistan Mk.5"
      />
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
          <table className="w-full font-mono text-sm">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <th className="text-left p-3 w-[18%]">Name</th>
                <th className="text-left p-3 w-[10%]">Slot</th>
                <th className="text-left p-3 w-[8%]">CWP</th>
                <th className="text-left p-3">Description</th>
                <th className="text-right p-3 w-[10%]">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-cyberware-${c.id}`}>
                  <td className="p-3 font-bold">{c.name}</td>
                  <td className={`p-3 font-semibold ${slotColor(c.slot)}`}>{c.slot}</td>
                  <td className="p-3">{trimZero(c.cwp)}</td>
                  <td className="p-3 text-muted-foreground" title={c.description ?? ""}>{c.description ?? "—"}</td>
                  <td className="p-3 text-right text-nc-yellow whitespace-nowrap">{c.price.toLocaleString()} €$</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={5} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

import { useMemo, useState } from "react";
import { useListCyberware } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";
import CustomCatalogTab from "@/components/catalog/CustomCatalogTab";
import { useAuthMe } from "@/hooks/useAuthMe";
import CyberwareDetailDialog, { type Cyber } from "@/components/catalog/CyberwareDetailDialog";
import CyberwareCreateDialog from "@/components/catalog/CyberwareCreateDialog";

const ALL = "__all__";

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
  const { data: me } = useAuthMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  // Catalog prices are wholesale costs only ripperdoc owners need; hide them
  // from everyone else (staff still see them for management).
  const canSeePrice = isStaff || !!me?.isRipperdoc;
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Cyber | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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

  const filtered = rows
    .filter((c) => {
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
    })
    // Group strictly by slot: the API returns rows in insertion order, so
    // same-slot pieces added at different times would otherwise scatter (and
    // case/whitespace differences split a slot into separate islands). Sort on
    // a normalized slot key, then name, so every slot is one contiguous block.
    .sort((a, b) => {
      const sa = a.slot.trim().toLowerCase().replace(/\s+/g, " ");
      const sb = b.slot.trim().toLowerCase().replace(/\s+/g, " ");
      if (sa !== sb) return sa.localeCompare(sb);
      return a.name.localeCompare(b.name);
    });

  return (
    <div className="max-w-[1600px] mx-auto space-y-6 pb-12 px-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-catalog-cyberware-title">CYBERWARE CATALOG</h1>
          <p className="font-mono text-muted-foreground mt-2">
            Approved augmentations.
            {isStaff ? " Click a piece to view or edit its full record." : ""}
          </p>
        </div>
        {isStaff && (
          <Button
            className="rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80"
            onClick={() => setCreateOpen(true)}
            data-testid="button-add-cyberware"
          >
            + ADD NEW CYBERWARE
          </Button>
        )}
      </div>
      <CatalogRequestSection
        type="cyberware"
        buttonLabel="REQUEST CUSTOM CYBERWARE"
        dialogTitle="REQUEST CUSTOM CYBERWARE"
        dialogDescription="Ask staff to add a custom chrome piece to one of your characters."
        titleLabel="Cyberware Name"
        titlePlaceholder="e.g. Custom Sandevistan Mk.5"
      />
      <Tabs defaultValue="catalog" className="space-y-4">
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
                {canSeePrice && <th className="text-right p-3 w-[10%]">Price</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr
                  key={c.id}
                  className={`border-b border-border/30 hover:bg-card/80 ${isStaff ? "cursor-pointer" : ""}`}
                  onClick={isStaff ? () => setSelected(c) : undefined}
                  data-testid={`row-cyberware-${c.id}`}
                >
                  <td className="p-3 font-bold">{c.name}</td>
                  <td className={`p-3 font-semibold ${slotColor(c.slot)}`}>{c.slot}</td>
                  <td className="p-3">{trimZero(c.cwp)}</td>
                  <td className="p-3 text-muted-foreground" title={c.description ?? ""}>{c.description ?? "—"}</td>
                  {canSeePrice && <td className="p-3 text-right text-nc-yellow whitespace-nowrap">{c.price.toLocaleString()} €$</td>}
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={canSeePrice ? 5 : 4} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
        </TabsContent>
        {isStaff && (
          <TabsContent value="custom">
            <CustomCatalogTab type="cyberware" />
          </TabsContent>
        )}
      </Tabs>

      {isStaff && (
        <CyberwareDetailDialog
          cyber={selected}
          isStaff={isStaff}
          open={selected !== null}
          onOpenChange={(v) => {
            if (!v) setSelected(null);
          }}
        />
      )}

      {isStaff && <CyberwareCreateDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </div>
  );
}

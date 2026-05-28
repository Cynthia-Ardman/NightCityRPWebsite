import { useMemo, useState } from "react";
import { useListGuns, useUpdateGun, getListGunsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";

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

// Catalog imports left raw values like "heavy_machine_gun" / "POWER" /
// "tech-shotgun". Normalise on render so the listing reads like English
// without having to scrub the database. Underscores AND hyphens collapse
// to spaces, then we Title Case each word.
function humanize(v: string | null | undefined): string {
  if (!v) return "—";
  const cleaned = String(v).replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "—";
  return cleaned
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Single-select filters surfaced as dropdowns. Status is intentionally not
// here — staff manage drafts in the editor dialog, and regular players
// never see draft rows in the first place.
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
  const [editorOpen, setEditorOpen] = useState(false);

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
          <p className="font-mono text-muted-foreground mt-2">Official weapon registry.</p>
        </div>
        {isStaff && (
          <Button
            variant="outline"
            className="rounded-none font-display tracking-widest border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background"
            onClick={() => setEditorOpen(true)}
            data-testid="button-edit-gun-catalog"
          >
            EDIT GUN CATALOG
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
                  className="border-b border-border/30 hover:bg-card/80"
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

      {isStaff && (
        <GunCatalogEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          rows={rows}
        />
      )}
    </div>
  );
}

// Minimal editor: lists every gun grouped by status, lets staff flip
// drafts → live (or live → draft). Anything more involved (price edits,
// new gun creation) is intentionally out of scope for this pass.
function GunCatalogEditor({
  open,
  onOpenChange,
  rows,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  rows: Gun[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const update = useUpdateGun({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListGunsQueryKey() });
      },
      onError: (e: unknown) => {
        toast({
          title: "Update failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        });
      },
    },
  });

  const drafts = rows.filter((g) => (g.status ?? "").toLowerCase() === "draft");
  const live = rows.filter((g) => (g.status ?? "").toLowerCase() !== "draft");

  function setStatus(id: number, status: "draft" | "live") {
    update.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          toast({
            title: `Gun ${status === "live" ? "promoted to LIVE" : "moved to DRAFT"}`,
          });
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl rounded-none border-nc-magenta bg-card font-mono max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl text-nc-magenta">
            GUN CATALOG EDITOR
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Promote drafts to live so all players can see them.
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h3 className="font-display text-nc-yellow tracking-widest text-sm">
            DRAFTS ({drafts.length})
          </h3>
          {drafts.length === 0 ? (
            <p className="text-xs text-muted-foreground">No drafts.</p>
          ) : (
            <ul className="divide-y divide-border/40 border border-border">
              {drafts.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-3 p-2"
                  data-testid={`editor-draft-${g.id}`}
                >
                  <div className="min-w-0">
                    <div className="text-sm truncate">{g.name}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {humanize(g.manufacturer)} · {humanize(g.weaponType)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-none font-display text-xs border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background"
                    disabled={update.isPending}
                    onClick={() => setStatus(g.id, "live")}
                    data-testid={`button-make-live-${g.id}`}
                  >
                    MAKE LIVE
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="font-display text-nc-cyan tracking-widest text-sm">
            LIVE ({live.length})
          </h3>
          <ul className="divide-y divide-border/30 border border-border/60 max-h-64 overflow-y-auto">
            {live.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-3 p-2"
                data-testid={`editor-live-${g.id}`}
              >
                <div className="min-w-0">
                  <div className="text-sm truncate">{g.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {humanize(g.manufacturer)} · {humanize(g.weaponType)}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-none font-display text-xs text-muted-foreground hover:text-nc-yellow"
                  disabled={update.isPending}
                  onClick={() => setStatus(g.id, "draft")}
                  data-testid={`button-make-draft-${g.id}`}
                >
                  MOVE TO DRAFT
                </Button>
              </li>
            ))}
          </ul>
        </section>
      </DialogContent>
    </Dialog>
  );
}

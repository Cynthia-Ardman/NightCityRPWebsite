import { useMemo, useState } from "react";
import {
  useListRentListings,
  useListMyCharacters,
  useLeaseHousing,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, Home } from "lucide-react";

const ALL = "__all__";

type Listing = {
  id: number;
  name: string;
  district?: string | null;
  tier?: string | null;
  monthlyRent: number;
  description?: string | null;
};

const FILTER_COLUMNS: Array<{ key: keyof Listing; label: string }> = [
  { key: "district", label: "District" },
  { key: "tier", label: "Tier" },
];

export default function CatalogRent() {
  const { data, isLoading } = useListRentListings();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [leaseTarget, setLeaseTarget] = useState<{ id: number; name: string; monthlyRent: number } | null>(null);

  const listings = (data ?? []) as Listing[];

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key } of FILTER_COLUMNS) {
      const set = new Set<string>();
      for (const r of listings) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) set.add(v);
      }
      out[key as string] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [listings]);

  const filtered = listings.filter((r) => {
    for (const { key } of FILTER_COLUMNS) {
      const want = filters[key as string];
      if (want && want !== ALL && r[key] !== want) return false;
    }
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      r.name.toLowerCase().includes(needle) ||
      (r.district ?? "").toLowerCase().includes(needle) ||
      (r.description ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-rent-title">HOUSING CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Available rooms and apartments.</p>
      </div>
      <div className="space-y-3">
        <Input
          placeholder="SEARCH NAME / DISTRICT / DESCRIPTION..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-rent"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-w-2xl">
          {FILTER_COLUMNS.map(({ key, label }) => (
            <div key={key as string}>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
              <Select
                value={filters[key as string] ?? ALL}
                onValueChange={(v) => setFilters((prev) => ({ ...prev, [key as string]: v }))}
              >
                <SelectTrigger className="rounded-none font-mono text-xs" data-testid={`filter-rent-${String(key)}`}>
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
          <table className="w-full font-mono text-sm min-w-[800px]">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">District</th>
                <th className="text-left p-3">Tier</th>
                <th className="text-left p-3">Description</th>
                <th className="text-right p-3">Rent/mo</th>
                <th className="p-3 w-0"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-rent-${r.id}`}>
                  <td className="p-3 font-bold">{r.name}</td>
                  <td className="p-3 text-nc-magenta">{r.district ?? "—"}</td>
                  <td className="p-3 uppercase">{r.tier ?? "—"}</td>
                  <td className="p-3 text-muted-foreground max-w-md truncate" title={r.description ?? ""}>{r.description ?? "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                  <td className="p-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs"
                      onClick={() => setLeaseTarget({ id: r.id, name: r.name, monthlyRent: r.monthlyRent })}
                      data-testid={`button-lease-${r.id}`}
                    >
                      <Home className="w-3 h-3 mr-1" /> LEASE
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={6} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
      {leaseTarget && (
        <LeaseDialog
          listing={leaseTarget}
          onClose={() => setLeaseTarget(null)}
          onDone={() => setLeaseTarget(null)}
        />
      )}
    </div>
  );
}

function LeaseDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: { id: number; name: string; monthlyRent: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: chars } = useListMyCharacters();
  const eligible = (chars ?? []).filter((c) => !c.archived);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const lease = useLeaseHousing({
    mutation: {
      onSuccess: (created) => {
        qc.invalidateQueries({ queryKey: ["/housing/mine"] });
        if (created?.characterId) {
          qc.invalidateQueries({ queryKey: [`/characters/${created.characterId}/housing`] });
        }
        onDone();
      },
    },
  });
  const errMsg =
    (lease.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (lease.error ? "Lease failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-lease">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">
            SIGN LEASE: {listing.name}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-lease">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!characterId) return;
              lease.mutate({ data: { catalogRentId: listing.id, characterId } });
            }}
          >
            <p className="text-muted-foreground">
              Rent <span className="text-nc-yellow">€${listing.monthlyRent.toLocaleString()}/mo</span> will be auto-debited on the 1st of each month.
            </p>
            <div>
              <Label className="text-xs">CHARACTER</Label>
              {eligible.length === 0 ? (
                <div className="text-muted-foreground text-xs mt-1">No eligible characters.</div>
              ) : (
                <div className="space-y-1 mt-1 max-h-60 overflow-y-auto">
                  {eligible.map((c) => (
                    <label
                      key={c.id}
                      className={`flex items-center gap-2 p-2 border cursor-pointer ${characterId === c.id ? "border-nc-cyan bg-nc-cyan/10" : "border-border/40"}`}
                      data-testid={`option-lease-char-${c.id}`}
                    >
                      <input
                        type="radio"
                        name="leaseChar"
                        checked={characterId === c.id}
                        onChange={() => setCharacterId(c.id)}
                      />
                      <span>{c.name}</span>
                      {c.archetype ? <span className="text-xs text-muted-foreground">— {c.archetype}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-lease-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={lease.isPending || !characterId}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-confirm-lease"
            >
              {lease.isPending ? "SIGNING..." : "CONFIRM LEASE"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

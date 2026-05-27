import { useMemo, useState } from "react";
import { useListRentListings } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function CatalogRent() {
  const { data, isLoading } = useListRentListings();
  const [q, setQ] = useState("");
  const [district, setDistrict] = useState<string | null>(null);

  const listings = data ?? [];
  const districts = useMemo(() => {
    const set = new Set<string>();
    for (const r of listings) if (r.district) set.add(r.district);
    return Array.from(set).sort();
  }, [listings]);

  const filtered = listings.filter((r) => {
    if (district && r.district !== district) return false;
    if (!q) return true;
    const needle = q.toLowerCase();
    return r.name.toLowerCase().includes(needle) || (r.district ?? "").toLowerCase().includes(needle);
  });

  const grouped = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const r of filtered) {
      const key = r.district ?? "—";
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-rent-title">HOUSING CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Available rooms and apartments.</p>
      </div>
      <div className="flex flex-col gap-3">
        <Input placeholder="SEARCH..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-none font-mono max-w-md" data-testid="input-search-rent" />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={district === null ? "default" : "outline"}
            className="rounded-none font-mono uppercase text-xs"
            onClick={() => setDistrict(null)}
            data-testid="filter-district-all"
          >
            All Districts
          </Button>
          {districts.map((d) => (
            <Button
              key={d}
              type="button"
              variant={district === d ? "default" : "outline"}
              className="rounded-none font-mono uppercase text-xs"
              onClick={() => setDistrict(d)}
              data-testid={`filter-district-${d}`}
            >
              {d}
            </Button>
          ))}
        </div>
      </div>
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <div className="space-y-6">
          {grouped.map(([districtName, rows]) => (
            <Card key={districtName} className="rounded-none border-border bg-card/50 p-0 overflow-x-auto" data-testid={`group-district-${districtName}`}>
              <div className="px-3 py-2 border-b border-border bg-card flex items-baseline justify-between">
                <h2 className="font-display text-nc-magenta text-lg tracking-widest">{districtName}</h2>
                <span className="font-mono text-xs text-muted-foreground">{rows.length} listing{rows.length === 1 ? "" : "s"}</span>
              </div>
              <table className="w-full font-mono text-sm">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Tier</th>
                    <th className="text-right p-3">Rent/mo</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-rent-${r.id}`}>
                      <td className="p-3 font-bold">{r.name}</td>
                      <td className="p-3 uppercase">{r.tier ?? "—"}</td>
                      <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
          {grouped.length === 0 && (
            <Card className="rounded-none border-border bg-card/50 p-8 text-center text-muted-foreground font-mono">
              No results.
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

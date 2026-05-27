import { useState } from "react";
import { useListRentListings } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export default function CatalogRent() {
  const { data, isLoading } = useListRentListings();
  const [q, setQ] = useState("");
  const filtered = (data ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase()) || (r.district ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-rent-title">HOUSING CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Available rooms and apartments.</p>
      </div>
      <Input placeholder="SEARCH DISTRICT..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-none font-mono max-w-md" data-testid="input-search-rent" />
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">District</th>
                <th className="text-left p-3">Tier</th>
                <th className="text-right p-3">Rent/mo</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-rent-${r.id}`}>
                  <td className="p-3 font-bold">{r.name}</td>
                  <td className="p-3 text-nc-magenta">{r.district ?? "—"}</td>
                  <td className="p-3 uppercase">{r.tier ?? "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={4} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

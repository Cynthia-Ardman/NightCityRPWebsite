import { useState } from "react";
import { useListGuns } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export default function CatalogGuns() {
  const { data, isLoading } = useListGuns();
  const [q, setQ] = useState("");
  const filtered = (data ?? []).filter((g) => g.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-guns-title">GUN CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Official weapon registry.</p>
      </div>
      <Input placeholder="SEARCH..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-none font-mono max-w-md" data-testid="input-search-guns" />
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Manufacturer</th>
                <th className="text-left p-3">Category</th>
                <th className="text-right p-3">Damage</th>
                <th className="text-right p-3">Mag</th>
                <th className="text-right p-3">Price</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-gun-${g.id}`}>
                  <td className="p-3 font-bold">{g.name}</td>
                  <td className="p-3 text-muted-foreground">{g.manufacturer ?? "—"}</td>
                  <td className="p-3">{g.category ?? "—"}</td>
                  <td className="p-3 text-right text-destructive">{g.damage ?? "—"}</td>
                  <td className="p-3 text-right">{g.magSize ?? "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{g.price.toLocaleString()} €$</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={6} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

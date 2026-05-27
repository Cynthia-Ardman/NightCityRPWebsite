import { useState } from "react";
import { useListCyberware } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";

export default function CatalogCyberware() {
  const { data, isLoading } = useListCyberware();
  const [q, setQ] = useState("");
  const filtered = (data ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || c.slot.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-cyberware-title">CYBERWARE CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Approved augmentations.</p>
      </div>
      <Input placeholder="SEARCH SLOT OR NAME..." value={q} onChange={(e) => setQ(e.target.value)} className="rounded-none font-mono max-w-md" data-testid="input-search-cyberware" />
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-xs tracking-widest">
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">Slot</th>
                <th className="text-right p-3">HL</th>
                <th className="text-right p-3">Price</th>
                <th className="text-right p-3">Install</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-cyberware-${c.id}`}>
                  <td className="p-3 font-bold">{c.name}</td>
                  <td className="p-3 text-nc-magenta">{c.slot}</td>
                  <td className="p-3 text-right text-destructive">{c.humanityLoss}</td>
                  <td className="p-3 text-right text-nc-yellow">{c.price.toLocaleString()} €$</td>
                  <td className="p-3 text-right">{c.installCost?.toLocaleString() ?? "—"}</td>
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

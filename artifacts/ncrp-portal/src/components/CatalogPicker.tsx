import { useState } from "react";
import {
  useListGuns,
  useListCyberware,
  getListGunsQueryKey,
  getListCyberwareQueryKey,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BookOpen } from "lucide-react";

export type PickedItem = {
  name: string;
  category: string | null;
  price: number;
};

type Props = {
  kind: "guns" | "cyberware";
  onPick: (item: PickedItem) => void;
  triggerLabel?: string;
  triggerClassName?: string;
};

export default function CatalogPicker({ kind, onPick, triggerLabel = "ADD FROM CATALOG", triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const gunsQuery = useListGuns({
    query: { enabled: open && kind === "guns", queryKey: getListGunsQueryKey() },
  });
  const cyberQuery = useListCyberware({
    query: { enabled: open && kind === "cyberware", queryKey: getListCyberwareQueryKey() },
  });

  const isLoading = kind === "guns" ? gunsQuery.isLoading : cyberQuery.isLoading;

  const rows: PickedItem[] = (() => {
    if (kind === "guns") {
      return (gunsQuery.data ?? []).map((g) => ({
        name: g.name,
        category: g.category ?? null,
        price: g.price,
      }));
    }
    return (cyberQuery.data ?? []).map((c) => ({
      name: c.name,
      category: c.slot ?? null,
      price: c.price,
    }));
  })();

  const filtered = rows.filter(
    (r) =>
      r.name.toLowerCase().includes(q.toLowerCase()) ||
      (r.category ?? "").toLowerCase().includes(q.toLowerCase()),
  );

  const pick = (item: PickedItem) => {
    onPick(item);
    setOpen(false);
    setQ("");
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className={triggerClassName ?? "rounded-none font-display border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background"}
          data-testid={`button-open-catalog-${kind}`}
        >
          <BookOpen className="w-4 h-4 mr-2" /> {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl rounded-none border-border bg-card">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest">
            {kind === "guns" ? "GUN CATALOG" : "CYBERWARE CATALOG"}
          </DialogTitle>
        </DialogHeader>
        <Input
          placeholder="SEARCH..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono"
          data-testid={`input-catalog-search-${kind}`}
          autoFocus
        />
        <div className="max-h-96 overflow-y-auto border border-border/40">
          {isLoading ? (
            <div className="p-6 text-center font-display text-nc-cyan animate-pulse">LOADING...</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground font-mono text-sm">No matches.</div>
          ) : (
            <table className="w-full font-mono text-sm">
              <tbody>
                {filtered.map((r, i) => (
                  <tr
                    key={`${r.name}-${i}`}
                    className="border-b border-border/30 hover:bg-card/80 cursor-pointer"
                    onClick={() => pick(r)}
                    data-testid={`row-catalog-pick-${i}`}
                  >
                    <td className="p-2 font-bold">{r.name}</td>
                    <td className="p-2 text-muted-foreground">{r.category ?? "—"}</td>
                    <td className="p-2 text-right text-nc-yellow">{r.price.toLocaleString()} €$</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

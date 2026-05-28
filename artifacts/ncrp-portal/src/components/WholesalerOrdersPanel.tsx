import { useListWholesalerOrders } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function WholesalerOrdersPanel({ kind, venueId }: { kind: "store" | "ripperdoc"; venueId: number }) {
  const { data, isLoading, error } = useListWholesalerOrders({ kind, venueId });
  if (error) return null;
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">RECENT WHOLESALER ORDERS</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-nc-cyan font-mono text-xs animate-pulse">Loading...</div>
        ) : !data?.length ? (
          <div className="text-muted-foreground font-mono text-xs">No restocks recorded yet.</div>
        ) : (
          <div className="rounded-md border border-border overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan">When</TableHead>
                  <TableHead className="font-display text-nc-cyan">Item</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Qty</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Unit €$</TableHead>
                  <TableHead className="font-display text-nc-cyan text-right">Total €$</TableHead>
                  <TableHead className="font-display text-nc-cyan">Fixer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs">
                {data.map((o) => (
                  <TableRow key={o.id} className="hover:bg-muted/50 border-border" data-testid={`row-wo-${o.id}`}>
                    <TableCell className="text-muted-foreground">{new Date(o.createdAt).toLocaleString()}</TableCell>
                    <TableCell className="text-foreground">{o.itemName ?? `#${o.wholesalerItemId}`}</TableCell>
                    <TableCell className="text-right">{o.quantity}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{o.unitWholesalePrice.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-nc-yellow">{o.totalCost.toLocaleString()}</TableCell>
                    <TableCell className="text-nc-cyan">{o.fixerName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

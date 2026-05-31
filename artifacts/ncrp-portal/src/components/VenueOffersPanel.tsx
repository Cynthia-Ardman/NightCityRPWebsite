import { useMemo } from "react";
import { type SaleOffer } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

function typeBadge(offer: SaleOffer) {
  const t = offer.offerType ?? "sale";
  if (t === "sale") return null;
  const cls =
    t === "install" ? "bg-nc-magenta text-background"
    : t === "remove" ? "bg-destructive text-destructive-foreground"
    : "bg-nc-cyan text-background";
  return (
    <Badge className={`rounded-none font-mono ${cls}`}>
      {t.toUpperCase()}
      {offer.cwp != null ? ` · ${offer.cwp} CWP` : ""}
    </Badge>
  );
}

function statusBadge(status: SaleOffer["status"]) {
  switch (status) {
    case "pending":
      return <Badge className="rounded-none bg-nc-yellow text-background font-mono">PENDING</Badge>;
    case "approved":
      return <Badge className="rounded-none bg-nc-green text-background font-mono">APPROVED</Badge>;
    case "denied":
      return <Badge className="rounded-none bg-destructive text-destructive-foreground font-mono">DENIED</Badge>;
    case "expired":
      return <Badge variant="outline" className="rounded-none font-mono text-muted-foreground">EXPIRED</Badge>;
    default:
      return <Badge variant="outline" className="rounded-none font-mono">{String(status).toUpperCase()}</Badge>;
  }
}

export default function VenueOffersPanel({ offers }: { offers: SaleOffer[] }) {
  const sorted = useMemo(
    () =>
      [...(offers ?? [])].sort(
        (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
      ),
    [offers],
  );

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest">SALE OFFERS</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {sorted.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground font-mono text-sm" data-testid="text-venue-offers-empty">
            No offers sent from this venue yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-sm min-w-[720px]">
              <thead className="border-b border-border bg-card">
                <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                  <th className="text-left p-3">Item</th>
                  <th className="text-left p-3">Buyer</th>
                  <th className="text-right p-3">Total</th>
                  <th className="text-right p-3">Commission</th>
                  <th className="text-left p-3">Date</th>
                  <th className="text-left p-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((o) => (
                  <tr
                    key={o.id}
                    className="border-b border-border/30 hover:bg-card/80 align-top"
                    data-testid={`row-venue-offer-${o.id}`}
                  >
                    <td className="p-3">
                      <div className="text-foreground flex items-center gap-2 flex-wrap">
                        <span>
                          {o.itemName}
                          {o.quantity > 1 && <span className="text-muted-foreground"> ×{o.quantity}</span>}
                        </span>
                        {typeBadge(o)}
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap">{o.buyerName ?? "—"}</td>
                    <td className="p-3 text-right text-nc-yellow whitespace-nowrap">
                      €${o.totalPrice.toLocaleString()}
                    </td>
                    <td className="p-3 text-right text-muted-foreground whitespace-nowrap">
                      {o.commissionPct > 0
                        ? `${o.commissionPct}%${
                            o.status === "approved" && o.commissionAmount != null
                              ? ` (€$${o.commissionAmount.toLocaleString()})`
                              : ""
                          }`
                        : "—"}
                    </td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap">
                      {o.decidedAt
                        ? new Date(o.decidedAt).toLocaleDateString()
                        : o.createdAt
                          ? new Date(o.createdAt).toLocaleDateString()
                          : "—"}
                    </td>
                    <td className="p-3">{statusBadge(o.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

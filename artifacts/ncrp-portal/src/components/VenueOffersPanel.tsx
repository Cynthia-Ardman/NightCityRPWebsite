import { useMemo } from "react";
import { type SaleOffer } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OfferTypeBadge, OfferStatusBadge } from "@/components/offers/offerBadges";

// Venue-side profit/loss for an offer. Sales/services/installs earn
// totalPrice minus the snapshotted acquisition cost (null cost = pure fee, all
// profit) minus any employee commission actually paid at approval. stock_add
// is the venue BUYING stock, so it shows as a negative (an expense). Free
// give-aways with no cost basis show as zero.
function offerProfit(o: SaleOffer): number | null {
  if (o.offerType === "stock_add") return -o.totalPrice;
  const gross = o.totalPrice - (o.costBasis ?? 0);
  const commission = o.status === "approved" && o.commissionAmount != null ? o.commissionAmount : 0;
  return gross - commission;
}

function ProfitCell({ offer }: { offer: SaleOffer }) {
  const profit = offerProfit(offer);
  if (profit === null) return <span className="text-muted-foreground">—</span>;
  // Only APPROVED offers realized money — color those green/red. Pending /
  // denied / expired rows show the projected number muted so the column never
  // reads like earnings that didn't happen.
  const realized = offer.status === "approved";
  const cls = !realized
    ? "text-muted-foreground"
    : profit > 0
      ? "text-nc-green"
      : profit < 0
        ? "text-destructive"
        : "text-muted-foreground";
  const sign = profit > 0 ? "+" : profit < 0 ? "−" : "";
  return (
    <span className={cls} data-testid={`text-offer-profit-${offer.id}`}>
      {sign}€${Math.abs(profit).toLocaleString()}
    </span>
  );
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
                  <th className="text-left p-3">Handled By</th>
                  <th className="text-right p-3">Total</th>
                  <th className="text-right p-3">Profit / Loss</th>
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
                        <OfferTypeBadge offer={o} />
                      </div>
                    </td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap">{o.buyerName ?? "—"}</td>
                    <td className="p-3 text-muted-foreground whitespace-nowrap" data-testid={`text-offer-seller-${o.id}`}>
                      {o.sellerName ?? "Owner"}
                    </td>
                    <td className="p-3 text-right text-nc-yellow whitespace-nowrap">
                      €${o.totalPrice.toLocaleString()}
                    </td>
                    <td className="p-3 text-right whitespace-nowrap">
                      <ProfitCell offer={o} />
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
                    <td className="p-3"><OfferStatusBadge status={o.status} /></td>
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

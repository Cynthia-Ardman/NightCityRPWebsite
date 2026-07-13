import { type SaleOffer } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

// Shared offer badges so the player My Offers view and the venue-owner offers
// panel render every offer type/status identically (previously the venue panel
// was missing install_owned / stock_add labels that players saw correctly).

// Single source of truth for "can the viewer act on this offer from My Offers?"
// The nav badge count and the page's pending list MUST share this predicate,
// or the badge counts rows the user can never clear (phantom badge).
export function offerNeedsMyDecision(o: SaleOffer): boolean {
  return (
    o.status === "pending" &&
    (o.offerType === "stock_add" || o.offerType === "install_owned" || o.offerType === "service")
  );
}

export function OfferTypeBadge({ offer }: { offer: SaleOffer }) {
  const t = offer.offerType ?? "sale";
  if (t === "sale") return null;
  const cls =
    t === "install" || t === "install_owned"
      ? "bg-nc-magenta text-background"
      : t === "remove"
        ? "bg-destructive text-destructive-foreground"
        : t === "stock_add"
          ? "bg-nc-yellow text-background"
          : "bg-nc-cyan text-background";
  const label =
    t === "stock_add" ? "STOCK ADD" : t === "install_owned" ? "INSTALL (OWNED)" : t === "service" ? "BILL" : t.toUpperCase();
  return (
    <Badge className={`rounded-none font-mono ${cls}`}>
      {label}
      {offer.cwp != null ? ` · ${offer.cwp} CWP` : ""}
    </Badge>
  );
}

export function OfferStatusBadge({ status }: { status: SaleOffer["status"] }) {
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

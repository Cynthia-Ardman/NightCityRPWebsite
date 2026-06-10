import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyOffers,
  useApproveOffer,
  useDenyOffer,
  getListMyOffersQueryKey,
  getGetMyWalletQueryKey,
  type SaleOffer,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ShoppingBag, Check, X } from "lucide-react";

function typeBadge(offer: SaleOffer) {
  const t = offer.offerType ?? "sale";
  if (t === "sale") return null;
  const cls =
    t === "install" || t === "install_owned" ? "bg-nc-magenta text-background"
    : t === "remove" ? "bg-destructive text-destructive-foreground"
    : t === "stock_add" ? "bg-nc-yellow text-background"
    : "bg-nc-cyan text-background";
  const label =
    t === "stock_add" ? "STOCK ADD"
    : t === "install_owned" ? "INSTALL (OWNED)"
    : t.toUpperCase();
  return (
    <Badge className={`rounded-none font-mono ${cls}`}>
      {label}
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

export default function MyOffers() {
  const { data: me } = useAuthMe();
  const qc = useQueryClient();
  const { data: offers, isLoading } = useListMyOffers();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListMyOffersQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
  };
  const approve = useApproveOffer({ mutation: { onSuccess: invalidate } });
  const deny = useDenyOffer({ mutation: { onSuccess: invalidate } });

  const { pending, history } = useMemo(() => {
    const all = (offers ?? []) as SaleOffer[];
    const sorted = [...all].sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
    const needsDecision = (o: SaleOffer) =>
      o.status === "pending" && (o.offerType === "stock_add" || o.offerType === "install_owned");
    return {
      pending: sorted.filter(needsDecision),
      history: sorted.filter((o) => !needsDecision(o)),
    };
  }, [offers]);

  const busy = approve.isPending || deny.isPending;
  const errMsg =
    (approve.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (deny.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    null;

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-my-offers-title"
        >
          <ShoppingBag className="w-8 h-8 text-nc-cyan" /> PENDING APPROVALS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          This is where offers involving your characters and the venues you own land. Two things need a decision from you: stock being added to one of your venues (approving charges that venue's account), and a ripperdoc offering to fit cyberware you already own (approving installs it and charges any fee they set). Denying does nothing. Direct sales to your characters complete instantly, so they skip straight to your offer history below.
        </p>
      </div>

      {errMsg && (
        <div className="border border-destructive/50 bg-destructive/10 px-4 py-2 font-mono text-sm text-destructive" data-testid="text-offer-error">
          {errMsg}
        </div>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-yellow">
            AWAITING YOUR DECISION
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!me ? (
            <div className="py-12 text-center text-muted-foreground font-mono text-sm">
              Log in to see offers sent to your characters.
            </div>
          ) : isLoading ? (
            <div className="py-12 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
          ) : pending.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground font-mono text-sm">
              No pending offers right now.
            </div>
          ) : (
            pending.map((o) => (
              <div
                key={o.id}
                className="border border-border/60 bg-card p-4 space-y-3"
                data-testid={`row-pending-offer-${o.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-display text-lg text-foreground truncate flex items-center gap-2">
                      <span className="truncate">
                        {o.itemName}
                        {o.quantity > 1 && <span className="text-muted-foreground"> ×{o.quantity}</span>}
                      </span>
                      {typeBadge(o)}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {o.itemCategory ? `${o.itemCategory} · ` : ""}
                      {o.venueName ?? (o.kind === "store" ? "Store" : "Ripperdoc")}
                      {o.buyerName ? ` · for ${o.buyerName}` : ""}
                    </div>
                    {o.memo && (
                      <div className="font-mono text-xs italic text-muted-foreground mt-1">"{o.memo}"</div>
                    )}
                    {o.offerType === "stock_add" && (
                      <div className="font-mono text-[11px] text-nc-yellow mt-1">
                        Adds to your venue's stock · charged to the venue account
                      </div>
                    )}
                    {o.offerType === "install_owned" && (
                      <div className="font-mono text-[11px] text-nc-magenta mt-1">
                        Fits cyberware you already own · approving installs it{o.totalPrice > 0 ? " and charges the fee" : " at no charge"}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-nc-yellow font-mono text-lg">€${o.totalPrice.toLocaleString()}</div>
                    <div className="text-muted-foreground font-mono text-[11px]">
                      €${o.unitPrice.toLocaleString()} / unit
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => deny.mutate({ id: o.id })}
                    className="rounded-none font-display text-destructive border-destructive/50 hover:bg-destructive hover:text-destructive-foreground"
                    data-testid={`button-deny-offer-${o.id}`}
                  >
                    <X className="w-4 h-4 mr-1" /> DENY
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => approve.mutate({ id: o.id })}
                    className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display"
                    data-testid={`button-approve-offer-${o.id}`}
                  >
                    <Check className="w-4 h-4 mr-1" /> APPROVE & PAY
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan">OFFER HISTORY</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {history.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground font-mono text-sm">
              No decided offers yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[640px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Item</th>
                    <th className="text-left p-3">Venue</th>
                    <th className="text-right p-3">Total</th>
                    <th className="text-left p-3">Date</th>
                    <th className="text-left p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((o) => (
                    <tr
                      key={o.id}
                      className="border-b border-border/30 hover:bg-card/80 align-top"
                      data-testid={`row-history-offer-${o.id}`}
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
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {o.venueName ?? (o.kind === "store" ? "Store" : "Ripperdoc")}
                      </td>
                      <td className="p-3 text-right text-nc-yellow whitespace-nowrap">
                        €${o.totalPrice.toLocaleString()}
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
    </div>
  );
}

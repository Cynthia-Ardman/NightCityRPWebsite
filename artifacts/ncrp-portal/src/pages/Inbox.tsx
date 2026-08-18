import { formatDate, formatEddies } from "@/lib/format";
import { apiErrorMessage } from "@/lib/apiError";
import { useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyOffers,
  useListMyOutgoingSellOffers,
  getListMyOutgoingSellOffersQueryKey,
  useApproveOffer,
  useDenyOffer,
  useListMyNcpdFines,
  usePayNcpdFine,
  useListMyCustomRequests,
  useDecideEmployeeInvite,
  useDecideMissionParticipation,
  getListMyOffersQueryKey,
  getGetMyWalletQueryKey,
  getListMyNcpdFinesQueryKey,
  getListMyCustomRequestsQueryKey,
  getGetMyUnseenQueryKey,
  type SaleOffer,
  type NcpdFine,
  type CustomRequest,
} from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Inbox as InboxIcon, Check, X, Banknote, Briefcase } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import EventTicketsPanel from "@/components/tickets/EventTicketsPanel";
import { OfferTypeBadge, OfferStatusBadge, offerNeedsMyDecision } from "@/components/offers/offerBadges";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";

// Custom-request types that are decided by the player (not submitted by them):
// employment invites and mission-participation confirmations. Shared with
// MySubmissions.tsx (which excludes them) and the AppLayout Inbox badge — the
// three lists must agree or the badge counts a row no page renders.
export const INBOX_REQUEST_TYPES = new Set<CustomRequest["type"]>([
  "employee_invite",
  "mission_participation",
]);

function fineApiError(err: unknown): string | null {
  return err ? apiErrorMessage(err, "Payment failed") : null;
}

export default function Inbox() {
  const { data: me } = useAuthMe();
  const [, setLocation] = useLocation();
  const search = useSearch();
  const tab = new URLSearchParams(search).get("tab") === "tickets" ? "tickets" : "inbox";
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: offers, isLoading } = useListMyOffers();
  const { data: outgoing } = useListMyOutgoingSellOffers();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListMyOffersQueryKey() });
    qc.invalidateQueries({ queryKey: getListMyOutgoingSellOffersQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
  };
  const approve = useApproveOffer({ mutation: { onSuccess: invalidate } });
  const deny = useDenyOffer({ mutation: { onSuccess: invalidate } });

  const { data: fines, isLoading: finesLoading } = useListMyNcpdFines();
  const invalidateFines = () => {
    qc.invalidateQueries({ queryKey: getListMyNcpdFinesQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
  };
  const payFine = usePayNcpdFine({ mutation: { onSuccess: invalidateFines } });
  const { unpaidFines, paidFines } = useMemo(() => {
    const all = (fines ?? []) as NcpdFine[];
    return {
      unpaidFines: all.filter((f) => f.status === "unpaid"),
      paidFines: all.filter((f) => f.status === "paid"),
    };
  }, [fines]);
  const fineErr = fineApiError(payFine.error);

  // Employment invites + mission-participation confirmations sent TO the
  // player. They live in custom_requests but are decided here, not on My
  // Submissions. The query is shared (same key) with the nav badge.
  const { data: customRequests, isLoading: invitesLoading } = useListMyCustomRequests();
  const { pendingInvites, decidedInvites } = useMemo(() => {
    const mine = ((customRequests ?? []) as CustomRequest[]).filter((r) => INBOX_REQUEST_TYPES.has(r.type));
    const sorted = [...mine].sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
    return {
      pendingInvites: sorted.filter((r) => r.status === "pending"),
      decidedInvites: sorted.filter((r) => r.status !== "pending"),
    };
  }, [customRequests]);
  const invalidateInvites = () => {
    qc.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyUnseenQueryKey() });
  };
  const errText = (err: unknown, fallback: string) => apiErrorMessage(err, fallback);
  const decideInvite = useDecideEmployeeInvite({
    mutation: {
      onSuccess: (_res, variables) => {
        invalidateInvites();
        toast({
          title:
            variables.data.decision === "accept"
              ? "Invitation accepted — you're hired"
              : "Invitation declined",
        });
      },
      onError: (err) => toast({ title: "Could not respond", description: errText(err, "Please try again."), variant: "destructive" }),
    },
  });
  const decideParticipation = useDecideMissionParticipation({
    mutation: {
      onSuccess: (_res, variables) => {
        invalidateInvites();
        toast({
          title:
            variables.data.decision === "accept"
              ? "Participation confirmed"
              : "Assignment declined",
        });
      },
      onError: (err) => toast({ title: "Could not respond", description: errText(err, "Please try again."), variant: "destructive" }),
    },
  });

  const { pending, history } = useMemo(() => {
    const all = (offers ?? []) as SaleOffer[];
    const sorted = [...all].sort(
      (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
    );
    const needsDecision = offerNeedsMyDecision;
    return {
      pending: sorted.filter(needsDecision),
      history: sorted.filter((o) => !needsDecision(o)),
    };
  }, [offers]);

  const busy = approve.isPending || deny.isPending;
  const errMsg = approve.error || deny.error
    ? apiErrorMessage(approve.error ?? deny.error, "Action failed")
    : null;

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-inbox-title"
        >
          <InboxIcon className="w-8 h-8 text-nc-cyan" /> INBOX
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Everything waiting on a decision from you: sale offers to your characters and venues, NCPD fines, employment invitations, and mission assignments — plus your event tickets. Items you submitted for staff review live on My Submissions.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setLocation(v === "tickets" ? "/inbox?tab=tickets" : "/inbox", { replace: true })}
      >
        <TabsList className="rounded-none bg-card border border-border">
          <TabsTrigger value="inbox" className="rounded-none font-display tracking-widest" data-testid="tab-inbox-main">
            OFFERS & DECISIONS
          </TabsTrigger>
          <TabsTrigger value="tickets" className="rounded-none font-display tracking-widest" data-testid="tab-inbox-tickets">
            EVENT TICKETS
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tickets" className="mt-6">
          <EventTicketsPanel />
        </TabsContent>

        <TabsContent value="inbox" className="mt-6 space-y-8">

      <h2 className="font-display text-sm tracking-widest text-nc-yellow" data-testid="text-inbox-waiting">
        WAITING ON YOU
      </h2>

      {errMsg && (
        <div className="border border-destructive/50 bg-destructive/10 px-4 py-2 font-mono text-sm text-destructive" data-testid="text-offer-error">
          {errMsg}
        </div>
      )}

      {fineErr && (
        <div className="border border-destructive/50 bg-destructive/10 px-4 py-2 font-mono text-sm text-destructive" data-testid="text-fine-error">
          {fineErr}
        </div>
      )}

      {me && (unpaidFines.length > 0 || paidFines.length > 0 || finesLoading) && (
        <Card className="rounded-none border-nc-yellow/40 bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-yellow flex items-center gap-2">
              <Banknote className="w-5 h-5" /> NCPD FINES
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-mono text-xs text-muted-foreground">
              Fines levied against your characters by NCPD officers. Paying one debits your wallet and notifies the issuing officer.
            </p>
            {finesLoading ? (
              <div className="py-8 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
            ) : unpaidFines.length === 0 ? (
              <div className="py-4 text-center text-muted-foreground font-mono text-sm">No outstanding fines.</div>
            ) : (
              unpaidFines.map((f) => (
                <div
                  key={f.id}
                  className="border border-nc-yellow/30 bg-card p-4 flex items-start justify-between gap-3"
                  data-testid={`row-unpaid-fine-${f.id}`}
                >
                  <div className="min-w-0">
                    <div className="font-display text-lg text-foreground">
                      {f.characterName ?? `Character #${f.characterId}`}
                    </div>
                    <div className="font-mono text-sm text-foreground/90 break-words">{f.reason}</div>
                    <div className="font-mono text-xs text-muted-foreground mt-1">
                      Issued {f.createdAt ? formatDate(f.createdAt) : "—"}
                      {f.officerName ? ` by ${f.officerName}` : ""}
                    </div>
                  </div>
                  <div className="text-right shrink-0 space-y-2">
                    <div className="text-nc-yellow font-mono text-lg">{formatEddies(f.amount)}</div>
                    <Button
                      size="sm"
                      disabled={payFine.isPending}
                      onClick={() => payFine.mutate({ id: f.id })}
                      className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display"
                      data-testid={`button-pay-fine-${f.id}`}
                    >
                      <Check className="w-4 h-4 mr-1" /> PAY
                    </Button>
                  </div>
                </div>
              ))
            )}
            {paidFines.length > 0 && (
              <div className="pt-2 border-t border-border/50 space-y-1">
                <p className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">Paid fines</p>
                {paidFines.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground"
                    data-testid={`row-paid-fine-${f.id}`}
                  >
                    <span className="truncate">
                      {f.characterName ?? `Character #${f.characterId}`} · {f.reason}
                    </span>
                    <span className="text-nc-green whitespace-nowrap">
                      {formatEddies(f.amount)} · PAID {f.paidAt ? formatDate(f.paidAt) : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {me && (pendingInvites.length > 0 || invitesLoading) && (
        <Card className="rounded-none border-nc-green/40 bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-green flex items-center gap-2">
              <Briefcase className="w-5 h-5" /> INVITATIONS & ASSIGNMENTS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-mono text-xs text-muted-foreground">
              Job offers from venue owners and mission assignments from fixers. Accepting an invitation hires your character; accepting an assignment confirms your spot on the mission roster.
            </p>
            {invitesLoading ? (
              <div className="py-8 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
            ) : (
              pendingInvites.map((r) => {
                const det = (r.details ?? {}) as { role?: string | null; commissionPct?: number | null; venueName?: string | null };
                const isInvite = r.type === "employee_invite";
                const mutation = isInvite ? decideInvite : decideParticipation;
                return (
                  <div
                    key={r.id}
                    className="border border-nc-green/30 bg-card p-4 flex items-start justify-between gap-3"
                    data-testid={`row-pending-invite-${r.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-display text-lg text-foreground">{r.title}</div>
                      <div className="font-mono text-xs text-muted-foreground mt-1">
                        {isInvite ? (
                          <span data-testid={`invite-terms-${r.id}`}>
                            {det.venueName ?? "Venue"} · {det.role ?? "employee"}
                            {det.commissionPct != null ? ` · ${det.commissionPct}% commission` : ""}
                            {` · for ${r.characterName}`}
                          </span>
                        ) : (
                          <span>Mission assignment · for {r.characterName}</span>
                        )}
                      </div>
                      {r.description ? (
                        <div className="font-mono text-xs italic text-muted-foreground mt-1 break-words">"{r.description}"</div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate({ id: r.id, data: { decision: "deny" } })}
                        className="rounded-none font-display text-destructive border-destructive/50 hover:bg-destructive hover:text-destructive-foreground"
                        data-testid={`button-${isInvite ? "invite" : "participation"}-deny-${r.id}`}
                      >
                        <X className="w-4 h-4 mr-1" /> {isInvite ? "DENY" : "DECLINE"}
                      </Button>
                      <Button
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => mutation.mutate({ id: r.id, data: { decision: "accept" } })}
                        className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display"
                        data-testid={`button-${isInvite ? "invite" : "participation"}-accept-${r.id}`}
                      >
                        <Check className="w-4 h-4 mr-1" /> ACCEPT
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
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
                      <OfferTypeBadge offer={o} />
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {o.itemCategory ? `${o.itemCategory} · ` : ""}
                      {o.venueName ?? (o.kind === "store" ? "Store" : "Clinic")}
                      {o.buyerName ? ` · for ${o.buyerName}` : ""}
                    </div>
                    {o.memo && (
                      <div className="font-mono text-xs italic text-muted-foreground mt-1">"{o.memo}"</div>
                    )}
                    {o.offerType === "player_sell" && (
                      <div className="font-mono text-[11px] text-nc-yellow mt-1">
                        A player wants to sell this to your venue · approving pays them from the venue account and adds the item to your stock
                      </div>
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
                    {o.offerType === "service" && (
                      <div className="font-mono text-[11px] text-nc-cyan mt-1">
                        A bill for services rendered · approving pays it from your wallet
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-nc-yellow font-mono text-lg">{formatEddies(o.totalPrice)}</div>
                    <div className="text-muted-foreground font-mono text-[11px]">
                      {formatEddies(o.unitPrice)} / unit
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

      {(outgoing ?? []).length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-yellow">MY SELL OFFERS</CardTitle>
            <p className="text-muted-foreground font-mono text-xs">
              Items you've offered to sell to a venue — the shop owner confirms the price before anything moves.
            </p>
          </CardHeader>
          <CardContent className="space-y-1">
            {(outgoing ?? []).map((o) => (
              <div
                key={o.id}
                className="flex items-center justify-between gap-3 font-mono text-xs py-1"
                data-testid={`row-outgoing-offer-${o.id}`}
              >
                <span className="truncate text-muted-foreground">
                  {o.itemName}
                  {o.quantity > 1 ? ` ×${o.quantity}` : ""} → {o.venueName ?? (o.kind === "store" ? "Store" : "Clinic")}
                  <span className="text-nc-yellow"> · {formatEddies(o.totalPrice)}</span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {o.createdAt ? formatDate(o.createdAt) : ""}
                  <OfferStatusBadge status={o.status} />
                  {o.status === "pending" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => deny.mutate({ id: o.id })}
                      className="rounded-none font-display text-destructive h-7 px-2"
                      data-testid={`button-withdraw-offer-${o.id}`}
                    >
                      WITHDRAW
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <h2 className="font-display text-sm tracking-widest text-nc-cyan" data-testid="text-inbox-history">
        HISTORY
      </h2>

      {me && decidedInvites.length > 0 && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-green">
              DECIDED INVITATIONS & ASSIGNMENTS
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {decidedInvites.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 font-mono text-xs text-muted-foreground py-1"
                data-testid={`row-decided-invite-${r.id}`}
              >
                <span className="truncate">
                  {r.title} · {r.characterName}
                  {r.type === "employee_invite" ? " · employment" : " · mission"}
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {r.reviewedAt ? formatDate(r.reviewedAt) : ""}
                  <RequestStatusBadge status={r.status} />
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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
                          <OfferTypeBadge offer={o} />
                        </div>
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {o.venueName ?? (o.kind === "store" ? "Store" : "Clinic")}
                      </td>
                      <td className="p-3 text-right text-nc-yellow whitespace-nowrap">
                        {formatEddies(o.totalPrice)}
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {o.decidedAt
                          ? formatDate(o.decidedAt)
                          : o.createdAt
                            ? formatDate(o.createdAt)
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
        </TabsContent>
      </Tabs>
    </div>
  );
}

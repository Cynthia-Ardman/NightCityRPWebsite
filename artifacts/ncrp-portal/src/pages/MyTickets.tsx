import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListMyTickets,
  useRefundEventTicket,
  getListMyTicketsQueryKey,
  getGetEventQueryKey,
  type EventTicketView,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ticket } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

function errOf(e: unknown): string | null {
  const r = (e as { response?: { data?: { error?: string } } } | null)?.response?.data?.error;
  return r ?? (e ? "Request failed" : null);
}

function statusBadge(t: EventTicketView) {
  if (t.eventStatus === "cancelled") {
    return (
      <Badge variant="outline" className="rounded-none text-[10px] border-destructive text-destructive bg-destructive/10">
        Event cancelled
      </Badge>
    );
  }
  if (t.status === "refunded") {
    return (
      <Badge variant="outline" className="rounded-none text-[10px] border-destructive text-destructive bg-destructive/10">
        Refunded
      </Badge>
    );
  }
  if (t.attendedAt) {
    return (
      <Badge variant="outline" className="rounded-none text-[10px] border-green-500 text-green-400 bg-green-500/10">
        Attended
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="rounded-none text-[10px] border-nc-cyan text-nc-cyan bg-nc-cyan/10">
      Valid
    </Badge>
  );
}

export default function MyTickets() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: tickets, isLoading } = useListMyTickets({
    query: { queryKey: getListMyTicketsQueryKey() },
  });
  const refund = useRefundEventTicket({
    mutation: {
      onSuccess: (_res, vars) => {
        qc.invalidateQueries({ queryKey: getListMyTicketsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetEventQueryKey(vars.id) });
        toast({ title: "Ticket refunded", description: "The money is back in your wallet." });
      },
      onError: (e) => {
        toast({ title: "Refund failed", description: errOf(e) ?? "Please try again.", variant: "destructive" });
      },
    },
  });

  const rows = tickets ?? [];
  const now = Date.now();
  const upcoming = rows.filter((t) => new Date(t.eventEndAt).getTime() >= now && t.eventStatus !== "cancelled");
  const past = rows.filter((t) => new Date(t.eventEndAt).getTime() < now || t.eventStatus === "cancelled");

  const renderRow = (t: EventTicketView) => (
    <li key={t.id} className="py-3 flex items-start gap-3" data-testid={`row-my-ticket-${t.id}`}>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/events/${t.eventId}`} className="text-nc-cyan hover:underline">
            {t.eventTitle}
          </Link>
          <span className="text-foreground text-xs">{t.ticketTypeName}</span>
          <span className="text-muted-foreground text-xs">
            {t.pricePaid > 0 ? `€$${t.pricePaid.toLocaleString()}` : "free"}
          </span>
          {statusBadge(t)}
        </div>
        <p className="text-muted-foreground text-xs">
          {new Date(t.eventStartAt).toLocaleString()}
          {t.eventLocation ? ` · ${t.eventLocation}` : ""}
        </p>
      </div>
      {t.status === "purchased" && !t.attendedAt && t.eventStatus === "scheduled" && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={refund.isPending}
          onClick={() => {
            if (window.confirm("Refund this ticket? The money returns to your wallet.")) {
              refund.mutate({ id: t.eventId, ticketId: t.id });
            }
          }}
          className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest shrink-0"
          data-testid={`button-refund-${t.id}`}
        >
          REFUND
        </Button>
      )}
    </li>
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <h1 className="text-4xl font-display flex items-center gap-3" data-testid="text-my-tickets-title">
        <Ticket className="w-7 h-7 text-nc-cyan" /> MY TICKETS
      </h1>

      {isLoading ? (
        <div className="font-mono text-nc-cyan animate-pulse">Loading tickets...</div>
      ) : rows.length === 0 ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="pt-6">
            <p className="font-mono text-muted-foreground italic" data-testid="text-no-tickets">
              You haven't bought any event tickets yet. Ticketed events show a Tickets section on their{" "}
              <Link href="/directory/calendar" className="text-nc-cyan hover:underline">
                calendar
              </Link>{" "}
              page.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest text-xs uppercase text-nc-cyan">
                Upcoming ({upcoming.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="font-mono text-sm">
              {upcoming.length === 0 ? (
                <p className="text-muted-foreground italic">No upcoming tickets.</p>
              ) : (
                <ul className="divide-y divide-border/40">{upcoming.map(renderRow)}</ul>
              )}
            </CardContent>
          </Card>
          {past.length > 0 && (
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader>
                <CardTitle className="font-display tracking-widest text-xs uppercase text-muted-foreground">
                  Past &amp; cancelled ({past.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="font-mono text-sm">
                <ul className="divide-y divide-border/40">{past.map(renderRow)}</ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

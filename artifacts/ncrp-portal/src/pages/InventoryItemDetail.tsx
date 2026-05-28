import { Link, useParams } from "wouter";
import { useGetInventoryItemHistory } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Package, ArrowRight, Scissors, Pencil, Trash2, Plus, History } from "lucide-react";

const KIND_META: Record<string, { label: string; color: string; Icon: any }> = {
  created: { label: "Created", color: "text-nc-cyan border-nc-cyan", Icon: Plus },
  transferred: { label: "Transferred", color: "text-nc-yellow border-nc-yellow", Icon: ArrowRight },
  sold: { label: "Sold", color: "text-nc-yellow border-nc-yellow", Icon: ArrowRight },
  split: { label: "Split", color: "text-nc-magenta border-nc-magenta", Icon: Scissors },
  adjusted: { label: "Adjusted", color: "text-muted-foreground border-border", Icon: Pencil },
  consumed: { label: "Consumed", color: "text-destructive border-destructive", Icon: Trash2 },
  destroyed: { label: "Destroyed", color: "text-destructive border-destructive", Icon: Trash2 },
  history_begins: { label: "History begins", color: "text-muted-foreground border-border", Icon: History },
};

export default function InventoryItemDetail() {
  const params = useParams();
  const uuid = String(params.uuid ?? "");
  const { data, isLoading, error } = useGetInventoryItemHistory(uuid);

  if (isLoading) {
    return <div className="max-w-4xl mx-auto p-6 text-nc-cyan font-mono animate-pulse">Tracing chain of custody...</div>;
  }
  if (error || !data) {
    return (
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <Link href="/characters"><Button variant="ghost" className="text-nc-cyan"><ArrowLeft className="w-4 h-4 mr-2" />BACK</Button></Link>
        <Card className="rounded-none border-destructive bg-card/50">
          <CardContent className="p-6 font-mono text-destructive">
            Unable to load item history. You may not own this item, or it no longer exists.
          </CardContent>
        </Card>
      </div>
    );
  }
  const { item, currentCharacter, events } = data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <Link href={currentCharacter ? `/characters/${currentCharacter.id}` : "/characters"}>
          <Button variant="ghost" className="text-nc-cyan" data-testid="link-back">
            <ArrowLeft className="w-4 h-4 mr-2" />BACK
          </Button>
        </Link>
      </div>

      <Card className="rounded-none border-nc-cyan bg-card/50">
        <CardHeader>
          <div className="flex items-center gap-3">
            <Package className="w-6 h-6 text-nc-cyan" />
            <div>
              <CardTitle className="font-display tracking-widest text-2xl text-nc-cyan" data-testid="text-item-name">
                {item?.name ?? events[events.length - 1]?.itemName ?? "ITEM"}
              </CardTitle>
              <div className="text-xs font-mono text-muted-foreground mt-1">
                UUID: <span className="text-foreground">{uuid}</span>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-3 gap-4 font-mono text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Current Holder</div>
            <div className="text-foreground" data-testid="text-current-holder">
              {currentCharacter ? (
                <Link href={`/directory/characters/${currentCharacter.id}`} className="text-nc-cyan hover:underline">
                  {currentCharacter.name}
                </Link>
              ) : (
                <span className="text-destructive italic">No live instance</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Quantity</div>
            <div className="text-foreground">{item ? `x${item.quantity}` : "—"}</div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Category</div>
            <div className="text-foreground uppercase">{item?.category ?? "—"}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">CHAIN OF CUSTODY ({events.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <div className="text-muted-foreground font-mono italic">No recorded events.</div>
          ) : (
            <ol className="relative border-l-2 border-border ml-3 space-y-4" data-testid="list-events">
              {events.map((ev) => {
                const meta = KIND_META[ev.kind] ?? { label: ev.kind, color: "text-foreground border-border", Icon: History };
                const Icon = meta.Icon;
                return (
                  <li key={ev.id} className="ml-6" data-testid={`event-${ev.id}`}>
                    <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full bg-background border-2 ${meta.color}`}>
                      <Icon className="w-3 h-3" />
                    </span>
                    <div className="border border-border/60 p-3 bg-background/50 font-mono text-sm space-y-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <Badge variant="outline" className={`rounded-none ${meta.color}`}>{meta.label.toUpperCase()}</Badge>
                        <span className="text-xs text-muted-foreground">{new Date(ev.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="text-foreground">
                        {ev.fromCharacterName && (
                          <>
                            <span className="text-nc-cyan">{ev.fromCharacterName}</span>
                            {ev.toCharacterName ? <> <ArrowRight className="inline w-3 h-3 mx-1" /> </> : " "}
                          </>
                        )}
                        {ev.toCharacterName && <span className="text-nc-cyan">{ev.toCharacterName}</span>}
                        {ev.quantity != null && <span className="text-muted-foreground"> · x{ev.quantity}</span>}
                        {ev.price != null && <span className="text-nc-yellow"> · €${ev.price}</span>}
                      </div>
                      {ev.reason && <div className="text-muted-foreground italic">"{ev.reason}"</div>}
                      {ev.actorName && (
                        <div className="text-xs text-muted-foreground">by {ev.actorName}</div>
                      )}
                      {ev.metadata && Object.keys(ev.metadata).length > 0 && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer hover:text-nc-cyan">metadata</summary>
                          <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(ev.metadata, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { useState } from "react";
import { Link } from "wouter";
import { useSearchInventoryByOwner, getSearchInventoryByOwnerQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Search, Package, ArrowRight } from "lucide-react";

export default function FixerInventorySearch() {
  const [qInput, setQInput] = useState("");
  const [ownerInput, setOwnerInput] = useState("");
  const [params, setParams] = useState<{ q?: string; owner?: string } | null>(null);
  const queryParams = params ?? {};
  const { data, isFetching } = useSearchInventoryByOwner(queryParams, {
    query: {
      queryKey: getSearchInventoryByOwnerQueryKey(queryParams),
      enabled: !!params && (!!params.q || !!params.owner),
    },
  });

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-display tracking-widest text-nc-cyan">ITEM TRACE</h1>
        <p className="text-sm text-muted-foreground font-mono mt-1">
          Find any item across all characters by name or by current/past owner. Fixer/admin only.
        </p>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="p-4">
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ q: qInput.trim() || undefined, owner: ownerInput.trim() || undefined });
            }}
          >
            <div className="sm:col-span-5">
              <Label className="text-xs font-mono">ITEM NAME</Label>
              <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="e.g. Militech 5.56" data-testid="input-q" />
            </div>
            <div className="sm:col-span-5">
              <Label className="text-xs font-mono">OWNER (CURRENT OR PAST)</Label>
              <Input value={ownerInput} onChange={(e) => setOwnerInput(e.target.value)} placeholder="character name" data-testid="input-owner" />
            </div>
            <div className="sm:col-span-2">
              <Button
                type="submit"
                disabled={!qInput.trim() && !ownerInput.trim()}
                className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
                data-testid="button-search"
              >
                <Search className="w-4 h-4 mr-2" /> SEARCH
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {isFetching && <div className="text-nc-cyan font-mono animate-pulse">Scanning the net...</div>}

      {data && (
        <>
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display tracking-widest">LIVE ITEMS ({data.items.length})</CardTitle>
            </CardHeader>
            <CardContent>
              {data.items.length === 0 ? (
                <div className="text-muted-foreground font-mono italic">No live items match.</div>
              ) : (
                <div className="space-y-2 font-mono text-sm" data-testid="list-live-items">
                  {data.items.map((it) => (
                    <Link key={it.id} href={`/items/${it.instanceUuid}`}>
                      <a className="grid grid-cols-12 gap-2 border border-border/40 hover:border-nc-cyan p-2 items-center cursor-pointer" data-testid={`row-live-${it.instanceUuid}`}>
                        <Package className="w-4 h-4 text-nc-cyan col-span-1" />
                        <span className="col-span-3 text-foreground">{it.name}</span>
                        <span className="col-span-2 text-nc-cyan uppercase truncate">{it.category ?? "—"}</span>
                        <span className="col-span-1 text-right">x{it.quantity}</span>
                        <span className="col-span-3 text-muted-foreground truncate">
                          {it.characterName ?? <span className="italic text-destructive">unclaimed</span>}
                          {it.ownerUsername && <span className="text-xs"> ({it.ownerUsername})</span>}
                        </span>
                        <span className="col-span-2 text-xs text-muted-foreground truncate">{it.instanceUuid.slice(0, 8)}…</span>
                      </a>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {ownerInput.trim() && (
            <Card className="rounded-none border-border bg-card/50">
              <CardHeader>
                <CardTitle className="font-display tracking-widest">PAST-OWNER EVENTS ({data.pastOwners.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {data.pastOwners.length === 0 ? (
                  <div className="text-muted-foreground font-mono italic">No past-owner events match.</div>
                ) : (
                  <div className="space-y-2 font-mono text-sm" data-testid="list-past-events">
                    {data.pastOwners.map(({ event, liveItem }) => (
                      <Link key={event.id} href={`/items/${event.instanceUuid}`}>
                        <a className="block border border-border/40 hover:border-nc-cyan p-2 cursor-pointer" data-testid={`row-event-${event.id}`}>
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <div>
                              <Badge variant="outline" className="rounded-none text-nc-yellow border-nc-yellow mr-2">{event.kind.toUpperCase()}</Badge>
                              <span className="text-foreground">{event.itemName}</span>
                              {event.quantity != null && <span className="text-muted-foreground"> x{event.quantity}</span>}
                            </div>
                            <span className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</span>
                          </div>
                          <div className="mt-1 text-muted-foreground">
                            {event.fromCharacterName && <span className="text-nc-cyan">{event.fromCharacterName}</span>}
                            {event.fromCharacterName && event.toCharacterName && <ArrowRight className="inline w-3 h-3 mx-1" />}
                            {event.toCharacterName && <span className="text-nc-cyan">{event.toCharacterName}</span>}
                            {liveItem ? (
                              <span className="text-xs ml-2">(still live)</span>
                            ) : (
                              <span className="text-xs text-destructive ml-2">(no live instance)</span>
                            )}
                          </div>
                        </a>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

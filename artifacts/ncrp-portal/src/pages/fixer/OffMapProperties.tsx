import { useMemo, useState } from "react";
import { formatEddies } from "@/lib/format";
import { Link } from "wouter";
import { useListOffMapProperties } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building2, Home, Store, ArrowRight } from "lucide-react";

type Filter = "all" | "residential" | "business";

// Staff-only browser for every off-map lease — homes (residential) and business
// spaces not tied to a catalog building. Business rows surface the store /
// ripperdoc they back, so staff can see at a glance what a lease is for.
export default function OffMapProperties() {
  const { data, isLoading, isError } = useListOffMapProperties();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? []).filter((r) => {
      if (filter !== "all" && r.kind !== filter) return false;
      if (!term) return true;
      return (
        r.characterName.toLowerCase().includes(term) ||
        (r.ownerName ?? "").toLowerCase().includes(term) ||
        r.address.toLowerCase().includes(term) ||
        (r.district ?? "").toLowerCase().includes(term) ||
        (r.venueName ?? "").toLowerCase().includes(term)
      );
    });
  }, [data, q, filter]);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Building2 className="h-7 w-7" /> OFF-MAP PROPERTIES
        </h1>
        <p className="text-sm text-muted-foreground font-mono mt-1">
          Every off-map lease — residential homes and business spaces that aren&apos;t a catalog
          building. Business leases show the venue (store / ripperdoc) they back. Fixer/admin only.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="SEARCH CHARACTER / OWNER / ADDRESS / VENUE..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-off-map"
        />
        <div className="flex gap-2">
          {(["all", "residential", "business"] as Filter[]).map((f) => (
            <Button
              key={f}
              type="button"
              variant={filter === f ? "default" : "outline"}
              className="rounded-none font-display text-xs tracking-widest"
              onClick={() => setFilter(f)}
              data-testid={`filter-off-map-${f}`}
            >
              {f.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-mono animate-pulse">Loading off-map leases...</div>
      ) : isError ? (
        <Card className="rounded-none border-destructive/50 bg-card/50">
          <CardContent className="p-8 text-center font-mono text-destructive">
            Could not load off-map properties. Try refreshing.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="p-8 text-center font-mono text-muted-foreground">
            No off-map properties match.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3" data-testid="list-off-map-properties">
          {rows.map((r) => {
            const isBusiness = r.kind === "business";
            const Icon = isBusiness ? Store : Home;
            return (
              <Card
                key={r.id}
                className="rounded-none border-border bg-card/50 hover:border-nc-cyan transition-colors"
                data-testid={`row-off-map-${r.id}`}
              >
                <CardContent className="p-4 flex flex-wrap items-center justify-between gap-4 font-mono text-sm">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${isBusiness ? "text-nc-magenta" : "text-nc-cyan"}`} />
                      <span className="text-foreground truncate">{r.address}</span>
                      <Badge
                        variant="outline"
                        className={`rounded-none uppercase text-[10px] ${isBusiness ? "border-nc-magenta text-nc-magenta" : "border-nc-cyan text-nc-cyan"}`}
                      >
                        {r.kind}
                      </Badge>
                      {r.delinquent && (
                        <Badge variant="destructive" className="rounded-none uppercase text-[10px]">
                          Delinquent
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {r.characterName}
                      {r.ownerName ? ` · ${r.ownerName}` : " · — unclaimed —"}
                      {r.district ? ` · ${r.district}` : ""}
                      {r.tier ? ` · ${r.tier}` : ""}
                      {` · ${formatEddies(r.monthlyRent)}/mo`}
                      {r.venueName ? ` · backs ${r.venueName}` : ""}
                    </div>
                  </div>
                  <Link href={`/directory/characters/${r.characterId}`}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-nc-cyan rounded-none font-display"
                      data-testid={`button-view-off-map-${r.id}`}
                    >
                      VIEW <ArrowRight className="h-4 w-4 ml-1" />
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { Link } from "wouter";
import { useGetCyberwareViolations } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ArrowRight } from "lucide-react";

export default function CyberwareViolations() {
  const { data, isLoading, isError } = useGetCyberwareViolations();

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6 pb-12">
      <div>
        <h1 className="text-3xl font-display tracking-widest text-nc-cyan">SLOT VIOLATIONS</h1>
        <p className="text-sm text-muted-foreground font-mono mt-1">
          Player characters holding more than one cyberware item in a single body slot. Each capped
          slot allows only one piece — Miscellaneous and Custom/one-off chrome are unlimited. NPCs
          are exempt. Fixer/admin only.
        </p>
      </div>

      {isLoading ? (
        <div className="text-nc-cyan font-mono animate-pulse">Scanning chrome registry...</div>
      ) : isError ? (
        <Card className="rounded-none border-destructive/50 bg-card/50">
          <CardContent className="p-8 text-center font-mono text-destructive">
            Could not load slot violations. Try refreshing.
          </CardContent>
        </Card>
      ) : !data || data.length === 0 ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="p-8 text-center font-mono text-muted-foreground">
            No slot violations. Every player&apos;s chrome is within the one-per-slot limit.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4" data-testid="list-cyberware-violations">
          {data.map((v) => (
            <Card
              key={v.characterId}
              className="rounded-none border-destructive/50 bg-card/50"
              data-testid={`row-violation-${v.characterId}`}
            >
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="font-display tracking-widest text-foreground flex items-center gap-2">
                    <ShieldAlert className="h-5 w-5 text-destructive" />
                    {v.characterName}
                  </CardTitle>
                  <p className="text-xs font-mono text-muted-foreground mt-1">
                    Owner: {v.ownerUsername ?? "— unclaimed —"}
                  </p>
                </div>
                <Link href={`/directory/characters/${v.characterId}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-nc-cyan rounded-none font-display"
                    data-testid={`button-view-${v.characterId}`}
                  >
                    VIEW <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </Link>
              </CardHeader>
              <CardContent className="space-y-3 font-mono text-sm">
                {v.slots.map((s) => (
                  <div key={s.slot} className="border border-border/40 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="destructive" className="rounded-none uppercase">
                        {s.slot}
                      </Badge>
                      <span className="text-muted-foreground">{s.count} items</span>
                    </div>
                    <ul className="list-disc list-inside text-foreground space-y-1">
                      {s.items.map((it) => (
                        <li key={it.id}>{it.name}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { Link } from "wouter";
import {
  useGetCyberwareViolations,
  useNotifyCyberwareViolators,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ShieldAlert, ArrowRight, Bell, Loader2 } from "lucide-react";

export default function CyberwareViolations() {
  const { data, isLoading, isError } = useGetCyberwareViolations();
  const { toast } = useToast();
  const [lastResult, setLastResult] = useState<{
    notified: number;
    skippedUnclaimed: string[];
    skippedCooldown: number;
  } | null>(null);

  const notify = useNotifyCyberwareViolators({
    mutation: {
      onSuccess: (result) => {
        setLastResult(result);
        const parts: string[] = [];
        if (result.notified > 0) {
          parts.push(`${result.notified} player${result.notified !== 1 ? "s" : ""} notified`);
        }
        if (result.skippedCooldown > 0) {
          parts.push(`${result.skippedCooldown} skipped (already notified today)`);
        }
        if (result.skippedUnclaimed.length > 0) {
          parts.push(`${result.skippedUnclaimed.length} unclaimed character${result.skippedUnclaimed.length !== 1 ? "s" : ""} skipped`);
        }
        if (result.notified === 0 && result.skippedCooldown === 0 && result.skippedUnclaimed.length === 0) {
          toast({ title: "No violators to notify", description: "All violations have been resolved." });
        } else {
          toast({
            title: "Notifications sent",
            description: parts.join(" · "),
          });
        }
      },
      onError: () => {
        toast({
          title: "Notification failed",
          description: "Could not send notifications. Try again.",
          variant: "destructive",
        });
      },
    },
  });

  const hasViolations = data && data.length > 0;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-display tracking-widest text-nc-cyan">SLOT VIOLATIONS</h1>
          <p className="text-sm text-muted-foreground font-mono mt-1">
            Player characters holding more than one cyberware item in a single body slot. Each capped
            slot allows only one piece — Miscellaneous and Custom/one-off chrome are unlimited. NPCs
            are exempt. Fixer/admin only.
          </p>
        </div>

        {hasViolations && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10 font-display shrink-0"
                disabled={notify.isPending}
                data-testid="button-notify-violators"
              >
                {notify.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Bell className="h-4 w-4 mr-2" />
                )}
                NOTIFY VIOLATORS
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent className="rounded-none">
              <AlertDialogHeader>
                <AlertDialogTitle className="font-display tracking-widest">
                  Notify all violators?
                </AlertDialogTitle>
                <AlertDialogDescription className="font-mono text-sm space-y-2">
                  <span className="block">
                    This will send a portal notification to every player with a slot violation,
                    listing their conflicting cyberware and asking them to resolve it.
                    Players with a linked Discord account will also receive a DM.
                  </span>
                  <span className="block text-muted-foreground">
                    Players notified in the last 24 hours will be skipped. Unclaimed characters
                    (no portal owner) will also be skipped and listed in the result.
                  </span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="rounded-none">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => notify.mutate()}
                >
                  Send notifications
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Result summary after a notify run */}
      {lastResult && (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="p-4 font-mono text-sm space-y-1">
            <p className="font-semibold text-foreground">Last notification run:</p>
            <p>
              <span className="text-nc-cyan">{lastResult.notified}</span> player
              {lastResult.notified !== 1 ? "s" : ""} notified
              {lastResult.skippedCooldown > 0 && (
                <span className="text-muted-foreground">
                  {" · "}
                  {lastResult.skippedCooldown} skipped (already notified today)
                </span>
              )}
            </p>
            {lastResult.skippedUnclaimed.length > 0 && (
              <div>
                <p className="text-muted-foreground">
                  Unclaimed characters skipped (no portal owner):
                </p>
                <ul className="list-disc list-inside text-muted-foreground ml-2">
                  {lastResult.skippedUnclaimed.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

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

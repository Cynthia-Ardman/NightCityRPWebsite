import { useAdminGetEconomyOutOfSync, useAdminRetryEconomySync, getAdminGetEconomyOutOfSyncQueryKey } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export function EconomyTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isFetching, refetch } = useAdminGetEconomyOutOfSync();
  const retry = useAdminRetryEconomySync({
    mutation: {
      onSuccess: (res: any) => {
        toast({ title: "Re-sync complete", description: `Status: ${res?.status ?? "ok"}` });
        qc.invalidateQueries({ queryKey: getAdminGetEconomyOutOfSyncQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Re-sync failed", description: err?.message ?? "Error", variant: "destructive" });
      },
    },
  });

  const mode = data?.mode;
  const entries = data?.entries ?? [];
  const modeColor =
    mode === "enabled" ? "text-nc-cyan" : mode === "test" ? "text-nc-yellow" : "text-muted-foreground";

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="font-display tracking-widest">Economy Sync</CardTitle>
          <CardDescription className="font-mono">
            Players whose website wallet has drifted from UnbelievaBoat, failed to sync, or can't be reached.
          </CardDescription>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs uppercase">
            Mode: <span className={modeColor} data-testid="text-economy-mode">{mode ?? "…"}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="rounded-none font-display"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-economy-refresh"
          >
            {isFetching ? "REFRESHING…" : "REFRESH"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="font-mono text-sm text-muted-foreground animate-pulse">LOADING…</p>
        ) : entries.length === 0 ? (
          <p className="font-mono text-sm text-nc-cyan py-4" data-testid="text-economy-empty">
            All linked wallets are in sync.
          </p>
        ) : (
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-display text-nc-cyan">Player</TableHead>
                <TableHead className="font-display text-nc-cyan text-right">Website</TableHead>
                <TableHead className="font-display text-nc-cyan text-right">UnbelievaBoat</TableHead>
                <TableHead className="font-display text-nc-cyan text-right">Diff</TableHead>
                <TableHead className="font-display text-nc-cyan">Last Sync</TableHead>
                <TableHead className="font-display text-nc-cyan">Status</TableHead>
                <TableHead className="font-display text-nc-cyan text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-xs">
              {entries.map((e) => (
                <TableRow key={e.userId} data-testid={`row-economy-${e.userId}`}>
                  <TableCell>{e.globalName || e.username}</TableCell>
                  <TableCell className="text-right">{e.walletBalance.toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    {e.ubBalance === null || e.ubBalance === undefined ? (
                      <span className="text-destructive">unreachable</span>
                    ) : (
                      e.ubBalance.toLocaleString()
                    )}
                  </TableCell>
                  <TableCell className={`text-right ${e.diff ? "text-nc-yellow" : ""}`}>
                    {e.diff === null || e.diff === undefined ? "—" : `${e.diff > 0 ? "+" : ""}${e.diff.toLocaleString()}`}
                  </TableCell>
                  <TableCell>{e.lastSyncedAt ? formatDateTime(e.lastSyncedAt) : "never"}</TableCell>
                  <TableCell>
                    <span className={e.lastSyncStatus === "failed" ? "text-destructive" : "text-muted-foreground"}>
                      {e.lastSyncStatus ?? "—"}
                    </span>
                    {e.lastSyncError ? (
                      <span className="block text-destructive/70 truncate max-w-[16rem]">{e.lastSyncError}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      className="rounded-none bg-nc-cyan text-background font-display"
                      disabled={retry.isPending || mode === "disabled"}
                      onClick={() => retry.mutate({ userId: e.userId })}
                      data-testid={`button-economy-retry-${e.userId}`}
                    >
                      RE-SYNC
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

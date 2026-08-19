import { formatDateTime } from "@/lib/format";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

type NpcScanUser = {
  id?: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
};

type NpcScanResult = {
  determined: boolean;
  truncated?: boolean;
  scannedAt?: string;
  guildNpcCount?: number;
  websiteNpcCount?: number;
  websiteNpcUsers?: NpcScanUser[];
  guildOnlyCount?: number;
  error?: string;
};

// Read-only Discord scan: lists everyone holding the self-service NPC role and
// matches them against portal accounts, so staff can confirm the "Become an
// NPC" prompt hides for users who already have the role.
export function NpcRoleScanCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<NpcScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runScan() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/npc-scan", { credentials: "include" });
      const data = (await r.json()) as NpcScanResult;
      if (!r.ok || !data.determined) {
        setResult(null);
        setError(data.error ?? "Scan failed.");
        toast({ title: "NPC scan failed", variant: "destructive" });
      } else {
        setResult(data);
        toast({
          title: "NPC scan complete",
          description: `${data.websiteNpcCount ?? 0} portal user(s) hold the NPC role.`,
        });
      }
    } catch {
      setResult(null);
      setError("Could not run the scan.");
      toast({ title: "NPC scan failed", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="font-display text-nc-cyan">NPC Role Scan</CardTitle>
          <CardDescription className="font-mono">
            Scans Discord for everyone holding the self-service NPC role and matches them against portal accounts.
            Confirms the "Become an NPC" prompt hides for users who already have the role. Read-only — nothing is changed.
          </CardDescription>
        </div>
        <Button
          size="sm"
          disabled={loading}
          onClick={runScan}
          className="rounded-none bg-nc-cyan text-background font-display shrink-0"
          data-testid="button-npc-scan"
        >
          {loading ? "SCANNING..." : "SCAN DISCORD"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="font-mono text-xs text-destructive" data-testid="text-npc-scan-error">{error}</div>
        )}
        {result?.truncated && (
          <div className="font-mono text-xs text-nc-magenta" data-testid="text-npc-scan-truncated">
            ⚠ Member scan hit its page limit — counts may be undercounted. Re-run to confirm.
          </div>
        )}
        {result && (
          <>
            <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
              <span className="text-nc-cyan">
                PORTAL USERS WITH NPC ROLE: <span className="text-foreground" data-testid="text-npc-website-count">{result.websiteNpcCount ?? 0}</span>
              </span>
              <span className="text-nc-magenta">
                DISCORD NPC HOLDERS: <span className="text-foreground">{result.guildNpcCount ?? 0}</span>
              </span>
              <span className="text-muted-foreground">NOT ON PORTAL: {result.guildOnlyCount ?? 0}</span>
              {result.scannedAt && (
                <span className="text-muted-foreground">Scanned {formatDateTime(result.scannedAt)}</span>
              )}
            </div>
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="font-display text-nc-cyan">User</TableHead>
                    <TableHead className="font-display text-nc-cyan w-56">Discord ID</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="font-mono text-xs">
                  {result.websiteNpcUsers?.map((u) => (
                    <TableRow key={u.discordId} className="hover:bg-muted/50 border-border" data-testid={`row-npc-${u.discordId}`}>
                      <TableCell className="text-foreground">
                        <div className="flex items-center gap-2">
                          {u.avatarUrl ? (
                            <img src={u.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                          ) : (
                            <div className="h-6 w-6 rounded-full bg-muted" />
                          )}
                          <span>{u.globalName ?? u.username}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{u.discordId}</TableCell>
                    </TableRow>
                  ))}
                  {!result.websiteNpcUsers?.length && (
                    <TableRow>
                      <TableCell colSpan={2} className="text-center text-muted-foreground h-24">NO PORTAL USERS HOLD THE NPC ROLE</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
        {!result && !error && !loading && (
          <div className="font-mono text-xs text-muted-foreground">Run a scan to see who currently holds the NPC role.</div>
        )}
      </CardContent>
    </Card>
  );
}

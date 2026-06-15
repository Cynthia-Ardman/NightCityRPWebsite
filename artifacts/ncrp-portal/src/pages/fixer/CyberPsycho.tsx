import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVrchatStatus,
  getGetVrchatStatusQueryKey,
  useQueueVrchatCommand,
  useRevokeVrchatAgent,
  type VrchatStatusResponse,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  Skull,
  ShieldCheck,
  RefreshCw,
  Camera,
  Download,
  Power,
  Save,
  AlertTriangle,
  Loader2,
  Wifi,
  WifiOff,
} from "lucide-react";

// The CyberPsycho control panel. The portal is the shared control surface; the
// real VRChat work runs in a small Python agent on each staffer's own PC against
// their own account. This page drives ONLY the signed-in staffer's agent — every
// endpoint is scoped server-side to req.user.id — so it intentionally uses the
// real session identity (not view-as).

type Occupant = { id: string; displayName: string };

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleString();
}

export default function CyberPsycho() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const statusKey = getGetVrchatStatusQueryKey();

  const { data, isLoading } = useGetVrchatStatus({
    query: { queryKey: statusKey, refetchInterval: 4000 },
  });

  const queueCmd = useQueueVrchatCommand();
  const revoke = useRevokeVrchatAgent();
  const [downloading, setDownloading] = useState(false);

  const invalidate = () => void qc.invalidateQueries({ queryKey: statusKey });

  const status = (data as VrchatStatusResponse | undefined)?.status ?? null;
  const agent = (data as VrchatStatusResponse | undefined)?.agent;
  const commands = (data as VrchatStatusResponse | undefined)?.commands ?? [];

  const occupants: Occupant[] = useMemo(() => (status?.users ?? []) as Occupant[], [status?.users]);
  const allowlist = useMemo(() => status?.allowlist ?? [], [status?.allowlist]);
  const blocked = useMemo(() => status?.blocked ?? [], [status?.blocked]);
  const allowlistIds = useMemo(() => new Set(allowlist.map((u) => u.id)), [allowlist]);

  // Local selection for the allowlist builder. Seed from the agent's current
  // allowlist whenever the occupant set or saved allowlist changes.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelected(new Set(occupants.filter((u) => allowlistIds.has(u.id)).map((u) => u.id)));
  }, [occupants, allowlistIds]);

  const send = (kind: string, params?: Record<string, unknown>, label?: string) => {
    queueCmd.mutate(
      { data: { kind: kind as never, params: params ?? null } },
      {
        onSuccess: () => {
          toast({ title: "Command queued", description: label ?? `Sent "${kind}" to your agent.` });
          invalidate();
        },
        onError: () => toast({ title: "Failed to queue command", variant: "destructive" }),
      },
    );
  };

  const saveAllowlist = () => {
    const entries = occupants
      .filter((u) => selected.has(u.id))
      .map((u) => ({ id: u.id, name: u.displayName }));
    send("save_allowlist", { allowlist: entries }, `Saved ${entries.length} name(s) to your allowlist.`);
  };

  const downloadAgent = async () => {
    setDownloading(true);
    try {
      const res = await fetch("/api/vrchat/agent/download", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/x-python" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "psychosis_agent.py";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({
        title: "Agent downloaded",
        description: "A fresh token was issued — any previously downloaded agent is now invalid.",
      });
      invalidate();
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  const doRevoke = () => {
    revoke.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Token revoked", description: "Your running agent will stop working immediately." });
        invalidate();
      },
      onError: () => toast({ title: "Revoke failed", variant: "destructive" }),
    });
  };

  const online = !!agent?.online;
  const psychoActive = !!status?.psycho_active;
  const operation = status?.operation ?? "";
  const busy = queueCmd.isPending;

  return (
    <div className="mx-auto max-w-7xl p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-nc-magenta flex items-center gap-3">
            <Skull className="h-7 w-7" /> CyberPsycho Control
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Mass-block everyone in your current VRChat instance except an allowlist, then auto-block
            newcomers on patrol. The work runs in a small agent on your own PC against your own
            VRChat account — this panel just drives it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {online ? (
            <Badge className="bg-nc-green/15 text-nc-green border-nc-green/40 gap-1.5" data-testid="badge-agent-online">
              <Wifi className="h-3.5 w-3.5" /> Agent online
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground gap-1.5" data-testid="badge-agent-offline">
              <WifiOff className="h-3.5 w-3.5" /> Agent offline
            </Badge>
          )}
        </div>
      </div>

      {/* Setup / agent install */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Download className="h-5 w-5 text-nc-cyan" /> Your Agent
          </CardTitle>
          <CardDescription>
            Download once, run it on your PC, and keep it open while you play. Requires VRCX
            installed and logged in. The download contains a private token unique to you — don't
            share it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">Status:</span>
            {!agent?.exists ? (
              <span className="text-muted-foreground">No agent provisioned yet.</span>
            ) : agent.revoked ? (
              <span className="text-nc-orange">Token revoked — download again to reconnect.</span>
            ) : online ? (
              <span className="text-nc-green">Connected{agent.label ? ` as ${agent.label}` : ""}.</span>
            ) : (
              <span className="text-muted-foreground">
                Provisioned, last seen {relTime(agent.lastSeenAt)}. Start the agent on your PC.
              </span>
            )}
          </div>

          {status?.session_expired && (
            <div className="flex items-center gap-2 text-sm text-nc-orange border border-nc-orange/40 bg-nc-orange/10 px-3 py-2 rounded">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Your VRChat session expired in the agent. Re-login in VRCX, then refresh.
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={downloadAgent} disabled={downloading} data-testid="button-download-agent">
              {downloading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Download className="h-4 w-4 mr-2" />}
              {agent?.exists ? "Re-download agent" : "Download agent"}
            </Button>
            {agent?.exists && !agent.revoked && (
              <Button
                variant="outline"
                onClick={doRevoke}
                disabled={revoke.isPending}
                className="text-nc-orange border-nc-orange/40 hover:bg-nc-orange/10"
                data-testid="button-revoke-agent"
              >
                {revoke.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Power className="h-4 w-4 mr-2" />}
                Revoke token
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Controls */}
      <Card className={!online ? "opacity-60" : ""}>
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-nc-magenta" /> Controls
            </span>
            {psychoActive ? (
              <Badge className="bg-nc-magenta/15 text-nc-magenta border-nc-magenta/40">PSYCHO ACTIVE</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">Idle</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {status?.location ? (
              <>Current instance: <span className="font-mono text-xs">{status.location}</span></>
            ) : (
              "Not in any instance — Refresh once you're in a world."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {operation && (
            <div className="flex items-center gap-2 text-sm text-nc-cyan">
              <Loader2 className="h-4 w-4 animate-spin" /> {operation}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => send("refresh", undefined, "Refreshing your instance occupant list.")}
              disabled={!online || busy}
              data-testid="button-refresh"
            >
              <RefreshCw className="h-4 w-4 mr-2" /> Refresh
            </Button>
            <Button
              variant="outline"
              onClick={() => send("snapshot", undefined, "Allowlisting everyone currently in your instance.")}
              disabled={!online || busy}
              data-testid="button-snapshot"
            >
              <Camera className="h-4 w-4 mr-2" /> Snapshot allowlist
            </Button>
            <Button
              onClick={() => send("isolate", undefined, "Blocking everyone except your allowlist.")}
              disabled={!online || busy}
              className="bg-nc-magenta text-background hover:bg-nc-magenta/80"
              data-testid="button-isolate"
            >
              <Skull className="h-4 w-4 mr-2" /> Isolate
            </Button>
            <Button
              onClick={() => send("restore", undefined, "Unblocking everyone the agent blocked.")}
              disabled={!online || busy}
              className="bg-nc-green text-background hover:bg-nc-green/80"
              data-testid="button-restore"
            >
              <ShieldCheck className="h-4 w-4 mr-2" /> Restore
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Blocks are server-side — people already loaded in won't visually disappear until you
            rejoin the world.
          </p>
        </CardContent>
      </Card>

      {/* Allowlist builder */}
      <Card className={!online ? "opacity-60" : ""}>
        <CardHeader>
          <CardTitle className="text-lg">Allowlist builder</CardTitle>
          <CardDescription>
            Tick the people in your current instance to keep, then Save. You are always kept
            automatically. Hit Refresh first to pull the latest occupants.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {occupants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No occupants loaded. Join a world in VRChat and hit Refresh.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {occupants.map((u) => {
                const checked = selected.has(u.id);
                return (
                  <label
                    key={u.id}
                    className="flex items-center gap-2 border border-border rounded px-3 py-2 text-sm cursor-pointer hover:border-nc-cyan/50"
                    data-testid={`occupant-${u.id}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (v) next.add(u.id);
                          else next.delete(u.id);
                          return next;
                        });
                      }}
                    />
                    <span className="truncate">{u.displayName}</span>
                  </label>
                );
              })}
            </div>
          )}
          <Button onClick={saveAllowlist} disabled={!online || busy || occupants.length === 0} data-testid="button-save-allowlist">
            <Save className="h-4 w-4 mr-2" /> Save allowlist ({selected.size})
          </Button>

          {(allowlist.length > 0 || blocked.length > 0) && <Separator />}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-sm font-display text-nc-green mb-2">
                Allowlisted ({status?.allowlist_count ?? allowlist.length})
              </h3>
              {allowlist.length === 0 ? (
                <p className="text-xs text-muted-foreground">None saved yet.</p>
              ) : (
                <ul className="text-xs text-muted-foreground space-y-1 max-h-48 overflow-auto">
                  {allowlist.map((u) => <li key={u.id} className="truncate">{u.name}</li>)}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-display text-nc-magenta mb-2">
                Currently blocked ({status?.blocked_count ?? blocked.length})
              </h3>
              {blocked.length === 0 ? (
                <p className="text-xs text-muted-foreground">None blocked.</p>
              ) : (
                <ul className="text-xs text-muted-foreground space-y-1 max-h-48 overflow-auto">
                  {blocked.map((u) => <li key={u.id} className="truncate">{u.name}</li>)}
                </ul>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Recent commands */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent commands</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : commands.length === 0 ? (
            <p className="text-sm text-muted-foreground">No commands sent yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {commands.map((c) => (
                <li key={c.id} className="flex items-center justify-between text-sm border-b border-border/50 py-1.5">
                  <span className="font-mono">{c.kind}</span>
                  <span className="flex items-center gap-3">
                    <span
                      className={
                        c.status === "done"
                          ? "text-nc-green"
                          : c.status === "error"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {c.status}
                      {c.error ? ` — ${c.error}` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">{relTime(c.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

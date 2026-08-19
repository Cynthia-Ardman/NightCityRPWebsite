import { useAdminListUsers, useAdminHydrateUsers, useAdminSetCyberpsychoAccess, getAdminListUsersQueryKey } from "@workspace/api-client-react";
import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export function UsersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: users, isLoading } = useAdminListUsers();
  const setCyberpsycho = useAdminSetCyberpsychoAccess({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getAdminListUsersQueryKey() }),
      onError: () => toast({ title: "Failed to update CyberPsycho access", variant: "destructive" }),
    },
  });
  const hydrate = useAdminHydrateUsers({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: getAdminListUsersQueryKey() });
        toast({
          title: "Hydrated from Discord",
          description: `Scanned ${data.scanned}, updated ${data.updated}, missing ${data.missing}.`,
        });
      },
      onError: () => toast({ title: "Hydration failed", variant: "destructive" }),
    },
  });

  // Live reflection of the actual Discord NPC role (not the stored role
  // snapshot, which doesn't track NPC). Auto-loads the read-only scan on mount
  // and overlays an NPC badge per row. Degrades silently if Discord is
  // unreachable — the rest of the user list still renders.
  const [npcDiscordIds, setNpcDiscordIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/admin/npc-scan", { credentials: "include" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled || !data?.determined) return;
        setNpcDiscordIds(
          new Set<string>(
            (data.websiteNpcUsers ?? []).map((x: { discordId: string }) => x.discordId),
          ),
        );
      } catch {
        /* leave null — NPC badge simply won't show */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Querying users...</div>;

  const placeholderCount = users?.filter((u) => /^user_[A-Za-z0-9]+$/.test(u.username)).length ?? 0;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="font-display">Registered Users</CardTitle>
          <CardDescription className="font-mono">
            Discord identities linked to the portal. Discord ID is the unique key — everything (characters, housing, guns, cyberware) hangs off it.
            {placeholderCount > 0 && (
              <span className="block mt-1 text-nc-yellow">
                {placeholderCount} user{placeholderCount === 1 ? "" : "s"} still on a placeholder username — hydrate to pull real Discord handles.
              </span>
            )}
          </CardDescription>
        </div>
        <div className="flex flex-col gap-1">
          <Button
            size="sm"
            disabled={hydrate.isPending}
            onClick={() => hydrate.mutate({ data: {} })}
            className="rounded-none bg-nc-cyan text-background font-display"
            data-testid="button-hydrate-users"
          >
            {hydrate.isPending ? "HYDRATING..." : "HYDRATE FROM DISCORD"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={hydrate.isPending}
            onClick={() => { if (confirm("Force-refresh EVERY user from Discord?")) hydrate.mutate({ data: { force: true } }); }}
            className="rounded-none border-nc-magenta text-nc-magenta font-display text-xs"
            data-testid="button-hydrate-users-force"
          >
            FORCE ALL
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-display text-nc-cyan">Discord User</TableHead>
                <TableHead className="font-display text-nc-cyan">Discord ID</TableHead>
                <TableHead className="font-display text-nc-cyan">Roles</TableHead>
                <TableHead className="font-display text-nc-cyan">CyberPsycho</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-sm">
              {users?.map(u => {
                const isPlaceholder = /^user_[A-Za-z0-9]+$/.test(u.username);
                const display = u.globalName || (isPlaceholder ? null : u.username);
                return (
                <TableRow key={u.id} className="hover:bg-muted/50 border-border cursor-pointer transition-colors" data-testid={`row-user-${u.id}`}>
                  <TableCell className="font-medium text-foreground">
                    <Link href={`/admin/users/${u.id}`} className="hover:underline flex items-center gap-3">
                      {u.avatarUrl ? (
                        <img src={u.avatarUrl} alt="" className="w-8 h-8 rounded-none border border-border object-contain" />
                      ) : (
                        <div className="w-8 h-8 rounded-none border border-border bg-muted flex items-center justify-center text-[0.625rem] text-muted-foreground">
                          {(display || u.discordId).slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="flex flex-col">
                        <span>{display ?? <span className="text-nc-yellow italic">unhydrated</span>}</span>
                        {!isPlaceholder && (
                          <span className="text-[0.625rem] text-muted-foreground">@{u.username}</span>
                        )}
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{u.discordId}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.isAdmin && <Badge variant="outline" className="border-destructive text-destructive rounded-none text-[0.625rem] px-1 py-0">ADMIN</Badge>}
                      {u.isFixer && <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none text-[0.625rem] px-1 py-0">FIXER</Badge>}
                      {u.isTrialFixer && <Badge variant="outline" className="border-orange-400 text-orange-400 rounded-none text-[0.625rem] px-1 py-0" data-testid={`badge-trial-${u.id}`}>TRIAL</Badge>}
                      {u.isRipperdoc && <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[0.625rem] px-1 py-0">RIPPER</Badge>}
                      {u.isStoreOwner && <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[0.625rem] px-1 py-0">SHOP</Badge>}
                      {u.isCsApprover && <Badge variant="outline" className="border-green-500 text-green-500 rounded-none text-[0.625rem] px-1 py-0">CS_APPROVER</Badge>}
                      {npcDiscordIds?.has(u.discordId) && <Badge variant="outline" className="border-purple-400 text-purple-400 rounded-none text-[0.625rem] px-1 py-0" data-testid={`badge-npc-${u.id}`}>NPC</Badge>}
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {u.isAdmin || u.isFixer ? (
                      <span className="text-[0.625rem] text-muted-foreground uppercase">via role</span>
                    ) : (
                      <button
                        type="button"
                        disabled={setCyberpsycho.isPending}
                        onClick={() => setCyberpsycho.mutate({ userId: u.id, data: { enabled: !u.cyberpsychoAccess } })}
                        className={`px-2 py-0.5 border font-display text-[0.625rem] uppercase tracking-widest transition-colors ${u.cyberpsychoAccess ? "border-nc-magenta text-nc-magenta bg-nc-magenta/10" : "border-border text-muted-foreground hover:text-foreground"}`}
                        data-testid={`button-cyberpsycho-access-${u.id}`}
                      >
                        {u.cyberpsychoAccess ? "GRANTED" : "GRANT"}
                      </button>
                    )}
                  </TableCell>
                </TableRow>
                );
              })}
              {!users?.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO DATA</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

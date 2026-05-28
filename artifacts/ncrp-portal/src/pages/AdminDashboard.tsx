import { useAdminListUsers, useAdminHydrateUsers, useAdminListCharacters, useAdminAdjustWallet, useAdminListJobs, useAdminRunJob, useAdminAssignCharacterOwner, useAdminClearCharacterOwner, useAdminListAudit, useAdminListAuditLog, useAdminListBotConfig, useAdminSetBotConfig, useAdminDeleteBotConfig, useListHousingRequests, useApproveHousingRequest, useRejectHousingRequest, getListHousingRequestsQueryKey, getAdminListJobsQueryKey, getAdminListCharactersQueryKey, getAdminListAuditQueryKey, getAdminListAuditLogQueryKey, getAdminListBotConfigQueryKey, getAdminListUsersQueryKey } from "@workspace/api-client-react";
import { useState } from "react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Link } from "wouter";
import { Shield, Users, Database, Zap, Activity } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

export default function AdminDashboard() {
  const { data: user, isLoading: userLoading } = useAuthMe();

  if (userLoading) {
    return <div className="p-8 text-nc-cyan font-display animate-pulse">AUTH_VERIFICATION...</div>;
  }

  // /admin is ADMIN-only. Fixers have their own /fixer hub.
  if (!user?.isAdmin) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center space-y-4">
        <Shield className="w-24 h-24 text-destructive opacity-80" />
        <h1 className="text-4xl font-display font-bold text-destructive glitch-hover">ACCESS DENIED</h1>
        <p className="text-muted-foreground font-mono">You lack the necessary clearance level to view this sector.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-admin-title">
          <Shield className="w-8 h-8 text-destructive" />
          SYSTEM_ADMIN
        </h1>
        <p className="text-muted-foreground font-mono mt-2">God mode enabled. Proceed with caution.</p>
      </div>

      {(
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/wholesaler" className="px-4 py-2 border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background font-display text-xs tracking-widest" data-testid="link-admin-wholesaler">
            WHOLESALER CATALOG →
          </Link>
          <Link href="/admin/lifestyle" className="px-4 py-2 border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background font-display text-xs tracking-widest" data-testid="link-admin-lifestyle">
            LIFESTYLE TIERS →
          </Link>
        </div>
      )}

      <Tabs defaultValue="users" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto grid grid-cols-2 md:grid-cols-8 max-w-6xl w-full">
          <TabsTrigger value="users" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-users">Users</TabsTrigger>
          <TabsTrigger value="characters" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-chars">Characters</TabsTrigger>
          <TabsTrigger value="wallet" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-wallet">Wallets</TabsTrigger>
          <TabsTrigger value="jobs" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-jobs">Cron Jobs</TabsTrigger>
          <TabsTrigger value="audit" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-audit">Audit Log</TabsTrigger>
          <TabsTrigger value="flags" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-flags">System Flags</TabsTrigger>
          <TabsTrigger value="housing" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-housing-requests">Housing</TabsTrigger>
          <TabsTrigger value="maintenance" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-maintenance">Maintenance</TabsTrigger>
        </TabsList>

        <div className="mt-8">
          <TabsContent value="users">
            <UsersTab />
          </TabsContent>
          <TabsContent value="characters">
            <CharactersTab />
          </TabsContent>
          <TabsContent value="wallet">
            <WalletTab />
          </TabsContent>
          <TabsContent value="jobs">
            <JobsTab />
          </TabsContent>
          <TabsContent value="audit">
            <AuditLogTab />
          </TabsContent>
          <TabsContent value="flags">
            <FlagsTab />
          </TabsContent>
          <TabsContent value="housing">
            <HousingRequestsTab />
          </TabsContent>
          <TabsContent value="maintenance">
            <MaintenanceTab />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function AuditTab() {
  const [kind, setKind] = useState("");
  const [actorId, setActorId] = useState("");
  const [since, setSince] = useState("");
  const params = {
    ...(kind ? { kind } : {}),
    ...(actorId ? { actorId } : {}),
    ...(since ? { since: new Date(since).toISOString() } : {}),
    limit: 200,
  };
  const { data: rows, isLoading, refetch } = useAdminListAudit(params);
  const qc = useQueryClient();
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">Audit Feed</CardTitle>
        <CardDescription className="font-mono">Activity events across the portal. Filter by kind / actor / since.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 font-mono text-xs">
          <Input className="md:col-span-3" placeholder="kind (e.g. transfer)" value={kind} onChange={(e) => setKind(e.target.value)} data-testid="input-audit-kind" />
          <Input className="md:col-span-4" placeholder="actor user id" value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="input-audit-actor" />
          <Input className="md:col-span-3" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} data-testid="input-audit-since" />
          <Button
            className="md:col-span-2 rounded-none bg-nc-cyan text-background font-display"
            onClick={() => {
              qc.invalidateQueries({ queryKey: getAdminListAuditQueryKey() });
              refetch();
            }}
            data-testid="button-audit-apply"
          >
            APPLY
          </Button>
        </div>
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading events...</div>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan w-40">When</TableHead>
                  <TableHead className="font-display text-nc-cyan w-44">Kind</TableHead>
                  <TableHead className="font-display text-nc-cyan w-40">Actor</TableHead>
                  <TableHead className="font-display text-nc-cyan">Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs">
                {rows?.map((e) => (
                  <TableRow key={e.id} className="hover:bg-muted/50 border-border" data-testid={`row-audit-${e.id}`}>
                    <TableCell className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta text-[10px] px-1 py-0">
                        {e.kind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-nc-cyan">{e.actorName ?? "—"}</TableCell>
                    <TableCell className="text-foreground">{e.message}</TableCell>
                  </TableRow>
                ))}
                {!rows?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO EVENTS</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Pre-built sub-tabs (category groupings) for the unified audit log.
const AUDIT_SUBTABS: Array<{ key: string; label: string; categories: string[] }> = [
  { key: "all", label: "All", categories: [] },
  { key: "auth", label: "Auth", categories: ["auth"] },
  { key: "wallet", label: "Wallet", categories: ["wallet"] },
  { key: "characters", label: "Characters", categories: ["character"] },
  { key: "sheets", label: "Sheets", categories: ["sheet"] },
  { key: "shop_attend", label: "Shop & Attend", categories: ["shop", "attendance"] },
  { key: "admin", label: "Admin", categories: ["admin"] },
];

function AuditLogTab() {
  const [sub, setSub] = useState("all");
  const [actorId, setActorId] = useState("");
  const [since, setSince] = useState("");
  const tab = AUDIT_SUBTABS.find((t) => t.key === sub) ?? AUDIT_SUBTABS[0];
  // Single-category sub-tabs use the server filter; multi-category sub-tabs
  // (shop+attend) pull "all" and filter client-side.
  const serverCategory = tab.categories.length === 1 ? tab.categories[0] : undefined;
  const params = {
    ...(serverCategory ? { category: serverCategory } : {}),
    ...(actorId ? { actorId } : {}),
    ...(since ? { since: new Date(since).toISOString() } : {}),
    limit: 200,
  };
  const { data: rows, isLoading, refetch } = useAdminListAuditLog(params);
  const qc = useQueryClient();
  const visibleRows = tab.categories.length > 1
    ? (rows ?? []).filter((r) => tab.categories.includes(r.category))
    : (rows ?? []);
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">Audit Log</CardTitle>
        <CardDescription className="font-mono">Unified staff-facing audit. Pick a category sub-tab or filter by actor / since.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={sub} onValueChange={setSub}>
          <TabsList className="bg-card border border-border rounded-none p-0 h-auto grid grid-cols-3 md:grid-cols-7 w-full">
            {AUDIT_SUBTABS.map((t) => (
              <TabsTrigger
                key={t.key}
                value={t.key}
                className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-2 text-xs"
                data-testid={`tab-audit-${t.key}`}
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 font-mono text-xs">
          <Input className="md:col-span-5" placeholder="actor user id" value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="input-auditlog-actor" />
          <Input className="md:col-span-5" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} data-testid="input-auditlog-since" />
          <Button
            className="md:col-span-2 rounded-none bg-nc-cyan text-background font-display"
            onClick={() => {
              qc.invalidateQueries({ queryKey: getAdminListAuditLogQueryKey() });
              refetch();
            }}
            data-testid="button-auditlog-apply"
          >
            APPLY
          </Button>
        </div>
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading events...</div>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan w-40">When</TableHead>
                  <TableHead className="font-display text-nc-cyan w-28">Category</TableHead>
                  <TableHead className="font-display text-nc-cyan w-36">Action</TableHead>
                  <TableHead className="font-display text-nc-cyan w-40">Actor</TableHead>
                  <TableHead className="font-display text-nc-cyan">Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-xs">
                {visibleRows.map((e) => (
                  <TableRow key={e.id} className="hover:bg-muted/50 border-border" data-testid={`row-auditlog-${e.id}`}>
                    <TableCell className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[10px] px-1 py-0">
                        {e.category}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-nc-magenta">{e.action}</TableCell>
                    <TableCell className="text-nc-cyan">{e.actorName ?? e.actorId ?? "—"}</TableCell>
                    <TableCell className="text-foreground">{e.message ?? "—"}</TableCell>
                  </TableRow>
                ))}
                {!visibleRows.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground h-24">NO EVENTS</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FlagsTab() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getAdminListBotConfigQueryKey() });
  const { data: rows, isLoading } = useAdminListBotConfig();
  const set = useAdminSetBotConfig({ mutation: { onSuccess: invalidate } });
  const del = useAdminDeleteBotConfig({ mutation: { onSuccess: invalidate } });
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const parseValue = (raw: string): unknown => {
    const t = raw.trim();
    if (t === "") return "";
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">System Flags</CardTitle>
        <CardDescription className="font-mono">
          Key/value bot_config flags. Values are JSON — bare strings are stored as strings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        <div className="grid grid-cols-12 gap-2 items-end border-b border-border/40 pb-3">
          <div className="col-span-4">
            <Label className="text-xs">NEW KEY</Label>
            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="e.g. trauma_team.enabled" data-testid="input-flag-key" />
          </div>
          <div className="col-span-6">
            <Label className="text-xs">VALUE (JSON)</Label>
            <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder='true / 42 / "string"' data-testid="input-flag-value" />
          </div>
          <Button
            className="col-span-2 rounded-none bg-nc-cyan text-background font-display"
            disabled={!newKey.trim() || set.isPending}
            onClick={() => {
              set.mutate(
                { key: newKey.trim(), data: { value: parseValue(newValue) } },
                {
                  onSuccess: () => {
                    setNewKey("");
                    setNewValue("");
                  },
                },
              );
            }}
            data-testid="button-flag-create"
          >
            SET
          </Button>
        </div>
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading flags...</div>
        ) : (
          <div className="rounded-md border border-border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan">Key</TableHead>
                  <TableHead className="font-display text-nc-cyan">Value</TableHead>
                  <TableHead className="font-display text-nc-cyan w-48">Updated</TableHead>
                  <TableHead className="font-display text-nc-cyan w-40">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {rows?.map((r) => {
                  const current = drafts[r.key] ?? JSON.stringify(r.value);
                  return (
                    <TableRow key={r.key} className="hover:bg-muted/50 border-border" data-testid={`row-flag-${r.key}`}>
                      <TableCell className="text-nc-cyan">{r.key}</TableCell>
                      <TableCell>
                        <Input
                          value={current}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.key]: e.target.value }))}
                          className="h-8"
                          data-testid={`input-flag-edit-${r.key}`}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(r.updatedAt).toLocaleString()}</TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            className="rounded-none bg-nc-cyan text-background font-display text-xs"
                            onClick={() => set.mutate({ key: r.key, data: { value: parseValue(drafts[r.key] ?? JSON.stringify(r.value)) } })}
                            data-testid={`button-flag-save-${r.key}`}
                          >
                            SAVE
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-none border-destructive text-destructive font-display text-xs"
                            onClick={() => {
                              if (confirm(`Delete bot_config.${r.key}?`)) del.mutate({ key: r.key });
                            }}
                            data-testid={`button-flag-delete-${r.key}`}
                          >
                            DEL
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!rows?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO FLAGS</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: users, isLoading } = useAdminListUsers();
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

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Querying users...</div>;

  const placeholderCount = users?.filter((u) => /^user_[A-Za-z0-9]+$/.test(u.username)).length ?? 0;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
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
                <TableHead className="font-display text-nc-cyan text-right">Characters</TableHead>
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
                        <img src={u.avatarUrl} alt="" className="w-8 h-8 rounded-none border border-border object-cover" />
                      ) : (
                        <div className="w-8 h-8 rounded-none border border-border bg-muted flex items-center justify-center text-[10px] text-muted-foreground">
                          {(display || u.discordId).slice(0, 2).toUpperCase()}
                        </div>
                      )}
                      <div className="flex flex-col">
                        <span>{display ?? <span className="text-nc-yellow italic">unhydrated</span>}</span>
                        {!isPlaceholder && (
                          <span className="text-[10px] text-muted-foreground">@{u.username}</span>
                        )}
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{u.discordId}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.isAdmin && <Badge variant="outline" className="border-destructive text-destructive rounded-none text-[10px] px-1 py-0">ADMIN</Badge>}
                      {u.isFixer && <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none text-[10px] px-1 py-0">FIXER</Badge>}
                      {u.isRipperdoc && <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[10px] px-1 py-0">RIPPER</Badge>}
                      {u.isStoreOwner && <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[10px] px-1 py-0">SHOP</Badge>}
                      {u.isCsApprover && <Badge variant="outline" className="border-green-500 text-green-500 rounded-none text-[10px] px-1 py-0">CS_APPROVER</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{u.characterCount || 0}</TableCell>
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

function CharactersTab() {
  const qc = useQueryClient();
  const { data: chars, isLoading } = useAdminListCharacters();
  const [filter, setFilter] = useState<"all" | "unclaimed">("all");
  const invalidate = () => qc.invalidateQueries({ queryKey: getAdminListCharactersQueryKey() });
  const assign = useAdminAssignCharacterOwner({ mutation: { onSuccess: invalidate } });
  const clearOwner = useAdminClearCharacterOwner({ mutation: { onSuccess: invalidate } });
  const [draftOwner, setDraftOwner] = useState<Record<number, string>>({});

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Querying characters...</div>;

  const rows = (chars ?? []).filter((c) => (filter === "unclaimed" ? !c.ownerId : true));

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="font-display">All Characters</CardTitle>
          <CardDescription className="font-mono">Global registry. Assign owners to imported/unclaimed sheets.</CardDescription>
        </div>
        <div className="flex gap-2">
          {(["all", "unclaimed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`px-3 py-1 border font-display text-xs uppercase tracking-widest ${filter === s ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10" : "border-border text-muted-foreground"}`}
              data-testid={`button-admin-char-filter-${s}`}
            >
              {s}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-display text-nc-cyan">Name</TableHead>
                <TableHead className="font-display text-nc-cyan">Type / Archetype</TableHead>
                <TableHead className="font-display text-nc-cyan">Owner</TableHead>
                <TableHead className="font-display text-nc-cyan">Status</TableHead>
                <TableHead className="font-display text-nc-cyan">Claim</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-sm">
              {rows.map((c) => (
                <TableRow key={c.id} className="hover:bg-muted/50 border-border" data-testid={`row-char-${c.id}`}>
                  <TableCell className="font-medium text-foreground">
                    <Link href={`/characters/${c.id}`} className="hover:underline">{c.name}</Link>
                    {c.legacyDiscordUsername && (
                      <div className="text-[10px] text-muted-foreground">legacy: {c.legacyDiscordUsername}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <span className={c.kind === "pc" ? "text-nc-magenta" : "text-nc-yellow"}>{c.kind.toUpperCase()}</span>
                    {c.archetype && ` / ${c.archetype}`}
                  </TableCell>
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {c.ownerName ? <span className="text-nc-cyan">@{c.ownerName}</span> : <span className="text-nc-magenta">UNCLAIMED</span>}
                  </TableCell>
                  <TableCell>
                    {c.archived && <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[10px] px-1 py-0 mr-1">RETIRED</Badge>}
                    {c.approved ? (
                      <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none text-[10px] px-1 py-0">APPROVED</Badge>
                    ) : (
                      <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none text-[10px] px-1 py-0">PENDING</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        placeholder="user id"
                        value={draftOwner[c.id] ?? ""}
                        onChange={(e) => setDraftOwner((d) => ({ ...d, [c.id]: e.target.value }))}
                        className="h-7 px-2 text-xs bg-background border border-border w-28"
                        data-testid={`input-claim-owner-${c.id}`}
                      />
                      <button
                        type="button"
                        className="h-7 px-2 text-xs border border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10 disabled:opacity-50"
                        disabled={!draftOwner[c.id]?.trim() || assign.isPending}
                        onClick={() => assign.mutate({ id: c.id, data: { ownerId: draftOwner[c.id].trim() } })}
                        data-testid={`button-claim-assign-${c.id}`}
                      >
                        ASSIGN
                      </button>
                      {c.ownerId && (
                        <button
                          type="button"
                          className="h-7 px-2 text-xs border border-destructive text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          disabled={clearOwner.isPending}
                          onClick={() => { if (confirm(`Clear owner of ${c.name}?`)) clearOwner.mutate({ id: c.id }); }}
                          data-testid={`button-claim-clear-${c.id}`}
                        >
                          CLEAR
                        </button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground h-24">NO DATA</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

const walletSchema = z.object({
  characterId: z.coerce.number().min(1, "Character ID is required"),
  amount: z.coerce.number(),
  reason: z.string().min(1, "Reason is required"),
});

function WalletTab() {
  const adjustWallet = useAdminAdjustWallet();
  const { toast } = useToast();
  const [target, setTarget] = useState<CharacterPickerValue>(null);

  const form = useForm<z.infer<typeof walletSchema>>({
    resolver: zodResolver(walletSchema),
    defaultValues: {
      characterId: 0,
      amount: 0,
      reason: "",
    },
  });

  const onSubmit = (values: z.infer<typeof walletSchema>) => {
    if (!target?.id) {
      toast({ title: "Pick a character", description: "Search by character or player name.", variant: "destructive" });
      return;
    }
    adjustWallet.mutate({ data: { ...values, characterId: target.id } }, {
      onSuccess: () => {
        toast({ title: "Wallet Adjusted", description: `Adjusted ${target.name}.` });
        form.reset();
        setTarget(null);
      },
      onError: (err: any) => {
        toast({ title: "Adjustment Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <Card className="rounded-none border-destructive/50 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-destructive">Manual Wallet Adjustment</CardTitle>
        <CardDescription className="font-mono">Directly inject or drain eddies from a character. Logged as 'admin' transaction.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 font-mono max-w-md">
            <FormItem>
              <FormLabel>Character</FormLabel>
              <CharacterPicker value={target} onChange={setTarget} scope="all" testId="input-wallet-char" />
              {!target && (
                <p className="text-xs text-muted-foreground">Search by character or player name.</p>
              )}
            </FormItem>
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (Positive or Negative)</FormLabel>
                  <FormControl>
                    <Input type="number" className="rounded-none border-border bg-background focus-visible:ring-destructive" {...field} data-testid="input-wallet-amount" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason / Memo</FormLabel>
                  <FormControl>
                    <Input className="rounded-none border-border bg-background focus-visible:ring-destructive" placeholder="Admin adjustment" {...field} data-testid="input-wallet-reason" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={adjustWallet.isPending || !target?.id} className="w-full rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display mt-4" data-testid="button-submit-wallet">
              {adjustWallet.isPending ? "PROCESSING..." : "EXECUTE TRANSFER"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// Keep in sync with AUTOBILL_FLAGS in api-server/src/lib/jobs.ts.
const HOUSING_AUTOBILL_KEY = "housing_autobill_enabled";
const CYBERWARE_AUTOBILL_KEY = "cyberware_autobill_enabled";

function AutobillSwitch({
  configKey,
  label,
  description,
  rows,
  onToggle,
  pending,
}: {
  configKey: string;
  label: string;
  description: string;
  rows: Array<{ key: string; value: unknown }> | undefined;
  onToggle: (next: boolean) => void;
  pending: boolean;
}) {
  const row = rows?.find((r) => r.key === configKey);
  const enabled = row?.value === true;
  return (
    <div className="flex items-center justify-between gap-4 border border-border bg-card/30 p-3" data-testid={`autobill-${configKey}`}>
      <div>
        <div className="font-display text-sm text-foreground">{label}</div>
        <div className="font-mono text-[11px] text-muted-foreground">{description}</div>
        <div className="font-mono text-[11px] mt-1">
          State:{" "}
          <span className={enabled ? "text-nc-cyan" : "text-destructive"}>
            {enabled ? "ENABLED" : "DISABLED"}
          </span>
        </div>
      </div>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => onToggle(!enabled)}
        className={`rounded-none font-display text-xs ${enabled ? "bg-destructive text-background" : "bg-nc-cyan text-background"}`}
        data-testid={`button-autobill-toggle-${configKey}`}
      >
        {enabled ? "DISABLE" : "ENABLE"}
      </Button>
    </div>
  );
}

function JobsTab() {
  const { data: jobs, isLoading } = useAdminListJobs();
  const runJob = useAdminRunJob();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: flagRows } = useAdminListBotConfig();
  const setFlag = useAdminSetBotConfig({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: getAdminListBotConfigQueryKey() }),
      onError: (err: any) => toast({ title: "Flag update failed", description: err.message, variant: "destructive" }),
    },
  });

  const handleRunJob = (jobId: "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep") => {
    runJob.mutate({ data: { job: jobId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getAdminListJobsQueryKey() });
        toast({ title: "Job Dispatched", description: `Task ${jobId} initiated.` });
      },
      onError: (err: any) => {
        toast({ title: "Job Failed", description: err.message, variant: "destructive" });
      }
    });
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">System Jobs</CardTitle>
        <CardDescription className="font-mono">
          Kill switches gate the scheduled cron. Manual buttons below always run regardless of switch state.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <AutobillSwitch
            configKey={HOUSING_AUTOBILL_KEY}
            label="Housing + Lifestyle Autobill"
            description="Gates the monthly_rent cron (housing rent + monthly lifestyle costs). 04:00 UTC on the 1st."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: HOUSING_AUTOBILL_KEY, data: { value: next } })}
          />
          <AutobillSwitch
            configKey={CYBERWARE_AUTOBILL_KEY}
            label="Cyberware Autobill"
            description="Gates the cyberware_humanity cron (weekly cyberpsychosis meds). Mondays 05:00 UTC."
            rows={flagRows}
            pending={setFlag.isPending}
            onToggle={(next) => setFlag.mutate({ key: CYBERWARE_AUTOBILL_KEY, data: { value: next } })}
          />
        </div>

        <div className="flex gap-4">
          <Button onClick={() => handleRunJob("cyberware_humanity")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-cyan text-nc-cyan hover:bg-nc-cyan hover:text-background" variant="outline" data-testid="btn-job-cyberware">
            Update Humanity
          </Button>
          <Button onClick={() => handleRunJob("monthly_rent")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-magenta text-nc-magenta hover:bg-nc-magenta hover:text-background" variant="outline" data-testid="btn-job-rent">
            Process Rent
          </Button>
          <Button onClick={() => handleRunJob("role_sync")} disabled={runJob.isPending} className="rounded-none font-display border border-nc-yellow text-nc-yellow hover:bg-nc-yellow hover:text-background" variant="outline" data-testid="btn-job-sync">
            Sync Roles
          </Button>
        </div>
        
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">Loading jobs...</div>
        ) : (
          <div className="rounded-md border border-border mt-4">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="font-display text-nc-cyan">Job</TableHead>
                  <TableHead className="font-display text-nc-cyan">Status</TableHead>
                  <TableHead className="font-display text-nc-cyan">Message</TableHead>
                  <TableHead className="font-display text-nc-cyan">Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="font-mono text-sm">
                {jobs?.map((j: any) => (
                  <TableRow key={j.id} className="hover:bg-muted/50 border-border" data-testid={`row-job-${j.id}`}>
                    <TableCell className="font-medium text-foreground">{j.job}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`rounded-none text-[10px] px-1 py-0 ${j.status === 'success' ? 'border-nc-cyan text-nc-cyan' : j.status === 'failed' ? 'border-destructive text-destructive' : 'border-nc-yellow text-nc-yellow'}`}>
                        {j.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{j.message || '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(j.startedAt).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {!jobs?.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground h-24">NO DATA</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HousingRequestsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListHousingRequests({ status: "pending" });
  const invalidate = () => qc.invalidateQueries({ queryKey: getListHousingRequestsQueryKey({ status: "pending" }) });
  const approve = useApproveHousingRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Lease approved", description: "Housing row created." }); invalidate(); },
      onError: (err: any) => toast({ title: "Approve failed", description: err?.response?.data?.error ?? err.message, variant: "destructive" }),
    },
  });
  const reject = useRejectHousingRequest({
    mutation: {
      onSuccess: () => { toast({ title: "Request rejected" }); invalidate(); },
      onError: (err: any) => toast({ title: "Reject failed", description: err?.response?.data?.error ?? err.message, variant: "destructive" }),
    },
  });
  const rows = data ?? [];
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-housing-requests">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">PENDING HOUSING REQUESTS</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="font-mono text-muted-foreground animate-pulse">Loading...</div>
        ) : rows.length === 0 ? (
          <div className="font-mono text-muted-foreground italic">No pending requests.</div>
        ) : (
          <ul className="space-y-2 font-mono text-sm">
            {rows.map((r) => (
              <li
                key={r.id}
                className="border border-border/40 p-3 flex flex-wrap items-center gap-3 justify-between"
                data-testid={`row-housing-request-${r.id}`}
              >
                <div className="flex-1 min-w-[260px]">
                  <div className="text-foreground">
                    <span className="text-nc-cyan">{r.characterName}</span> → {r.listingName}
                    {r.district ? <span className="text-muted-foreground"> · {r.district}</span> : null}
                    <Badge variant="outline" className={`ml-2 rounded-none text-[10px] px-1 py-0 ${r.kind === "business" ? "border-nc-magenta text-nc-magenta" : "border-nc-cyan/40 text-nc-cyan"}`}>
                      {r.kind.toUpperCase()}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <span className="text-nc-yellow">€${r.monthlyRent.toLocaleString()}/mo</span>
                    {" · "}requested by {r.requestedByName ?? r.requestedById}
                    {" · "}{new Date(r.createdAt).toLocaleString()}
                  </div>
                  {r.notes ? <div className="text-xs text-muted-foreground italic mt-1">"{r.notes}"</div> : null}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => approve.mutate({ id: r.id, data: {} })}
                    disabled={approve.isPending || reject.isPending}
                    className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display"
                    data-testid={`button-approve-housing-${r.id}`}
                  >APPROVE</Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const note = prompt("Reason for rejecting? (optional)") ?? "";
                      reject.mutate({ id: r.id, data: { reviewerNote: note || undefined } });
                    }}
                    disabled={approve.isPending || reject.isPending}
                    className="rounded-none border-destructive text-destructive hover:bg-destructive hover:text-background font-display"
                    data-testid={`button-reject-housing-${r.id}`}
                  >REJECT</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function MaintenanceTab() {
  const { toast } = useToast();
  const [importResult, setImportResult] = useState<null | {
    inserted: number;
    updated: number;
    skipped: number;
    errors: Array<{ name: string; error: string }>;
  }>(null);
  const [importing, setImporting] = useState(false);
  const [pasted, setPasted] = useState("");

  async function downloadExport() {
    const r = await fetch("/api/admin/maintenance/npc-export", { credentials: "include" });
    if (!r.ok) {
      toast({ title: "Export failed", description: `HTTP ${r.status}`, variant: "destructive" });
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ncrp-npcs-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    const json = await fetch(url).catch(() => null);
    toast({ title: "NPC export downloaded", description: `Saved ${a.download}` });
    void json;
  }

  async function runImport(jsonText: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
      return;
    }
    setImporting(true);
    setImportResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/npc-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Import failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setImportResult(body);
      toast({
        title: "NPC import complete",
        description: `${body.inserted} inserted, ${body.updated} updated, ${body.errors?.length ?? 0} errors`,
      });
    } finally {
      setImporting(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await runImport(text);
    e.target.value = "";
  }

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">NPC SYNC</CardTitle>
          <CardDescription className="font-mono text-xs">
            Dev → Prod data sync for NPC characters. Production database writes go through this
            running app — export from dev, then deploy and re-import here in prod. Upsert is
            keyed on (kind='npc', name); admin-assigned owners are preserved across runs.
            Portrait URLs continue to resolve because dev and prod share the object-storage bucket.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label className="font-display tracking-widest text-xs">1 · EXPORT (run in dev)</Label>
            <p className="text-xs font-mono text-muted-foreground">
              Downloads every NPC in this environment as a single JSON file.
            </p>
            <Button
              type="button"
              onClick={downloadExport}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
              data-testid="button-npc-export"
            >
              DOWNLOAD NPC EXPORT
            </Button>
          </div>

          <div className="border-t border-border/50 pt-4 space-y-2">
            <Label className="font-display tracking-widest text-xs">2 · IMPORT (run in prod after deploy)</Label>
            <p className="text-xs font-mono text-muted-foreground">
              Upload the JSON file produced above (or paste it). Safe to run repeatedly.
            </p>
            <div className="flex flex-wrap gap-3 items-center">
              <input
                type="file"
                accept="application/json,.json"
                onChange={onFile}
                disabled={importing}
                className="font-mono text-xs"
                data-testid="input-npc-import-file"
              />
              {importing && <span className="text-xs font-mono text-nc-cyan animate-pulse">IMPORTING...</span>}
            </div>
            <details className="text-xs font-mono text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">Or paste JSON directly</summary>
              <textarea
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder='{ "npcs": [...] }'
                className="mt-2 w-full h-32 bg-background border border-border rounded-none p-2 text-xs font-mono"
                data-testid="textarea-npc-import-paste"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => runImport(pasted)}
                disabled={importing || !pasted.trim()}
                className="mt-2 rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
                data-testid="button-npc-import-paste"
              >
                RUN IMPORT
              </Button>
            </details>
          </div>

          {importResult && (
            <div className="border-t border-border/50 pt-4 space-y-2" data-testid="block-npc-import-result">
              <Label className="font-display tracking-widest text-xs">RESULT</Label>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="border border-nc-cyan/40 bg-nc-cyan/5 p-2">
                  <div className="text-2xl font-display text-nc-cyan">{importResult.inserted}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Inserted</div>
                </div>
                <div className="border border-nc-yellow/40 bg-nc-yellow/5 p-2">
                  <div className="text-2xl font-display text-nc-yellow">{importResult.updated}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Updated</div>
                </div>
                <div className="border border-destructive/40 bg-destructive/5 p-2">
                  <div className="text-2xl font-display text-destructive">{importResult.errors.length}</div>
                  <div className="text-xs font-mono text-muted-foreground uppercase">Errors</div>
                </div>
              </div>
              {importResult.errors.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {importResult.errors.map((e, i) => (
                    <div key={i} className="text-xs font-mono text-destructive border border-destructive/30 px-2 py-1">
                      <span className="font-bold">{e.name}:</span> {e.error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <FullMigrationCard />
      <BotImportCard />
      <DuplicateCleanupCard />
      <ClaimByUsernameCard />
      <PortraitBackfillCard />
    </div>
  );
}

interface DupeRow {
  id: number;
  name: string;
  kind: string;
  ownerId: string | null;
  ownerName: string | null;
  archetype: string | null;
  portraitUrl: string | null;
  portraitCount: number;
  hasSheetData: boolean;
  importedFromThreadId: string | null;
  legacyDiscordUsername: string | null;
  approved: boolean;
  archived: boolean;
  lifeStatus: string;
  createdAt: string;
}
interface DupeGroup {
  key: string;
  kind: string;
  name: string;
  count: number;
  suggestedKeepId: number;
  rows: DupeRow[];
}
interface DupeResponse {
  groupCount: number;
  totalDuplicateRows: number;
  groups: DupeGroup[];
}
interface MergeResult {
  keepId: number;
  dropId: number;
  fieldsFilled: string[];
  repointed: Record<string, number>;
}

function DuplicateCleanupCard() {
  const { toast } = useToast();
  const [data, setData] = useState<DupeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  // groupKey -> the id the admin has picked as the keeper. Defaults to the
  // server's suggestion when the group is first loaded.
  const [keepers, setKeepers] = useState<Record<string, number>>({});

  async function load() {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/maintenance/duplicate-characters", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Scan failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setData(body as DupeResponse);
      const init: Record<string, number> = {};
      for (const g of (body as DupeResponse).groups) init[g.key] = g.suggestedKeepId;
      setKeepers(init);
    } finally {
      setLoading(false);
    }
  }

  async function mergePair(group: DupeGroup, keepId: number, dropId: number) {
    const drop = group.rows.find((r) => r.id === dropId);
    const keep = group.rows.find((r) => r.id === keepId);
    if (!drop || !keep) return;
    const ok = window.confirm(
      `Merge "${drop.name}" #${drop.id} INTO #${keep.id}?\n\n` +
      `• Empty fields on #${keep.id} will be filled from #${drop.id}.\n` +
      `• All inventory, wallet, housing, sheet history pointing at #${drop.id} will be repointed to #${keep.id}.\n` +
      `• #${drop.id} will then be deleted. This cannot be undone.`,
    );
    if (!ok) return;
    setMerging(`${keepId}->${dropId}`);
    try {
      const r = await fetch("/api/admin/maintenance/merge-character", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId, dropId }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Merge failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      const result = body as MergeResult;
      const repointTotal = Object.values(result.repointed).reduce((s, n) => s + n, 0);
      toast({
        title: `Merged #${dropId} → #${keepId}`,
        description: `Filled ${result.fieldsFilled.length} fields, repointed ${repointTotal} child rows.`,
      });
      await load();
    } finally {
      setMerging(null);
    }
  }

  return (
    <Card className="rounded-none border-destructive/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-destructive">DUPLICATE CHARACTERS</CardTitle>
        <CardDescription className="font-mono text-xs">
          Lists every (kind, name) collision so you can review each pair before merging. Pre-fix
          imports could create a second empty NPC when the name drifted between dev and prod.
          The default "KEEP" pick is the row with the richest data (sheet body, portrait, owner) —
          override per row if you know the other one is canonical. Merging is destructive: the
          DROP row is deleted after all its inventory / wallet / housing references are
          repointed to the keeper.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
            data-testid="button-scan-duplicates"
          >
            {loading ? "SCANNING..." : data ? "RE-SCAN" : "SCAN FOR DUPLICATES"}
          </Button>
          {data && (
            <span className="text-xs font-mono text-muted-foreground">
              {data.groupCount} group{data.groupCount === 1 ? "" : "s"} · {data.totalDuplicateRows} rows
            </span>
          )}
        </div>

        {data && data.groups.length === 0 && (
          <div className="text-xs font-mono text-muted-foreground italic">No duplicate characters detected.</div>
        )}

        {data && data.groups.map((g) => {
          const keepId = keepers[g.key] ?? g.suggestedKeepId;
          return (
            <div key={g.key} className="border border-border/60 p-3 space-y-2" data-testid={`dupe-group-${g.key}`}>
              <div className="flex items-baseline justify-between gap-3">
                <div className="font-display tracking-widest text-sm">
                  {g.name} <span className="text-muted-foreground">[{g.kind}]</span>
                </div>
                <div className="text-xs font-mono text-muted-foreground">{g.count} rows</div>
              </div>
              <div className="space-y-1">
                {g.rows.map((row) => {
                  const isKeep = row.id === keepId;
                  return (
                    <div
                      key={row.id}
                      className={`border px-3 py-2 text-xs font-mono flex items-center gap-3 ${
                        isKeep ? "border-nc-cyan/60 bg-nc-cyan/5" : "border-border/40"
                      }`}
                      data-testid={`dupe-row-${row.id}`}
                    >
                      <label className="flex items-center gap-2 shrink-0 cursor-pointer">
                        <input
                          type="radio"
                          name={`keep-${g.key}`}
                          checked={isKeep}
                          onChange={() => setKeepers((k) => ({ ...k, [g.key]: row.id }))}
                          className="cursor-pointer"
                          data-testid={`radio-keep-${row.id}`}
                        />
                        <span className={isKeep ? "text-nc-cyan font-bold" : "text-muted-foreground"}>
                          {isKeep ? "KEEP" : "drop"} #{row.id}
                        </span>
                      </label>
                      <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px]">
                        <span title="archetype">{row.archetype || <em className="text-muted-foreground/50">no archetype</em>}</span>
                        <span title="portrait">{row.portraitUrl ? `${row.portraitCount} portrait${row.portraitCount === 1 ? "" : "s"}` : <em className="text-muted-foreground/50">no portrait</em>}</span>
                        <span title="sheet">{row.hasSheetData ? "sheet ✓" : <em className="text-muted-foreground/50">no sheet</em>}</span>
                        <span title="owner">{row.ownerName ? `@${row.ownerName}` : <em className="text-muted-foreground/50">unclaimed</em>}</span>
                        <span title="legacy username" className="md:col-span-2">{row.legacyDiscordUsername ? `legacy: ${row.legacyDiscordUsername}` : ""}</span>
                        <span title="thread id" className="md:col-span-2">{row.importedFromThreadId ? `thread: ${row.importedFromThreadId}` : ""}</span>
                      </div>
                      {!isKeep && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={merging !== null}
                          onClick={() => mergePair(g, keepId, row.id)}
                          className="rounded-none border-destructive text-destructive hover:bg-destructive hover:text-foreground h-7 px-2 font-display tracking-widest text-xs shrink-0"
                          data-testid={`button-merge-${keepId}-${row.id}`}
                        >
                          {merging === `${keepId}->${row.id}` ? "MERGING..." : `MERGE → #${keepId}`}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface ClaimMatch {
  characterId: number;
  characterName: string;
  kind: string;
  legacyDiscordUsername: string;
  matchedUserIds: string[];
  matchedUsernames: string[];
}
interface ClaimPreview {
  candidateCount: number;
  ambiguousCount: number;
  matches: ClaimMatch[];
}
interface ClaimApplyResult {
  applied: Array<{ characterId: number; characterName: string; ownerId: string; matchedUsername: string }>;
  skipped: Array<{ characterId: number; characterName: string; reason: string }>;
}

function ClaimByUsernameCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [applyResult, setApplyResult] = useState<ClaimApplyResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);

  async function loadPreview() {
    setBusy("preview");
    setApplyResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/claim-by-username", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Preview failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setPreview(body as ClaimPreview);
    } finally {
      setBusy(null);
    }
  }

  async function applyAll() {
    const unique = preview ? preview.matches.filter((m) => m.matchedUserIds.length === 1).length : 0;
    if (unique === 0) {
      toast({ title: "Nothing to apply", description: "No single-match candidates.", variant: "destructive" });
      return;
    }
    const ok = window.confirm(
      `Link ${unique} unclaimed character${unique === 1 ? "" : "s"} to their matched Discord user?\n\n` +
      `Ambiguous matches (multiple users with the same username) will be skipped. Existing ownerIds are never overwritten.`,
    );
    if (!ok) return;
    setBusy("apply");
    try {
      const r = await fetch("/api/admin/maintenance/claim-by-username", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Claim failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setApplyResult(body as ClaimApplyResult);
      toast({
        title: "Claim-by-username complete",
        description: `Linked ${body.applied?.length ?? 0}, skipped ${body.skipped?.length ?? 0}.`,
      });
      await loadPreview();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta">CLAIM UNCLAIMED BY USERNAME</CardTitle>
        <CardDescription className="font-mono text-xs">
          For every character with no ownerId but a <code>legacy_discord_username</code>, looks for a
          single matching <code>users</code> row (case-insensitive on username or global name) and
          links them. Ambiguous matches (multiple Discord users sharing the handle) are reported but
          never auto-linked. Existing owners are never overwritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={loadPreview}
            disabled={busy !== null}
            className="rounded-none bg-nc-magenta text-foreground hover:bg-nc-magenta/80 font-display tracking-widest"
            data-testid="button-claim-preview"
          >
            {busy === "preview" ? "SCANNING..." : preview ? "RE-SCAN" : "PREVIEW MATCHES"}
          </Button>
          {preview && (
            <Button
              type="button"
              onClick={applyAll}
              disabled={busy !== null}
              className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
              data-testid="button-claim-apply"
            >
              {busy === "apply" ? "APPLYING..." : "APPLY SINGLE-MATCH"}
            </Button>
          )}
        </div>

        {preview && (
          <div className="space-y-2">
            <div className="text-xs font-mono text-muted-foreground">
              {preview.candidateCount} unclaimed character{preview.candidateCount === 1 ? "" : "s"} with a legacy username
              {preview.ambiguousCount > 0 ? ` · ${preview.ambiguousCount} ambiguous` : ""}
            </div>
            {preview.matches.length === 0 ? (
              <div className="text-xs font-mono text-muted-foreground italic">Nothing unclaimed has a legacy username on file.</div>
            ) : (
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {preview.matches.map((m) => {
                  const tone = m.matchedUserIds.length === 1
                    ? "border-nc-cyan/40 text-foreground"
                    : m.matchedUserIds.length === 0
                      ? "border-border/40 text-muted-foreground"
                      : "border-nc-yellow/40 text-nc-yellow";
                  return (
                    <div key={m.characterId} className={`border px-3 py-2 text-xs font-mono flex items-center justify-between gap-3 ${tone}`} data-testid={`claim-row-${m.characterId}`}>
                      <div className="min-w-0">
                        <div className="truncate"><span className="text-foreground">{m.characterName}</span> <span className="opacity-50">[{m.kind}] #{m.characterId}</span></div>
                        <div className="text-[10px] opacity-70 truncate">legacy: {m.legacyDiscordUsername}</div>
                      </div>
                      <div className="text-right whitespace-nowrap">
                        {m.matchedUserIds.length === 1 && <span>→ @{m.matchedUsernames[0]}</span>}
                        {m.matchedUserIds.length === 0 && <span>no user match</span>}
                        {m.matchedUserIds.length > 1 && <span>ambiguous ({m.matchedUserIds.length})</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {applyResult && (
          <div className="border-t border-border/50 pt-3 space-y-2" data-testid="block-claim-apply-result">
            <div className="text-xs font-mono">
              <span className="text-nc-cyan">{applyResult.applied.length} linked</span>
              {applyResult.skipped.length > 0 && (
                <span className="text-nc-yellow"> · {applyResult.skipped.length} skipped</span>
              )}
            </div>
            {applyResult.skipped.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {applyResult.skipped.map((s) => (
                  <div key={s.characterId} className="text-[10px] font-mono text-nc-yellow border border-nc-yellow/30 px-2 py-1">
                    #{s.characterId} {s.characterName}: {s.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BackfillCandidate {
  characterId: number;
  characterName: string;
  kind: string;
  threadId: string;
  attachmentCount: number;
  firstAttachment: { filename: string; contentType: string | null; width: number | null; height: number | null } | null;
  reason: string | null;
}
interface BackfillPreview {
  total: number;
  withAttachment: number;
  candidates: BackfillCandidate[];
}
interface BackfillApplyResult {
  requested: number;
  applied: Array<{ characterId: number; characterName: string; portraitUrl: string; sourceFilename: string }>;
  skipped: Array<{ characterId: number; characterName: string; reason: string }>;
}

function PortraitBackfillCard() {
  const { toast } = useToast();
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [result, setResult] = useState<BackfillApplyResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  // Per-character selection. Defaults to "checked" for every candidate that
  // has at least one attachment; rows without an attachment can't be applied
  // and stay disabled.
  const [picked, setPicked] = useState<Record<number, boolean>>({});

  async function loadPreview() {
    setBusy("preview");
    setResult(null);
    try {
      const r = await fetch("/api/admin/maintenance/portrait-backfill", { credentials: "include" });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Preview failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setPreview(body as BackfillPreview);
      const defaults: Record<number, boolean> = {};
      for (const c of (body as BackfillPreview).candidates) {
        if (c.attachmentCount > 0) defaults[c.characterId] = true;
      }
      setPicked(defaults);
    } finally {
      setBusy(null);
    }
  }

  async function applySelected() {
    const ids = Object.entries(picked).filter(([, v]) => v).map(([k]) => Number(k));
    if (ids.length === 0) {
      toast({ title: "Nothing selected", description: "Tick at least one row before applying.", variant: "destructive" });
      return;
    }
    const ok = window.confirm(
      `Download ${ids.length} portrait${ids.length === 1 ? "" : "s"} from Discord and save them as the primary portrait?\n\n` +
      `Characters that already have a portrait will be left alone.`,
    );
    if (!ok) return;
    setBusy("apply");
    try {
      const r = await fetch("/api/admin/maintenance/portrait-backfill", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterIds: ids }),
      });
      const body = await r.json();
      if (!r.ok) {
        toast({ title: "Backfill failed", description: body.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(body as BackfillApplyResult);
      toast({
        title: "Portrait backfill complete",
        description: `Saved ${body.applied?.length ?? 0}, skipped ${body.skipped?.length ?? 0}.`,
      });
      await loadPreview();
    } finally {
      setBusy(null);
    }
  }

  const eligible = preview?.candidates.filter((c) => c.attachmentCount > 0) ?? [];
  const noImg = preview?.candidates.filter((c) => c.attachmentCount === 0) ?? [];
  const selectedCount = Object.values(picked).filter(Boolean).length;

  return (
    <Card className="rounded-none border-nc-cyan/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">PORTRAIT BACKFILL FROM DISCORD</CardTitle>
        <CardDescription className="font-mono text-xs">
          For every character with no portrait but an <code>imported_from_thread_id</code>,
          fetches the OP message of their #character-sheets thread and offers to download
          the first image attachment as their portrait. Bytes are re-hosted on object
          storage (Discord CDN URLs expire after ~24h, so storing them directly would
          break). Existing portraits are never overwritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={loadPreview}
            disabled={busy !== null}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest"
            data-testid="button-portrait-preview"
          >
            {busy === "preview" ? "SCANNING DISCORD..." : preview ? "RE-SCAN" : "SCAN DISCORD"}
          </Button>
          {preview && (
            <Button
              type="button"
              onClick={applySelected}
              disabled={busy !== null || selectedCount === 0}
              className="rounded-none bg-destructive text-foreground hover:bg-destructive/80 font-display tracking-widest"
              data-testid="button-portrait-apply"
            >
              {busy === "apply" ? "DOWNLOADING..." : `BACKFILL SELECTED (${selectedCount})`}
            </Button>
          )}
        </div>

        {preview && (
          <div className="space-y-2">
            <div className="text-xs font-mono text-muted-foreground">
              {preview.total} character{preview.total === 1 ? "" : "s"} missing a portrait have a thread on file
              {" · "}{preview.withAttachment} have a recoverable image
            </div>

            {eligible.length > 0 && (
              <div className="space-y-1 max-h-96 overflow-y-auto" data-testid="block-portrait-eligible">
                {eligible.map((c) => {
                  const checked = !!picked[c.characterId];
                  return (
                    <label
                      key={c.characterId}
                      className={`border px-3 py-2 text-xs font-mono flex items-center justify-between gap-3 cursor-pointer ${
                        checked ? "border-nc-cyan/60 text-foreground" : "border-border/40 text-muted-foreground"
                      }`}
                      data-testid={`portrait-row-${c.characterId}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => setPicked((p) => ({ ...p, [c.characterId]: e.target.checked }))}
                          className="accent-nc-cyan"
                        />
                        <div className="min-w-0">
                          <div className="truncate">
                            <span className="text-foreground">{c.characterName}</span>{" "}
                            <span className="opacity-50">[{c.kind}] #{c.characterId}</span>
                          </div>
                          <div className="text-[10px] opacity-70 truncate">
                            {c.firstAttachment?.filename}
                            {c.firstAttachment?.width && c.firstAttachment?.height
                              ? ` · ${c.firstAttachment.width}×${c.firstAttachment.height}`
                              : ""}
                            {c.attachmentCount > 1 ? ` · +${c.attachmentCount - 1} more` : ""}
                          </div>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}

            {noImg.length > 0 && (
              <details className="border border-border/40 px-3 py-2">
                <summary className="text-xs font-mono text-muted-foreground cursor-pointer">
                  {noImg.length} thread{noImg.length === 1 ? "" : "s"} with no recoverable image (expand)
                </summary>
                <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
                  {noImg.map((c) => (
                    <div key={c.characterId} className="text-[10px] font-mono text-muted-foreground">
                      <span className="text-foreground">{c.characterName}</span>{" "}
                      <span className="opacity-50">[{c.kind}] #{c.characterId}</span>
                      <span className="opacity-70"> — {c.reason ?? "unknown"}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {result && (
          <div className="border-t border-border/50 pt-3 space-y-2" data-testid="block-portrait-apply-result">
            <div className="text-xs font-mono">
              <span className="text-nc-cyan">{result.applied.length} backfilled</span>
              {result.skipped.length > 0 && (
                <span className="text-nc-yellow"> · {result.skipped.length} skipped</span>
              )}
            </div>
            {result.skipped.length > 0 && (
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {result.skipped.map((s) => (
                  <div key={s.characterId} className="text-[10px] font-mono text-nc-yellow border border-nc-yellow/30 px-2 py-1">
                    #{s.characterId} {s.characterName}: {s.reason}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface BotImportTableResult { received: number; inserted: number; skippedInvalid: number; chunkFailures: number; note?: string }
interface BotImportResult {
  totals: { inserted: number; skippedInvalid: number; chunkFailures: number };
  tables: Record<string, BotImportTableResult>;
}

function BotImportCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<BotImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runBotImport(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const text = await file.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (e) {
        toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
        return;
      }
      const r = await fetch("/api/admin/maintenance/bot-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Bot import failed", description: data.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(data as BotImportResult);
      toast({
        title: "Bot DB import complete",
        description: `+${data.totals?.inserted ?? 0} new rows, ${data.totals?.skippedInvalid ?? 0} invalid, ${data.totals?.chunkFailures ?? 0} chunk failures`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await runBotImport(file);
    e.target.value = "";
  }

  return (
    <Card className="rounded-none border-nc-magenta/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-magenta">BOT DB IMPORT</CardTitle>
        <CardDescription className="font-mono text-xs">
          One-shot import of the legacy Discord bot's database: rent history, cyberware status,
          transaction ledger (balance_history), attendance, store inventory, mission log, tickets, etc.
          Stored as <code>bot_*</code> tables — separate from portal-native data so it stays read-only
          history. Idempotent: each table dedups on its natural key (bot_id, message_id, or composite).
          Upload <code>bot-db-import.json</code> (the file produced from your bot Replit).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            disabled={busy}
            className="font-mono text-xs"
            data-testid="input-bot-import-file"
          />
          {busy && <span className="text-xs font-mono text-nc-magenta animate-pulse">IMPORTING (may take 1\u20132 min for big payloads)...</span>}
        </div>

        {result && (
          <div className="border-t border-border/50 pt-4 space-y-3" data-testid="block-bot-import-result">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-2">
                <div className="text-2xl font-display text-nc-magenta">{result.totals.inserted}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">New Rows</div>
              </div>
              <div className="border border-nc-yellow/40 bg-nc-yellow/5 p-2">
                <div className="text-2xl font-display text-nc-yellow">{result.totals.skippedInvalid}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">Skipped (Invalid)</div>
              </div>
              <div className="border border-destructive/40 bg-destructive/5 p-2">
                <div className="text-2xl font-display text-destructive">{result.totals.chunkFailures}</div>
                <div className="text-xs font-mono text-muted-foreground uppercase">Chunk Failures</div>
              </div>
            </div>
            <div className="space-y-1">
              {Object.entries(result.tables).map(([name, r]) => (
                <div key={name} className="flex items-center justify-between border border-border/50 px-3 py-2 text-xs font-mono">
                  <span className="text-foreground">{name}</span>
                  <span className="text-muted-foreground">
                    {r.received} received, <span className="text-nc-magenta">+{r.inserted} new</span>
                    {r.skippedInvalid > 0 && <span className="text-nc-yellow"> / {r.skippedInvalid} invalid</span>}
                    {r.chunkFailures > 0 && <span className="text-destructive"> / {r.chunkFailures} chunk fail</span>}
                    {r.note && <span className="ml-2 text-muted-foreground/70 italic">({r.note})</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface FullImportResult {
  characters: { inserted: number; updated: number; skipped: number; errors: Array<{ name: string; error: string }> };
  character_status: { inserted: number; skipped: number; errors: Array<{ name: string; error: string }> };
  housing: { inserted: number; skipped: number; errors: Array<{ address: string; error: string }> };
  catalog_rent: { inserted: number; skipped: number; errors: Array<{ name: string; error: string }> };
}

function FullMigrationCard() {
  const { toast } = useToast();
  const [result, setResult] = useState<FullImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function runFullImport(file: File) {
    setBusy(true);
    setResult(null);
    try {
      const text = await file.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (e) {
        toast({ title: "Invalid JSON", description: (e as Error).message, variant: "destructive" });
        return;
      }
      const r = await fetch("/api/admin/maintenance/full-import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) {
        toast({ title: "Migration failed", description: data.error ?? `HTTP ${r.status}`, variant: "destructive" });
        return;
      }
      setResult(data as FullImportResult);
      toast({
        title: "Migration complete",
        description: `Chars +${data.characters?.inserted ?? 0}/~${data.characters?.updated ?? 0}, status +${data.character_status?.inserted ?? 0}, housing +${data.housing?.inserted ?? 0}, rent +${data.catalog_rent?.inserted ?? 0}`,
      });
    } finally {
      setBusy(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await runFullImport(file);
    e.target.value = "";
  }

  return (
    <Card className="rounded-none border-nc-yellow/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-yellow">FULL DEV → PROD MIGRATION</CardTitle>
        <CardDescription className="font-mono text-xs">
          One-shot import: characters (NPCs + PCs), character status, housing leases, and the housing rent catalog.
          Upload the <code>dev-to-prod-full.json</code> dump generated from the dev workspace. Idempotent:
          safe to re-run. Existing prod rows are preserved (owner assignments never touched, sheet/portrait
          edits only overwritten if the export has a non-empty value).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="file"
            accept="application/json,.json"
            onChange={onFile}
            disabled={busy}
            className="font-mono text-xs"
            data-testid="input-full-import-file"
          />
          {busy && <span className="text-xs font-mono text-nc-yellow animate-pulse">IMPORTING (may take 30s)...</span>}
        </div>

        {result && (
          <div className="border-t border-border/50 pt-4 space-y-3" data-testid="block-full-import-result">
            {(["characters", "character_status", "housing", "catalog_rent"] as const).map((k) => {
              const r = result[k];
              if (!r) return null;
              const ins = r.inserted ?? 0;
              const upd = ("updated" in r ? r.updated : 0) ?? 0;
              const skp = r.skipped ?? 0;
              const errs = r.errors ?? [];
              return (
                <div key={k} className="border border-border/50 p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-display tracking-widest text-xs uppercase">{k.replace("_", " ")}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      +{ins} inserted{("updated" in r) ? `, ~${upd} updated` : ""}, {skp} skipped, {errs.length} errors
                    </span>
                  </div>
                  {errs.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {errs.slice(0, 20).map((e, i) => (
                        <div key={i} className="text-xs font-mono text-destructive border border-destructive/30 px-2 py-1">
                          <span className="font-bold">{("name" in e ? e.name : e.address) ?? ""}:</span> {e.error}
                        </div>
                      ))}
                      {errs.length > 20 && (
                        <div className="text-xs font-mono text-muted-foreground">+ {errs.length - 20} more errors</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

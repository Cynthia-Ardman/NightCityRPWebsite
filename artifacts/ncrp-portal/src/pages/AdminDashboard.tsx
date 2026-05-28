import { useAdminListUsers, useAdminListCharacters, useAdminAdjustWallet, useAdminListJobs, useAdminRunJob, useAdminAssignCharacterOwner, useAdminClearCharacterOwner, useAdminListAudit, useAdminListBotConfig, useAdminSetBotConfig, useAdminDeleteBotConfig, getAdminListJobsQueryKey, getAdminListCharactersQueryKey, getAdminListAuditQueryKey, getAdminListBotConfigQueryKey } from "@workspace/api-client-react";
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

  // Fixers get a scoped view (Characters tab only) so they can run the
  // canon-enforcement claim workflow without exposing the full admin
  // surface (users / wallets / jobs).
  const isFixerOnly = !user?.isAdmin && !!user?.isFixer;
  if (!user?.isAdmin && !user?.isFixer) {
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
          {isFixerOnly ? "FIXER_CONSOLE" : "SYSTEM_ADMIN"}
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          {isFixerOnly
            ? "Canon enforcement. Assign owners to unclaimed sheets."
            : "God mode enabled. Proceed with caution."}
        </p>
      </div>

      <Tabs defaultValue={isFixerOnly ? "characters" : "users"} className="w-full">
        <TabsList className={`bg-card border border-border rounded-none p-0 h-auto grid ${isFixerOnly ? "grid-cols-1 max-w-xs" : "grid-cols-2 md:grid-cols-6 max-w-5xl"} w-full`}>
          {!isFixerOnly && (
            <TabsTrigger value="users" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-users">Users</TabsTrigger>
          )}
          <TabsTrigger value="characters" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-chars">Characters</TabsTrigger>
          {!isFixerOnly && (
            <TabsTrigger value="wallet" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-wallet">Wallets</TabsTrigger>
          )}
          {!isFixerOnly && (
            <TabsTrigger value="jobs" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-jobs">Cron Jobs</TabsTrigger>
          )}
          {!isFixerOnly && (
            <TabsTrigger value="audit" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-audit">Audit</TabsTrigger>
          )}
          {!isFixerOnly && (
            <TabsTrigger value="flags" className="rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3" data-testid="tab-flags">System Flags</TabsTrigger>
          )}
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
            <AuditTab />
          </TabsContent>
          <TabsContent value="flags">
            <FlagsTab />
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
  const { data: users, isLoading } = useAdminListUsers();

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Querying users...</div>;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display">Registered Users</CardTitle>
        <CardDescription className="font-mono">Discord identities linked to the portal.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border border-border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="font-display text-nc-cyan">User</TableHead>
                <TableHead className="font-display text-nc-cyan">Discord ID</TableHead>
                <TableHead className="font-display text-nc-cyan">Roles</TableHead>
                <TableHead className="font-display text-nc-cyan text-right">Characters</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono text-sm">
              {users?.map(u => (
                <TableRow key={u.id} className="hover:bg-muted/50 border-border cursor-pointer transition-colors" data-testid={`row-user-${u.id}`}>
                  <TableCell className="font-medium text-foreground">
                    <Link href={`/admin/users/${u.id}`} className="hover:underline">{u.globalName || u.username}</Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{u.discordId}</TableCell>
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
              ))}
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

function JobsTab() {
  const { data: jobs, isLoading } = useAdminListJobs();
  const runJob = useAdminRunJob();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleRunJob = (jobId: "cyberware_humanity" | "monthly_rent" | "role_sync") => {
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
        <CardDescription className="font-mono">Manually trigger background processes.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
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

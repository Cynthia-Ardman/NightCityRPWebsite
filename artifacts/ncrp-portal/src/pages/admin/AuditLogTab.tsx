import { useAdminListAudit, useAdminListAuditLog, getAdminListAuditQueryKey, getAdminListAuditLogQueryKey, type AuditLogRow } from "@workspace/api-client-react";
import { formatDateTime } from "@/lib/format";
import { useState, useEffect, Fragment } from "react";
import { Link } from "wouter";
import { Activity } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQueryClient } from "@tanstack/react-query";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import { AUDIT_PAGE_SIZE, AUDIT_SUBTABS, auditTargetLink } from "./audit-constants";
import { AuditDiff } from "./AuditDiff";

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
          <Input className="md:col-span-4" placeholder="actor name or user id" value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="input-audit-actor" />
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
                    <TableCell className="text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="rounded-none border-nc-magenta text-nc-magenta text-[0.625rem] px-1 py-0">
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

export function AuditLogTab() {
  const [sub, setSub] = useState("all");
  const [actorId, setActorId] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [q, setQ] = useState("");
  const [targetChar, setTargetChar] = useState<CharacterPickerValue>(null);
  // A pivot target ("related activity" from an entry) can be any target type,
  // not just characters; it overrides the character picker when set.
  const [pivotTarget, setPivotTarget] = useState<{ type: string; id: string; label: string } | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [acc, setAcc] = useState<AuditLogRow[]>([]);

  const tab = AUDIT_SUBTABS.find((t) => t.key === sub) ?? AUDIT_SUBTABS[0];
  // Single-category sub-tabs use the server filter; multi-category sub-tabs
  // (shop+attend) pull "all" and filter client-side. Action-scoped sub-tabs
  // (payouts) also push their action list to the server so non-matching rows
  // can't crowd payouts out of the limited result window.
  const serverCategory = tab.categories.length === 1 ? tab.categories[0] : undefined;
  // An explicit action filter (comma-separated list) overrides the sub-tab's
  // preset action list on the server side.
  const explicitActions = actionFilter
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const serverAction = explicitActions.length
    ? explicitActions.join(",")
    : tab.actions?.length
      ? tab.actions.join(",")
      : undefined;
  const target = pivotTarget ?? (targetChar ? { type: "character", id: String(targetChar.id), label: targetChar.name } : null);
  const baseParams = {
    ...(serverCategory ? { category: serverCategory } : {}),
    ...(serverAction ? { action: serverAction } : {}),
    ...(actorId ? { actorId } : {}),
    ...(since ? { since: new Date(since).toISOString() } : {}),
    ...(until ? { until: new Date(until).toISOString() } : {}),
    ...(target ? { targetType: target.type, targetId: target.id } : {}),
    ...(q.trim() ? { q: q.trim() } : {}),
  };
  const filterSig = JSON.stringify(baseParams);
  // Reset the accumulated pages whenever any filter changes.
  useEffect(() => {
    setAcc([]);
    setCursor(undefined);
    setExpandedId(null);
  }, [filterSig]);

  const params = { ...baseParams, ...(cursor !== undefined ? { beforeId: cursor } : {}), limit: AUDIT_PAGE_SIZE };
  const { data: rows, isLoading, isFetching, refetch } = useAdminListAuditLog(params);
  const qc = useQueryClient();
  useEffect(() => {
    if (!rows) return;
    setAcc((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      const merged = [...prev, ...rows.filter((r) => !seen.has(r.id))];
      merged.sort((x, y) => y.id - x.id);
      return merged;
    });
  }, [rows]);
  const hasMore = (rows?.length ?? 0) === AUDIT_PAGE_SIZE;

  let visibleRows = tab.categories.length > 1
    ? acc.filter((r) => tab.categories.includes(r.category))
    : acc;
  if (explicitActions.length) {
    visibleRows = visibleRows.filter((r) => explicitActions.includes(r.action));
  } else if (tab.actions?.length) {
    visibleRows = visibleRows.filter((r) => tab.actions!.includes(r.action));
  }

  const anyFilter = Boolean(actorId || actionFilter || since || until || q || target || sub !== "all");
  const clearAll = () => {
    setSub("all");
    setActorId("");
    setActionFilter("");
    setSince("");
    setUntil("");
    setQ("");
    setTargetChar(null);
    setPivotTarget(null);
  };
  const refresh = () => {
    setAcc([]);
    setCursor(undefined);
    qc.invalidateQueries({ queryKey: getAdminListAuditLogQueryKey() });
    refetch();
  };
  const pivotToActor = (e: AuditLogRow) => {
    setActorId(e.actorId ?? e.actorName ?? "");
    setPivotTarget(null);
    setTargetChar(null);
  };
  const pivotToTarget = (e: AuditLogRow) => {
    if (!e.targetType || !e.targetId) return;
    setActorId("");
    setTargetChar(null);
    setPivotTarget({ type: e.targetType, id: e.targetId, label: `${e.targetType} #${e.targetId}` });
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan">Audit Log</CardTitle>
        <CardDescription className="font-mono">
          Unified staff-facing audit explorer. Stack filters, click a row for full change details, and pivot to related activity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={sub} onValueChange={setSub}>
          <TabsList className="bg-card border border-border rounded-none p-0 h-auto grid grid-cols-3 md:grid-cols-9 w-full">
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
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 font-mono text-xs items-start">
          <Input className="md:col-span-3" placeholder="Search details (message, action, changed values)..." value={q} onChange={(e) => setQ(e.target.value)} data-testid="input-auditlog-search" />
          <Input className="md:col-span-3" placeholder="actor name or user id" value={actorId} onChange={(e) => setActorId(e.target.value)} data-testid="input-auditlog-actor" />
          <Input className="md:col-span-3" placeholder="action (comma-separated)" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} data-testid="input-auditlog-action" />
          <div className="md:col-span-3">
            {pivotTarget ? (
              <div className="flex items-center justify-between border border-nc-cyan/60 bg-background px-3 h-10" data-testid="chip-auditlog-target">
                <span className="truncate text-foreground">Target: {pivotTarget.label}</span>
                <button type="button" className="text-muted-foreground hover:text-destructive ml-2" onClick={() => setPivotTarget(null)} data-testid="button-auditlog-target-clear">✕</button>
              </div>
            ) : (
              <CharacterPicker value={targetChar} onChange={setTargetChar} scope="all" placeholder="Target character..." testId="picker-auditlog-character" />
            )}
          </div>
          <div className="md:col-span-4">
            <Label className="text-[0.625rem] uppercase text-muted-foreground">From</Label>
            <Input type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} data-testid="input-auditlog-since" />
          </div>
          <div className="md:col-span-4">
            <Label className="text-[0.625rem] uppercase text-muted-foreground">To</Label>
            <Input type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} data-testid="input-auditlog-until" />
          </div>
          <div className="md:col-span-4 flex gap-2 md:self-end">
            <Button
              className="flex-1 rounded-none bg-nc-cyan text-background font-display"
              onClick={refresh}
              data-testid="button-auditlog-apply"
            >
              REFRESH
            </Button>
            <Button
              variant="outline"
              className="flex-1 rounded-none border-border font-display"
              disabled={!anyFilter}
              onClick={clearAll}
              data-testid="button-auditlog-clear"
            >
              CLEAR
            </Button>
          </div>
        </div>
        {isLoading && acc.length === 0 ? (
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
                {visibleRows.map((e) => {
                  const link = auditTargetLink(e.targetType, e.targetId);
                  const expanded = expandedId === e.id;
                  return (
                    <Fragment key={e.id}>
                      <TableRow
                        className="hover:bg-muted/50 border-border cursor-pointer"
                        onClick={() => setExpandedId(expanded ? null : e.id)}
                        data-testid={`row-auditlog-${e.id}`}
                      >
                        <TableCell className="text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow text-[0.625rem] px-1 py-0">
                            {e.category}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-nc-magenta">{e.action}</TableCell>
                        <TableCell className="text-nc-cyan">{e.actorName ?? e.actorId ?? "—"}</TableCell>
                        <TableCell className="text-foreground">{e.message ?? "—"}</TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="border-border bg-muted/20 hover:bg-muted/20">
                          <TableCell colSpan={5} className="p-4 space-y-3" data-testid={`detail-auditlog-${e.id}`}>
                            <div className="flex flex-wrap gap-2 items-center">
                              {link && (
                                <Link href={link} onClick={(ev) => ev.stopPropagation()}>
                                  <Button size="sm" variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-display text-xs" data-testid={`link-auditlog-target-${e.id}`}>
                                    OPEN {e.targetType?.replace(/_/g, " ").toUpperCase()}
                                  </Button>
                                </Link>
                              )}
                              {(e.actorId || e.actorName) && (
                                <Button size="sm" variant="outline" className="rounded-none border-border font-display text-xs" onClick={(ev) => { ev.stopPropagation(); pivotToActor(e); }} data-testid={`button-auditlog-pivot-actor-${e.id}`}>
                                  SAME ACTOR
                                </Button>
                              )}
                              {e.targetType && e.targetId && (
                                <Button size="sm" variant="outline" className="rounded-none border-border font-display text-xs" onClick={(ev) => { ev.stopPropagation(); pivotToTarget(e); }} data-testid={`button-auditlog-pivot-target-${e.id}`}>
                                  SAME TARGET
                                </Button>
                              )}
                            </div>
                            <div className="grid md:grid-cols-2 gap-x-6 gap-y-1 text-muted-foreground">
                              {e.targetType && <div>Target: <span className="text-foreground">{e.targetType} {e.targetId ?? ""}</span></div>}
                              {e.actorId && <div>Actor ID: <span className="text-foreground">{e.actorId}</span></div>}
                              {e.actorIp && <div>IP: <span className="text-foreground">{e.actorIp}</span></div>}
                            </div>
                            <AuditDiff before={e.beforeJson} after={e.afterJson} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
                {!visibleRows.length && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground h-24">NO EVENTS</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
        <div className="flex justify-center">
          {hasMore && (
            <Button
              variant="outline"
              className="rounded-none border-nc-cyan text-nc-cyan font-display"
              disabled={isFetching}
              onClick={() => {
                const minId = acc.length ? Math.min(...acc.map((r) => r.id)) : undefined;
                if (minId !== undefined) setCursor(minId);
              }}
              data-testid="button-auditlog-more"
            >
              {isFetching ? "LOADING..." : "LOAD MORE"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

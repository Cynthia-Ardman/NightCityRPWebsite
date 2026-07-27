import { formatDate, formatEddies } from "@/lib/format";
import { useState } from "react";
import { Link } from "wouter";
import {
  useAdminGetAnalyticsCharacterTrend,
  getAdminGetAnalyticsCharacterTrendQueryKey,
  useAdminGetAnalyticsVrchatInstances,
  getAdminGetAnalyticsVrchatInstancesQueryKey,
  useAdminGetAnalyticsMissionsWeek,
  getAdminGetAnalyticsMissionsWeekQueryKey,
  useAdminGetAnalyticsEconomyTransactions,
  getAdminGetAnalyticsEconomyTransactionsQueryKey,
  type AdminGetAnalyticsVrchatInstancesParams,
  type AnalyticsVrchatInstance,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from "recharts";

const tooltipStyle = {
  backgroundColor: "hsl(240 10% 8%)",
  border: "1px solid hsl(240 6% 25%)",
  borderRadius: 0,
  fontFamily: "monospace",
  fontSize: "0.75rem",
} as const;

function fmtWeekLong(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const LOADING = <div className="py-6 text-center text-muted-foreground text-xs font-mono">LOADING…</div>;

/* ------------------------- CHARACTER TREND WEEK ------------------------- */

export function CharacterTrendDialog({ week, onClose }: { week: string | null; onClose: () => void }) {
  const params = { week: week ?? "" };
  const { data, isLoading } = useAdminGetAnalyticsCharacterTrend(params, {
    query: { enabled: week !== null, queryKey: getAdminGetAnalyticsCharacterTrendQueryKey(params) },
  });
  const section = (label: string, color: string, rows: Array<{ id: number; name: string; ownerName: string | null }>) => (
    <div>
      <div className={`font-display tracking-widest text-sm mb-1 ${color}`}>
        {label} — {rows.length}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">None this week.</p>
      ) : (
        <div className="divide-y divide-border/50">
          {rows.map((c) => (
            <Link
              key={c.id}
              href={`/characters/${c.id}`}
              className="flex items-center justify-between gap-3 px-1 py-1.5 hover:bg-accent/40"
              data-testid={`link-trend-char-${c.id}`}
            >
              <span className="truncate text-foreground">{c.name}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">{c.ownerName ?? "unclaimed"}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <Dialog open={week !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg rounded-none border-border bg-card font-mono">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-base">
            ACTIVITY CHANGES — WEEK OF {week ? fmtWeekLong(week) : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-4 text-sm" data-testid="dialog-character-trend">
          {isLoading && LOADING}
          {data && (
            <>
              {section("BECAME ACTIVE", "text-nc-cyan", data.gained)}
              {section("WENT DORMANT", "text-nc-magenta", data.lost)}
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">Compared against the prior week's snapshot. Live PCs only.</p>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------- VRCHAT INSTANCES --------------------------- */

export type VrchatDrillTarget = { week: string } | { world: string; range: "4w" | "3m" | "1y" | "all" };

function InstanceSparkline({ inst }: { inst: AnalyticsVrchatInstance }) {
  if (inst.samples.length < 2) {
    return <div className="text-[0.625rem] text-muted-foreground italic">no headcount samples</div>;
  }
  return (
    <div className="h-12 w-full" data-testid={`sparkline-instance-${inst.id}`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={inst.samples}>
          <YAxis hide domain={[0, "auto"]} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={() => ""}
            formatter={(v: number, _n, item) => [`${v} players @ ${fmtTime((item.payload as { at: string }).at)}`, ""]}
          />
          <Line type="monotone" dataKey="userCount" stroke="#00f0ff" strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function VrchatInstancesDialog({ target, onClose }: { target: VrchatDrillTarget | null; onClose: () => void }) {
  const params: AdminGetAnalyticsVrchatInstancesParams =
    target && "week" in target ? { week: target.week } : { world: target?.world ?? "", range: target && "range" in target ? target.range : "3m" };
  const { data, isLoading } = useAdminGetAnalyticsVrchatInstances(params, {
    query: { enabled: target !== null, queryKey: getAdminGetAnalyticsVrchatInstancesQueryKey(params) },
  });
  const title =
    target === null ? "" : "week" in target ? `INSTANCES — WEEK OF ${fmtWeekLong(target.week)}` : `INSTANCES — ${target.world.toUpperCase()}`;
  const instances = data?.instances ?? [];
  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl rounded-none border-border bg-card font-mono">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-base truncate">{title}</DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto space-y-3 text-sm" data-testid="dialog-vrchat-instances">
          {isLoading && LOADING}
          {!isLoading && instances.length === 0 && (
            <p className="py-6 text-center text-xs text-muted-foreground">No instances recorded.</p>
          )}
          {instances.map((inst) => (
            <div key={inst.id} className="border border-border p-3 space-y-2" data-testid={`card-instance-${inst.id}`}>
              <div className="flex items-start justify-between gap-3">
                <span className="text-foreground truncate">{inst.worldName}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {inst.source === "vrcx" ? "VRCX import" : "live poller"}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {fmtTime(inst.firstSeenAt)} → {inst.closedAt ? fmtTime(inst.closedAt) : "open"} · {inst.durationMinutes}m
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 text-xs">
                <div>
                  <span className="text-muted-foreground">peak </span>
                  <span className="text-nc-magenta">{inst.peakUserCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">avg </span>
                  <span className="text-nc-cyan">{inst.avgUserCount}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">median </span>
                  <span className="text-nc-yellow">{inst.medianUserCount}</span>
                </div>
                {inst.uniqueUsers !== null && (
                  <div>
                    <span className="text-muted-foreground">players </span>
                    <span className="text-foreground">{inst.uniqueUsers}</span>
                  </div>
                )}
              </div>
              <InstanceSparkline inst={inst} />
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------- MISSIONS WEEK ----------------------------- */

export function MissionsWeekDialog({ week, onClose }: { week: string | null; onClose: () => void }) {
  const params = { week: week ?? "" };
  const { data, isLoading } = useAdminGetAnalyticsMissionsWeek(params, {
    query: { enabled: week !== null, queryKey: getAdminGetAnalyticsMissionsWeekQueryKey(params) },
  });
  return (
    <Dialog open={week !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl rounded-none border-border bg-card font-mono">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-base">
            MISSIONS — WEEK OF {week ? fmtWeekLong(week) : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto space-y-4 text-sm" data-testid="dialog-missions-week">
          {isLoading && LOADING}
          {data && (
            <>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="border border-border p-2">
                  <div className="text-muted-foreground">WEEK PAYOUTS</div>
                  <div className="text-lg text-nc-yellow" data-testid="stat-week-total-payout">{formatEddies(data.totalPayout)}</div>
                </div>
                <div className="border border-border p-2">
                  <div className="text-muted-foreground">PLAYER PAY</div>
                  <div className="text-lg text-nc-cyan" data-testid="stat-week-player-payout">{formatEddies(data.playerPayout)}</div>
                </div>
                <div className="border border-border p-2">
                  <div className="text-muted-foreground">ACTOR / NPC PAY</div>
                  <div className="text-lg text-nc-magenta" data-testid="stat-week-actor-payout">{formatEddies(data.actorPayout)}</div>
                </div>
              </div>
              {data.missions.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">No missions completed this week.</p>
              ) : (
                <div className="divide-y divide-border/50">
                  {data.missions.map((m) => (
                    <Link
                      key={m.id}
                      href={`/missions/${m.id}`}
                      className="block px-1 py-2 hover:bg-accent/40"
                      data-testid={`link-week-mission-${m.id}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate text-foreground">{m.title}</span>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {m.completedAt ? formatDate(m.completedAt) : m.status}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                        {m.fixerName && <span>fixer: {m.fixerName}</span>}
                        <span>{m.participants} participant{m.participants === 1 ? "" : "s"}</span>
                        <span>
                          player <span className="text-nc-cyan">{formatEddies(m.playerPayout)}</span>
                        </span>
                        <span>
                          actor <span className="text-nc-magenta">{formatEddies(m.actorPayout)}</span>
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Week totals match the chart bar (ledger rows created that week). Per-mission figures are all-time pay for that mission and may
                settle in a different week.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------- ECONOMY WEEK ---------------------------- */

export function EconomyWeekDialog({
  week,
  created,
  destroyed,
  excludeAbove,
  onClose,
}: {
  week: string | null;
  created: Record<string, number>;
  destroyed: Record<string, number>;
  excludeAbove: number | null;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<{ category: string; direction: "created" | "destroyed" } | null>(null);
  const params = {
    week: week ?? "",
    category: picked?.category ?? "",
    direction: picked?.direction ?? ("created" as const),
    ...(excludeAbove !== null ? { excludeAbove } : {}),
  };
  const { data, isLoading } = useAdminGetAnalyticsEconomyTransactions(params, {
    query: { enabled: week !== null && picked !== null, queryKey: getAdminGetAnalyticsEconomyTransactionsQueryKey(params) },
  });
  const close = () => {
    setPicked(null);
    onClose();
  };
  const catList = (direction: "created" | "destroyed", map: Record<string, number>, color: string, label: string) => {
    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
    return (
      <div>
        <div className={`font-display tracking-widest text-sm mb-1 ${color}`}>{label}</div>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Nothing this week.</p>
        ) : (
          <div className="divide-y divide-border/50">
            {entries.map(([cat, amt]) => (
              <button
                key={cat}
                type="button"
                onClick={() => setPicked({ category: cat, direction })}
                className="flex w-full items-center justify-between gap-3 px-1 py-1.5 text-left hover:bg-accent/40"
                data-testid={`button-econ-cat-${direction}-${cat}`}
              >
                <span className="text-foreground">{cat}</span>
                <span className="text-xs text-muted-foreground">{formatEddies(amt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };
  return (
    <Dialog open={week !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl rounded-none border-border bg-card font-mono">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-base">
            {picked ? (
              <button type="button" onClick={() => setPicked(null)} className="hover:text-nc-cyan" data-testid="button-econ-back">
                ← {picked.direction.toUpperCase()}: {picked.category.toUpperCase()} — WEEK OF {week ? fmtWeekLong(week) : ""}
              </button>
            ) : (
              <>ECONOMY — WEEK OF {week ? fmtWeekLong(week) : ""}</>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[65vh] overflow-y-auto space-y-4 text-sm" data-testid="dialog-economy-week">
          {picked === null ? (
            <>
              {catList("created", created, "text-nc-cyan", "CREATED (INTO WALLETS)")}
              {catList("destroyed", destroyed, "text-nc-magenta", "DESTROYED (OUT OF WALLETS)")}
              <p className="text-xs text-muted-foreground">Click a category to list the underlying transactions.</p>
            </>
          ) : (
            <>
              {isLoading && LOADING}
              {data && (
                <>
                  <div className="text-xs text-muted-foreground">
                    {data.transactions.length} shown · total {formatEddies(data.total)}
                    {data.truncated && <span className="text-nc-yellow"> · list capped at 500 rows (largest first)</span>}
                  </div>
                  {data.transactions.length === 0 ? (
                    <p className="py-4 text-center text-xs text-muted-foreground">No transactions matched.</p>
                  ) : (
                    <div className="divide-y divide-border/50">
                      {data.transactions.map((t) => (
                        <div key={t.id} className="px-1 py-2" data-testid={`row-econ-tx-${t.id}`}>
                          <div className="flex items-center justify-between gap-3">
                            <span className="truncate text-foreground">
                              {t.userName ?? "unknown"}
                              {t.characterName && <span className="text-muted-foreground"> · {t.characterName}</span>}
                            </span>
                            <span className={`whitespace-nowrap ${t.amount >= 0 ? "text-nc-cyan" : "text-nc-magenta"}`}>
                              {formatEddies(t.amount)}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                            <span>{formatDate(t.createdAt)}</span>
                            <span>{t.kind}</span>
                            {t.memo && <span className="truncate max-w-[24rem]">{t.memo}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { useState } from "react";
import { useAdminFixerActivity, type FixerActivityRow } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

const WINDOWS = [
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
] as const;

// How long without any fixer-attributable action counts as "idle" for the
// red highlight, independent of the selected stats window.
const IDLE_DAYS = 30;

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function relativeLabel(iso: string | null | undefined): string {
  const d = daysAgo(iso);
  if (d === null) return "never";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 30) return `${d} days ago`;
  return formatDate(iso);
}

function Sparkline({ weekly }: { weekly: number[] }) {
  const max = Math.max(1, ...weekly);
  return (
    <div className="flex items-end gap-[2px] h-8" title="Staff actions per week (oldest → newest)">
      {weekly.map((v, i) => (
        <div
          key={i}
          className={v > 0 ? "bg-nc-cyan/70 w-[6px]" : "bg-border w-[6px]"}
          style={{ height: `${v > 0 ? Math.max(12, (v / max) * 100) : 6}%` }}
        />
      ))}
    </div>
  );
}

function totalActivity(f: FixerActivityRow): number {
  return (
    f.missionsCreated + f.missionsCompleted + f.reviewVotes + f.reviewComments +
    f.requestsClosed + f.eventsCreated + f.actorPayments
  );
}

export default function FixerActivityTab() {
  const [days, setDays] = useState<number>(90);
  const { data, isLoading, error } = useAdminFixerActivity({ days });

  return (
    <Card className="rounded-none border-border">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="font-display uppercase tracking-widest">Fixer Activity</CardTitle>
            <CardDescription className="font-mono mt-1">
              Fixer-attributable actions in the selected window. Idle fixers (no fixer action in {IDLE_DAYS}+ days) are listed first and flagged.
            </CardDescription>
          </div>
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <Button
                key={w.days}
                size="sm"
                variant={days === w.days ? "default" : "outline"}
                className="rounded-none font-mono"
                onClick={() => setDays(w.days)}
                data-testid={`button-window-${w.days}`}
              >
                {w.label}
              </Button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-muted-foreground font-mono py-8 text-center">Loading fixer activity…</p>
        ) : error ? (
          <p className="text-destructive font-mono py-8 text-center">Failed to load fixer activity.</p>
        ) : !data || data.fixers.length === 0 ? (
          <p className="text-muted-foreground font-mono py-8 text-center">No fixers found.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fixer</TableHead>
                  <TableHead>Last fixer action</TableHead>
                  <TableHead>Last on site</TableHead>
                  <TableHead className="text-right">Missions created</TableHead>
                  <TableHead className="text-right">Missions completed</TableHead>
                  <TableHead className="text-right">Review votes</TableHead>
                  <TableHead className="text-right">Comments</TableHead>
                  <TableHead className="text-right">Tickets closed</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">NPC payouts</TableHead>
                  <TableHead className="text-right">All staff actions</TableHead>
                  <TableHead>Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.fixers.map((f) => {
                  const idleDays = daysAgo(f.lastFixerActionAt);
                  const isIdle = idleDays === null || idleDays >= IDLE_DAYS;
                  const quiet = totalActivity(f) === 0;
                  return (
                    <TableRow key={f.userId} data-testid={`row-fixer-${f.userId}`} className={isIdle ? "bg-destructive/5" : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {f.avatarUrl ? (
                            <img src={f.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-muted shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate">{f.globalName || f.username}</div>
                            <div className="flex gap-1 mt-0.5">
                              {f.isTrialFixer && (
                                <Badge variant="outline" className="rounded-none text-[0.65rem] font-mono">TRIAL</Badge>
                              )}
                              {isIdle && (
                                <Badge variant="destructive" className="rounded-none text-[0.65rem] font-mono">IDLE</Badge>
                              )}
                              {!isIdle && quiet && (
                                <Badge variant="outline" className="rounded-none text-[0.65rem] font-mono text-yellow-500 border-yellow-500/50">NO FIXER WORK</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono whitespace-nowrap">
                        <span className={isIdle ? "text-destructive" : undefined}>{relativeLabel(f.lastFixerActionAt)}</span>
                      </TableCell>
                      <TableCell className="font-mono whitespace-nowrap text-muted-foreground">
                        {relativeLabel(f.lastSeenAt)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{f.missionsCreated}</TableCell>
                      <TableCell className="text-right font-mono">{f.missionsCompleted}</TableCell>
                      <TableCell className="text-right font-mono">{f.reviewVotes}</TableCell>
                      <TableCell className="text-right font-mono">{f.reviewComments}</TableCell>
                      <TableCell className="text-right font-mono">{f.requestsClosed}</TableCell>
                      <TableCell className="text-right font-mono">{f.eventsCreated}</TableCell>
                      <TableCell className="text-right font-mono">{f.actorPayments}</TableCell>
                      <TableCell className="text-right font-mono">{f.auditActions}</TableCell>
                      <TableCell><Sparkline weekly={f.weekly} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

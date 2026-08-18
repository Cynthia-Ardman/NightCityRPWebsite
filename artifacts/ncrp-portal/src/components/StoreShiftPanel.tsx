import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMyActiveShift,
  useListStoreShifts,
  useClockInStoreShift,
  useClockOutStoreShift,
  useUpdateStore,
  getGetMyActiveShiftQueryKey,
  getListStoreShiftsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Clock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";
import { formatEddies } from "@/lib/format";

// Live countdown to the end of the 4-hour shift window.
function Countdown({ until }: { until: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return <span className="text-destructive">ENDED</span>;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return <span>{h > 0 ? `${h}h ` : ""}{m}m left</span>;
}

// Bar shift clock-in / wage split panel, shown on the store management page
// when staff have enabled shifts for the venue. Owners and employees clock in
// for 4-hour shifts; while anyone is clocked in, each venue-credited sale
// splits the owner-set % evenly among active workers (replacing commission).
export default function StoreShiftPanel({
  storeId,
  shiftWagePct,
  canManage,
  canWork,
}: {
  storeId: number;
  shiftWagePct: number;
  canManage: boolean;
  // Owner or employee — the people who can actually clock in.
  canWork: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: mine } = useGetMyActiveShift();
  const { data: report } = useListStoreShifts(storeId);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetMyActiveShiftQueryKey() });
    qc.invalidateQueries({ queryKey: getListStoreShiftsQueryKey(storeId) });
  };
  const clockIn = useClockInStoreShift({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Clocked in", description: "Your 4-hour shift has started." });
      },
      onError: (err) =>
        toast({
          title: "Could not clock in",
          description: apiErrorMessage(err, "Please try again."),
          variant: "destructive",
        }),
    },
  });
  const clockOut = useClockOutStoreShift({
    mutation: {
      onSuccess: (shift) => {
        invalidate();
        toast({ title: "Clocked out", description: `You earned ${formatEddies(shift.earnedTotal)} this shift.` });
      },
      onError: (err) =>
        toast({
          title: "Could not clock out",
          description: apiErrorMessage(err, "Please try again."),
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateStore({ mutation: { onSuccess: invalidate } });
  const [pctDraft, setPctDraft] = useState(String(shiftWagePct));
  useEffect(() => setPctDraft(String(shiftWagePct)), [shiftWagePct]);

  const active = mine?.shift ?? null;
  const activeHere = active?.storeId === storeId;
  const crew = (report?.shifts ?? []).filter((s) => !s.clockOutAt);
  const history = (report?.shifts ?? []).filter((s) => s.clockOutAt).slice(0, 20);

  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="panel-shifts">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="font-display tracking-widest flex items-center gap-2">
          <Clock className="w-4 h-4" /> SHIFTS
        </CardTitle>
        {canManage && (
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-muted-foreground uppercase">Wage split</span>
            <Input
              type="number"
              min={0}
              max={100}
              value={pctDraft}
              onChange={(e) => setPctDraft(e.target.value)}
              onBlur={() => {
                const pct = Math.max(0, Math.min(100, Math.round(Number(pctDraft)) || 0));
                setPctDraft(String(pct));
                if (pct !== shiftWagePct)
                  update.mutate(
                    { id: storeId, data: { shiftWagePct: pct } },
                    { onSuccess: () => toast({ title: "Wage split saved", description: `${pct}% of each sale is split among clocked-in workers.` }) },
                  );
              }}
              className="w-20 h-8"
              data-testid="input-shift-wage-pct"
            />
            <span className="text-muted-foreground">%</span>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        <p className="text-xs text-muted-foreground">
          Clock in for a 4-hour shift. While anyone is on shift, {shiftWagePct}% of every sale is split evenly among
          the clocked-in crew and paid instantly (this replaces per-sale commission).
        </p>
        {activeHere ? (
          <div className="flex flex-wrap items-center gap-3 border border-nc-cyan/40 bg-nc-cyan/5 p-3" data-testid="banner-my-shift">
            <span className="text-nc-cyan font-display">ON SHIFT</span>
            <span>{active!.characterName ?? "—"}</span>
            <span className="text-muted-foreground"><Countdown until={active!.scheduledEndAt} /></span>
            <span>Earned {formatEddies(active!.earnedTotal)} · {active!.salesCount} sales</span>
            <Button
              size="sm"
              variant="outline"
              disabled={clockOut.isPending}
              onClick={() => clockOut.mutate({ id: storeId })}
              className="rounded-none ml-auto"
              data-testid="button-clock-out"
            >
              CLOCK OUT
            </Button>
          </div>
        ) : active ? (
          <p className="text-xs text-nc-yellow" data-testid="text-shift-elsewhere">
            You're already on shift at {active.storeName ?? "another venue"} — clock out there first.
          </p>
        ) : canWork ? (
          <Button
            size="sm"
            disabled={clockIn.isPending}
            onClick={() => clockIn.mutate({ id: storeId, data: {} })}
            className="rounded-none bg-nc-cyan text-background font-display"
            data-testid="button-clock-in"
          >
            CLOCK IN
          </Button>
        ) : null}

        {crew.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-1">On shift now</p>
            {crew.map((s) => (
              <div key={s.id} className="flex justify-between border-b border-border/30 py-1" data-testid={`row-shift-active-${s.id}`}>
                <span>{s.characterName ?? "—"}</span>
                <span className="text-muted-foreground text-xs">
                  <Countdown until={s.scheduledEndAt} /> · {formatEddies(s.earnedTotal)} · {s.salesCount} sales
                </span>
              </div>
            ))}
          </div>
        )}

        {canManage && history.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-1">Recent shifts</p>
            {history.map((s) => (
              <div key={s.id} className="flex justify-between border-b border-border/20 py-1 text-xs" data-testid={`row-shift-${s.id}`}>
                <span>{s.characterName ?? "—"}</span>
                <span className="text-muted-foreground">
                  {new Date(s.clockInAt).toLocaleString()} → {s.clockOutAt ? new Date(s.clockOutAt).toLocaleTimeString() : "—"} ·{" "}
                  {formatEddies(s.earnedTotal)} · {s.salesCount} sales
                </span>
              </div>
            ))}
            {report?.totals && (
              <p className="text-xs text-muted-foreground mt-2" data-testid="text-shift-totals">
                Total wages paid: {formatEddies(report.totals.wagesPaid ?? 0)} across {report.totals.sales ?? 0} sales
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

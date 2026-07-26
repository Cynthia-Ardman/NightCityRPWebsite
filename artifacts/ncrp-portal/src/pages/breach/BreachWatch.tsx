import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetBreachPuzzle,
  getGetBreachPuzzleQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { containsContiguous, type Pos } from "./BreachBoard";
import { statusBadge, difficultyBadge } from "./breachUtils";
import { Cpu, ArrowLeft, Timer, Zap, Radio } from "lucide-react";

// Staff-only, read-only live view of an assigned breach run. Polls the puzzle
// every 1.5s while the run is live; the player's picks stream in via the
// advisory progress endpoint. When the run ends the poll stops and the final
// outcome is shown. Never interactive — spectators cannot influence the run.
const POLL_MS = 1500;

export default function BreachWatch() {
  const { id } = useParams();
  const puzzleId = Number(id);

  const [now, setNow] = useState(() => Date.now());

  const { data: puzzle, isLoading, error, refetch } = useGetBreachPuzzle(puzzleId, {
    query: {
      queryKey: getGetBreachPuzzleQueryKey(puzzleId),
      // Poll only while the run is not completed; a finished puzzle is static.
      refetchInterval: (query) => (query.state.data?.completedAt ? false : POLL_MS),
    },
  });

  // 1s ticker for the countdown display (independent of the data poll).
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  const grid = (puzzle?.grid ?? []) as string[][];
  const daemons = (puzzle?.daemons ?? []) as string[][];
  const selection = (puzzle?.selection ?? []) as Pos[];
  const bufferSize = puzzle?.bufferSize ?? 0;
  const cols = grid[0]?.length ?? 0;

  const cellSizeClass =
    cols >= 7
      ? "h-9 w-9 sm:h-11 sm:w-11 text-sm sm:text-base"
      : cols === 6
        ? "h-10 w-10 sm:h-12 sm:w-12 text-base sm:text-lg"
        : "h-12 w-12 sm:h-14 sm:w-14 text-lg";

  // Which daemons the current (live or final) selection breaches — the same
  // rule the player's board and the server scorer use.
  const solvedSet = useMemo(() => {
    const seq = selection.map((p) => grid[p.r]?.[p.c]).filter(Boolean) as string[];
    const set = new Set<number>();
    daemons.forEach((d, idx) => {
      if (containsContiguous(seq, d)) set.add(idx);
    });
    return set;
  }, [selection, grid, daemons]);

  const completed = !!puzzle?.completedAt;
  const startedAtMs = puzzle?.startedAt ? new Date(puzzle.startedAt).getTime() : null;
  const timeRemaining =
    puzzle && startedAtMs != null && !completed
      ? Math.max(0, puzzle.timeLimitSeconds - Math.floor((now - startedAtMs) / 1000))
      : null;
  const isLive = !!puzzle && !completed && startedAtMs != null && (timeRemaining ?? 0) > 0;

  if (isLoading) {
    return <div className="py-24 text-center text-nc-cyan animate-pulse font-display text-2xl">ESTABLISHING UPLINK...</div>;
  }
  if (error || !puzzle) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center space-y-4">
        <div className="font-display text-2xl text-destructive">SIGNAL LOST</div>
        <p className="font-mono text-sm text-muted-foreground">This puzzle could not be loaded.</p>
        <Link href="/breach"><Button variant="outline" className="rounded-none font-display">← BREACH CONTROL</Button></Link>
      </div>
    );
  }

  const notStarted = !puzzle.startedAt;
  const timedOut = !completed && startedAtMs != null && (timeRemaining ?? 0) <= 0;

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-6" data-testid="breach-watch">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
            <Cpu className="w-8 h-8 text-nc-magenta" /> SPECTATE
          </h1>
          {difficultyBadge(puzzle.difficulty)}
          {statusBadge(puzzle.status)}
          {isLive && (
            <Badge className="rounded-none bg-nc-green text-background font-mono animate-pulse" data-testid="badge-live">
              <Radio className="w-3 h-3 mr-1" /> LIVE
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 font-mono text-lg">
          <Timer className="w-5 h-5 text-nc-yellow" />
          <span
            className={timeRemaining !== null && timeRemaining <= 10 ? "text-destructive" : "text-nc-yellow"}
            data-testid="watch-timer"
          >
            {completed
              ? puzzle.timeTakenSeconds != null
                ? `${puzzle.timeTakenSeconds}s taken`
                : "—"
              : timeRemaining !== null
                ? `${timeRemaining}s`
                : `${puzzle.timeLimitSeconds}s`}
          </span>
        </div>
      </div>

      <p className="font-mono text-sm text-muted-foreground">
        Watching <span className="text-nc-cyan">{puzzle.assignedCharacterName ?? puzzle.assignedUserName ?? "player"}</span>
        {puzzle.contextLabel ? <> · {puzzle.contextLabel}</> : null} — read-only; picks appear as they're made.
      </p>

      {notStarted && (
        <div className="border border-nc-cyan/40 bg-nc-cyan/5 px-4 py-3 font-mono text-sm text-nc-cyan" data-testid="watch-not-started">
          The player hasn't jacked in yet. This view goes live the moment they open the puzzle.
        </div>
      )}
      {timedOut && (
        <div className="border border-destructive/50 bg-destructive/10 px-4 py-3 font-mono text-sm text-destructive">
          TIME UP — waiting for the final submission to be recorded...
        </div>
      )}
      {completed && (
        <div
          className={`border px-4 py-3 font-mono text-sm ${puzzle.status === "success" ? "border-nc-green/50 bg-nc-green/10 text-nc-green" : "border-destructive/50 bg-destructive/10 text-destructive"}`}
          data-testid="watch-outcome"
        >
          {puzzle.status === "success"
            ? "BREACH SUCCESSFUL"
            : puzzle.status === "expired"
              ? "TRACE COMPLETE — TIME UP"
              : puzzle.status === "partial"
                ? `PARTIAL BREACH — ${puzzle.solvedCount}/${daemons.length} DAEMONS`
                : "BREACH FAILED"}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
        {/* Code matrix (read-only) */}
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-cyan">CODE MATRIX</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="inline-grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {grid.map((row, r) =>
                row.map((val, c) => {
                  const selIndex = selection.findIndex((p) => p.r === r && p.c === c);
                  const isSelected = selIndex >= 0;
                  return (
                    <div
                      key={`${r}-${c}`}
                      data-testid={`watch-cell-${r}-${c}`}
                      className={[
                        "relative flex items-center justify-center font-mono border",
                        cellSizeClass,
                        isSelected
                          ? "border-nc-magenta bg-nc-magenta/20 text-nc-magenta"
                          : "border-border/40 text-muted-foreground",
                      ].join(" ")}
                    >
                      {val}
                      {isSelected && (
                        <span className="absolute top-0 left-0.5 text-[9px] text-nc-magenta/80">{selIndex + 1}</span>
                      )}
                    </div>
                  );
                }),
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Buffer */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="font-display tracking-widest text-nc-yellow text-sm flex items-center gap-2">
                <Zap className="w-4 h-4" /> BUFFER ({selection.length}/{bufferSize})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: bufferSize }).map((_, i) => {
                  const p = selection[i];
                  return (
                    <div
                      key={i}
                      className={`h-9 w-9 flex items-center justify-center font-mono text-sm border ${p ? "border-nc-magenta bg-nc-magenta/15 text-nc-magenta" : "border-border/40 text-muted-foreground"}`}
                    >
                      {p ? grid[p.r]?.[p.c] : ""}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Daemons */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader className="pb-3">
              <CardTitle className="font-display tracking-widest text-nc-cyan text-sm">
                DAEMONS ({solvedSet.size}/{daemons.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {daemons.map((d, idx) => {
                const done = solvedSet.has(idx);
                return (
                  <div key={idx} className="flex items-center gap-2" data-testid={`watch-daemon-${idx}`}>
                    <div className="flex gap-1">
                      {d.map((v, j) => (
                        <span
                          key={j}
                          className={`h-7 w-7 flex items-center justify-center font-mono text-xs border ${done ? "border-nc-green bg-nc-green/15 text-nc-green" : "border-border/40 text-muted-foreground"}`}
                        >
                          {v}
                        </span>
                      ))}
                    </div>
                    {done && <span className="font-mono text-[10px] text-nc-green">INSTALLED</span>}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Link href="/breach">
          <Button variant="outline" className="rounded-none font-display" data-testid="button-back-control">
            <ArrowLeft className="w-4 h-4 mr-1" /> BREACH CONTROL
          </Button>
        </Link>
        {!completed && (
          <Button
            variant="outline"
            className="rounded-none font-mono"
            onClick={() => refetch()}
            data-testid="button-refresh-watch"
          >
            REFRESH NOW
          </Button>
        )}
      </div>
    </div>
  );
}

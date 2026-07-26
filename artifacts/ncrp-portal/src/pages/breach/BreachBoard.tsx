import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Timer, Zap } from "lucide-react";

export type Pos = { r: number; c: number };
export type BreachOutcome = { success: boolean; solvedCount: number; expired: boolean };

// Does `seq` contain `daemon` as a contiguous run? (Mirrors the server's
// scoreSelection rule so the UI gives identical live feedback.) Exported so
// the staff Watch view computes identical daemon-progress from live picks.
export function containsContiguous(seq: string[], daemon: string[]): boolean {
  if (daemon.length === 0) return false;
  for (let i = 0; i <= seq.length - daemon.length; i++) {
    let ok = true;
    for (let j = 0; j < daemon.length; j++) {
      if (seq[i + j] !== daemon[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function generateSuccessLog(daemonCount: number): string[] {
  const lines = [
    "//INITIATE_BREACH_SEQUENCE",
    "//NEURAL_INTERFACE_ESTABLISHED",
    "//PINGING_TARGET_NODE...................SUCCESS",
    "//FIREWALL_HANDSHAKE_INITIATED..........ACCEPTED",
    "//AUTHENTICATING_ACCESS_PROTOCOLS.......COMPLETE",
    "",
    "//ACCESS_LEVEL: ROOT GRANTED",
    "//INJECTING_PAYLOAD",
  ];
  for (let i = 1; i <= daemonCount; i++) lines.push(`//UPLOADING_DAEMON_[${i}]..................SUCCESS`);
  lines.push("", "//FINALIZING_CONNECTION.................SECURE", "", `[${daemonCount}/${daemonCount}] DAEMONS UPLOADED`, "BREACH PROTOCOL SUCCESSFUL – ACCESS GRANTED");
  return lines;
}

function generateFailureLog(solved: number, total: number): string[] {
  const lines = [
    "//INITIATE_BREACH_SEQUENCE",
    "//NEURAL_INTERFACE_ESTABLISHED",
    "//AUTHENTICATING_ACCESS_PROTOCOLS.......COMPLETE",
    "",
    "//ACCESS_LEVEL: LIMITED",
    "//INJECTING_PAYLOAD",
  ];
  for (let i = 1; i <= solved; i++) lines.push(`//UPLOADING_DAEMON_[${i}]..................SUCCESS`);
  for (let i = solved + 1; i <= total; i++) lines.push(`//UPLOADING_DAEMON_[${i}]..................FAILED`);
  lines.push("", "//SECURITY_ALERT: TRACE INITIATED", "//CONNECTION TERMINATED – INCOMPLETE UPLOAD", "", `[${solved}/${total}] DAEMONS UPLOADED`, "BREACH PROTOCOL FAILED");
  return lines;
}

export interface BreachBoardProps {
  grid: string[][];
  daemons: string[][];
  bufferSize: number;
  timeLimitSeconds: number;
  // Epoch ms when the timer started; null => not started (display full time, no
  // countdown). The server play screen passes the persisted startedAt; practice
  // passes Date.now() when the puzzle begins.
  startAt: number | null;
  // Fired exactly once when play ends (all daemons breached, buffer full, or
  // time up). The parent decides what to do with the final selection (e.g.
  // submit to the server, or nothing for practice).
  onFinish?: (selection: Pos[], outcome: BreachOutcome) => void;
  // Fired after every cell pick with the selection-so-far. Used to stream
  // progress to the server for live spectating; must never block play.
  onSelectionChange?: (selection: Pos[]) => void;
  // Read-only completed view (history / resuming a finished puzzle). When set
  // with initialSelection the board renders the ended overlay immediately.
  readOnly?: boolean;
  initialSelection?: Pos[];
  // Override the overlay outcome (server-authoritative / stored status). When
  // omitted the board computes the outcome locally from the final selection.
  outcomeOverride?: BreachOutcome | null;
  // Left side of the header row (title + badges). The timer renders at right.
  heading?: React.ReactNode;
  // Slot rendered inside the result overlay (reward banner, nav buttons).
  resultFooter?: React.ReactNode;
}

export default function BreachBoard({
  grid,
  daemons,
  bufferSize,
  timeLimitSeconds,
  startAt,
  onFinish,
  onSelectionChange,
  readOnly = false,
  initialSelection,
  outcomeOverride = null,
  heading,
  resultFooter,
}: BreachBoardProps) {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  // The harder tiers use bigger boards (6x6 / 7x7); shrink the cells so the
  // matrix still fits without horizontal scroll on smaller viewports.
  const cellSizeClass =
    cols >= 7
      ? "h-9 w-9 sm:h-11 sm:w-11 text-sm sm:text-base"
      : cols === 6
        ? "h-10 w-10 sm:h-12 sm:w-12 text-base sm:text-lg"
        : "h-12 w-12 sm:h-14 sm:w-14 text-lg";

  const [selection, setSelection] = useState<Pos[]>(initialSelection ?? []);
  const [ended, setEnded] = useState(readOnly);
  const [localOutcome, setLocalOutcome] = useState<BreachOutcome | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ msg: string; type?: "error" | "success" }>({ msg: "" });
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const finishedRef = useRef(false);

  // The outcome shown in the overlay: a server/stored override wins, otherwise
  // the locally-computed result captured at finish time.
  const shownOutcome = outcomeOverride ?? localOutcome;

  // Which daemons are breached by the current selection (live feedback).
  const solvedSet = useMemo(() => {
    const seq = selection.map((p) => grid[p.r]?.[p.c]).filter(Boolean) as string[];
    const set = new Set<number>();
    daemons.forEach((d, idx) => {
      if (containsContiguous(seq, d)) set.add(idx);
    });
    return set;
  }, [selection, grid, daemons]);

  const finish = useCallback(
    (finalSel: Pos[], expired: boolean) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      const seq = finalSel.map((p) => grid[p.r]?.[p.c]).filter(Boolean) as string[];
      const solved = daemons.reduce((n, d) => (containsContiguous(seq, d) ? n + 1 : n), 0);
      const success = daemons.length > 0 && solved === daemons.length;
      const outcome: BreachOutcome = { success, solvedCount: solved, expired: expired && !success };
      setLocalOutcome(outcome);
      setEnded(true);
      onFinish?.(finalSel, outcome);
    },
    [grid, daemons, onFinish],
  );

  // Server/local-authoritative timer: anchor on startAt once play begins.
  useEffect(() => {
    if (readOnly || startAt == null || ended) return;
    const tick = () => {
      const remaining = Math.max(0, timeLimitSeconds - Math.floor((Date.now() - startAt) / 1000));
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        setFeedback({ msg: "TIME UP", type: "error" });
        setSelection((cur) => {
          finish(cur, true);
          return cur;
        });
      }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [readOnly, startAt, timeLimitSeconds, ended, finish]);

  // Build the flavour log once play ends (or for a read-only completed view).
  useEffect(() => {
    if (!ended || !shownOutcome) return;
    const total = daemons.length;
    const lines = shownOutcome.success
      ? generateSuccessLog(total)
      : generateFailureLog(shownOutcome.solvedCount, total);
    setLogLines([]);
    let i = 0;
    const h = setInterval(() => {
      setLogLines((l) => {
        if (i >= lines.length) {
          clearInterval(h);
          return l;
        }
        const line = lines[i];
        i += 1;
        return [...l, line];
      });
    }, 120);
    return () => clearInterval(h);
  }, [ended, shownOutcome, daemons.length]);

  const handleCellClick = useCallback(
    (r: number, c: number) => {
      if (ended || selection.length >= bufferSize) return;
      if (selection.some((p) => p.r === r && p.c === c)) {
        setFeedback({ msg: "Cell already selected.", type: "error" });
        return;
      }
      if (selection.length === 0) {
        if (r !== 0) {
          setFeedback({ msg: "First selection must be in the highlighted row.", type: "error" });
          return;
        }
      } else {
        const last = selection[selection.length - 1];
        const expectColumn = selection.length % 2 === 1;
        if (expectColumn && c !== last.c) {
          setFeedback({ msg: "Select a cell in the same column.", type: "error" });
          return;
        }
        if (!expectColumn && r !== last.r) {
          setFeedback({ msg: "Select a cell in the same row.", type: "error" });
          return;
        }
      }
      const next = [...selection, { r, c }];
      setSelection(next);
      setFeedback({ msg: "" });
      onSelectionChange?.(next);

      const seq = next.map((p) => grid[p.r][p.c]);
      const allSolved = daemons.length > 0 && daemons.every((d) => containsContiguous(seq, d));
      if (allSolved) {
        setFeedback({ msg: "ALL DAEMONS BREACHED", type: "success" });
        finish(next, false);
      } else if (next.length >= bufferSize) {
        finish(next, false);
      }
    },
    [ended, selection, bufferSize, grid, daemons, finish, onSelectionChange],
  );

  // Which row/column is "live" for the next pick (highlight legal cells).
  const nextConstraint = useMemo(() => {
    if (ended) return null;
    if (selection.length === 0) return { kind: "row" as const, value: 0 };
    const last = selection[selection.length - 1];
    return selection.length % 2 === 1
      ? { kind: "col" as const, value: last.c }
      : { kind: "row" as const, value: last.r };
  }, [selection, ended]);

  const total = daemons.length;
  const success = !!shownOutcome?.success;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">{heading}</div>
        <div className="flex items-center gap-2 font-mono text-lg">
          <Timer className="w-5 h-5 text-nc-yellow" />
          <span className={timeRemaining !== null && timeRemaining <= 10 ? "text-destructive" : "text-nc-yellow"}>
            {timeRemaining !== null ? `${timeRemaining}s` : `${timeLimitSeconds}s`}
          </span>
        </div>
      </div>

      {feedback.msg && (
        <div className={`border px-4 py-2 font-mono text-sm ${feedback.type === "success" ? "border-nc-green/50 bg-nc-green/10 text-nc-green" : "border-destructive/50 bg-destructive/10 text-destructive"}`}>
          {feedback.msg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
        {/* Code matrix */}
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-cyan">CODE MATRIX</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="inline-grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {grid.map((row, r) =>
                row.map((val, c) => {
                  const isSelected = selection.some((p) => p.r === r && p.c === c);
                  const selIndex = selection.findIndex((p) => p.r === r && p.c === c);
                  const isLegal =
                    !ended &&
                    !isSelected &&
                    ((nextConstraint?.kind === "row" && nextConstraint.value === r) ||
                      (nextConstraint?.kind === "col" && nextConstraint.value === c));
                  return (
                    <button
                      key={`${r}-${c}`}
                      onClick={() => handleCellClick(r, c)}
                      disabled={ended}
                      data-testid={`cell-${r}-${c}`}
                      className={[
                        "relative font-mono border transition-colors",
                        cellSizeClass,
                        isSelected
                          ? "border-nc-magenta bg-nc-magenta/20 text-nc-magenta"
                          : isLegal
                            ? "border-nc-cyan bg-nc-cyan/10 text-nc-cyan hover:bg-nc-cyan/25 cursor-pointer"
                            : "border-border/40 text-muted-foreground hover:border-nc-cyan/40",
                      ].join(" ")}
                    >
                      {val}
                      {isSelected && (
                        <span className="absolute top-0 left-0.5 text-[9px] text-nc-magenta/80">{selIndex + 1}</span>
                      )}
                    </button>
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
                      {p ? grid[p.r][p.c] : ""}
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
                DAEMONS ({solvedSet.size}/{total})
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {daemons.map((d, idx) => {
                const done = solvedSet.has(idx);
                return (
                  <div key={idx} className="flex items-center gap-2" data-testid={`daemon-${idx}`}>
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

      {/* Result overlay */}
      {ended && shownOutcome && (
        <Card className={`rounded-none ${success ? "border-nc-green/60" : "border-destructive/60"} bg-card`}>
          <CardHeader>
            <CardTitle className={`font-display tracking-widest ${success ? "text-nc-green" : "text-destructive"}`}>
              {success ? "BREACH SUCCESSFUL" : shownOutcome.expired ? "TRACE COMPLETE — TIME UP" : "BREACH FAILED"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="font-mono text-xs text-nc-green/90 bg-background/60 border border-border/40 p-4 overflow-x-auto whitespace-pre-wrap min-h-[120px]">
              {logLines.join("\n")}
            </pre>
            {resultFooter}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

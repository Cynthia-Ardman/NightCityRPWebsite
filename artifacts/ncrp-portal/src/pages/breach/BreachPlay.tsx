import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBreachPuzzle,
  useStartBreachPuzzle,
  useSubmitBreachResult,
  getGetBreachPuzzleQueryKey,
  getListMyBreachPuzzlesQueryKey,
  getGetMyWalletQueryKey,
  type BreachPos,
  type BreachResult,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { difficultyBadge } from "./breachUtils";
import { Cpu, Timer, Zap, ArrowLeft } from "lucide-react";

// Does `seq` contain `daemon` as a contiguous run? (Mirrors the server's
// scoreSelection rule so the UI gives identical live feedback.)
function containsContiguous(seq: string[], daemon: string[]): boolean {
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

export default function BreachPlay() {
  const { id } = useParams();
  const puzzleId = Number(id);
  const qc = useQueryClient();
  const { data: puzzle, isLoading, error } = useGetBreachPuzzle(puzzleId);

  const startMut = useStartBreachPuzzle();
  const submitMut = useSubmitBreachResult();

  const grid = (puzzle?.grid ?? []) as string[][];
  const daemons = (puzzle?.daemons ?? []) as string[][];
  const bufferSize = puzzle?.bufferSize ?? 0;
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;

  const [selection, setSelection] = useState<BreachPos[]>([]);
  const [ended, setEnded] = useState(false);
  const [result, setResult] = useState<BreachResult | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [feedback, setFeedback] = useState<{ msg: string; type?: "error" | "success" }>({ msg: "" });
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const startedRef = useRef(false);

  // The puzzle is already done (history / refresh) → lock into a read-only
  // completed view using the stored selection + status.
  const alreadyDone = !!puzzle && !!puzzle.completedAt;

  useEffect(() => {
    if (alreadyDone && puzzle) {
      setEnded(true);
      setSelection((puzzle.selection ?? []) as BreachPos[]);
    }
  }, [alreadyDone, puzzle]);

  // Which daemons are breached by the current selection (live feedback).
  const solvedSet = useMemo(() => {
    const seq = selection.map((p) => grid[p.r]?.[p.c]).filter(Boolean) as string[];
    const set = new Set<number>();
    daemons.forEach((d, idx) => {
      if (containsContiguous(seq, d)) set.add(idx);
    });
    return set;
  }, [selection, grid, daemons]);

  // Start the server-authoritative timer as soon as the player opens the play
  // screen (idempotent server-side). Doing this on mount — rather than on the
  // first cell click — guarantees startedAt is persisted before any submit, so
  // the time limit is always enforced and there's no start/submit race.
  useEffect(() => {
    if (!puzzle || puzzle.completedAt || puzzle.startedAt || startedRef.current) return;
    startedRef.current = true;
    startMut
      .mutateAsync({ id: puzzleId })
      .then(() => qc.invalidateQueries({ queryKey: getGetBreachPuzzleQueryKey(puzzleId) }))
      .catch(() => {
        startedRef.current = false;
      });
  }, [puzzle, puzzleId, startMut, qc]);

  const finish = useCallback(
    async (finalSel: BreachPos[]) => {
      if (ended) return;
      setEnded(true);
      try {
        const res = await submitMut.mutateAsync({ id: puzzleId, data: { selection: finalSel } });
        setResult(res);
        qc.invalidateQueries({ queryKey: getGetBreachPuzzleQueryKey(puzzleId) });
        qc.invalidateQueries({ queryKey: getListMyBreachPuzzlesQueryKey() });
        if (res.rewardPaid) qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
      } catch {
        setFeedback({ msg: "Failed to submit result — connection lost.", type: "error" });
      }
    },
    [ended, puzzleId, submitMut, qc],
  );

  // Server-authoritative timer: anchor on startedAt once the player begins.
  useEffect(() => {
    if (!puzzle?.startedAt || ended) return;
    const start = new Date(puzzle.startedAt).getTime();
    const tick = () => {
      const remaining = Math.max(0, puzzle.timeLimitSeconds - Math.floor((Date.now() - start) / 1000));
      setTimeRemaining(remaining);
      if (remaining <= 0) {
        setFeedback({ msg: "TIME UP", type: "error" });
        finish(selection);
      }
    };
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [puzzle?.startedAt, puzzle?.timeLimitSeconds, ended, finish, selection]);

  // Build the flavour log once a result lands (or for an already-done puzzle).
  useEffect(() => {
    if (!ended || !puzzle) return;
    const success = result ? result.success : puzzle.status === "success";
    const solved = result ? result.solvedCount : puzzle.solvedCount;
    const total = daemons.length;
    const lines = success ? generateSuccessLog(total) : generateFailureLog(solved, total);
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
  }, [ended, result, puzzle, daemons.length]);

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

      const seq = next.map((p) => grid[p.r][p.c]);
      const allSolved = daemons.length > 0 && daemons.every((d) => containsContiguous(seq, d));
      if (allSolved) {
        setFeedback({ msg: "ALL DAEMONS BREACHED", type: "success" });
        finish(next);
      } else if (next.length >= bufferSize) {
        finish(next);
      }
    },
    [ended, selection, bufferSize, grid, daemons, finish],
  );

  // Which column is "live" for the next pick (highlight legal cells).
  const nextConstraint = useMemo(() => {
    if (ended) return null;
    if (selection.length === 0) return { kind: "row" as const, value: 0 };
    const last = selection[selection.length - 1];
    return selection.length % 2 === 1
      ? { kind: "col" as const, value: last.c }
      : { kind: "row" as const, value: last.r };
  }, [selection, ended]);

  if (isLoading) {
    return <div className="py-24 text-center text-nc-cyan animate-pulse font-display text-2xl">JACKING IN...</div>;
  }
  if (error || !puzzle) {
    return (
      <div className="max-w-2xl mx-auto py-24 text-center space-y-4">
        <div className="font-display text-2xl text-destructive">ACCESS DENIED</div>
        <p className="font-mono text-sm text-muted-foreground">This puzzle could not be loaded — it may not exist or isn't assigned to you.</p>
        <Link href="/breach/mine"><Button variant="outline" className="rounded-none font-display">← BACK TO MY BREACHES</Button></Link>
      </div>
    );
  }

  const total = daemons.length;
  const success = result ? result.success : puzzle.status === "success";

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
          <Cpu className="w-8 h-8 text-nc-magenta" /> BREACH PROTOCOL
        </h1>
        <div className="flex items-center gap-3">
          {difficultyBadge(puzzle.difficulty)}
          <div className="flex items-center gap-2 font-mono text-lg">
            <Timer className="w-5 h-5 text-nc-yellow" />
            <span className={timeRemaining !== null && timeRemaining <= 10 ? "text-destructive" : "text-nc-yellow"}>
              {timeRemaining !== null ? `${timeRemaining}s` : `${puzzle.timeLimitSeconds}s`}
            </span>
          </div>
        </div>
      </div>

      {puzzle.assignedCharacterName && (
        <p className="font-mono text-sm text-muted-foreground">
          Running as <span className="text-nc-cyan">{puzzle.assignedCharacterName}</span>. Breach all daemons before the buffer fills or the timer runs out.
        </p>
      )}

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
                        "relative h-12 w-12 sm:h-14 sm:w-14 font-mono text-lg border transition-colors",
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
      {ended && (
        <Card className={`rounded-none ${success ? "border-nc-green/60" : "border-destructive/60"} bg-card`}>
          <CardHeader>
            <CardTitle className={`font-display tracking-widest ${success ? "text-nc-green" : "text-destructive"}`}>
              {success ? "BREACH SUCCESSFUL" : puzzle.status === "expired" ? "TRACE COMPLETE — TIME UP" : "BREACH FAILED"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <pre className="font-mono text-xs text-nc-green/90 bg-background/60 border border-border/40 p-4 overflow-x-auto whitespace-pre-wrap min-h-[120px]">
              {logLines.join("\n")}
            </pre>
            {success && result?.rewardPaid && (
              <div className="font-mono text-sm text-nc-yellow border border-nc-yellow/40 bg-nc-yellow/10 px-4 py-2">
                Reward delivered: {[
                  result.rewardEddies && result.rewardEddies > 0 ? `€$${result.rewardEddies.toLocaleString()}` : null,
                  result.rewardItemName,
                ].filter(Boolean).join(" + ")}
              </div>
            )}
            <Link href="/breach/mine">
              <Button variant="outline" className="rounded-none font-display">
                <ArrowLeft className="w-4 h-4 mr-1" /> MY BREACHES
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

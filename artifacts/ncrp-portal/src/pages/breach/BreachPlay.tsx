import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBreachPuzzle,
  useStartBreachPuzzle,
  useSubmitBreachResult,
  getGetBreachPuzzleQueryKey,
  getListMyBreachPuzzlesQueryKey,
  getGetMyWalletQueryKey,
  type BreachResult,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import BreachBoard, { type Pos, type BreachOutcome } from "./BreachBoard";
import { difficultyBadge } from "./breachUtils";
import { Cpu, ArrowLeft } from "lucide-react";

export default function BreachPlay() {
  const { id } = useParams();
  const puzzleId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: puzzle, isLoading, error } = useGetBreachPuzzle(puzzleId);

  const startMut = useStartBreachPuzzle();
  const submitMut = useSubmitBreachResult();

  const grid = (puzzle?.grid ?? []) as string[][];
  const daemons = (puzzle?.daemons ?? []) as string[][];
  const bufferSize = puzzle?.bufferSize ?? 0;

  const [result, setResult] = useState<BreachResult | null>(null);
  const startedRef = useRef(false);

  // The puzzle is already done (history / refresh) → render a read-only
  // completed view using the stored selection + status.
  const alreadyDone = !!puzzle && !!puzzle.completedAt;

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

  const handleFinish = async (finalSel: Pos[]) => {
    try {
      const res = await submitMut.mutateAsync({ id: puzzleId, data: { selection: finalSel } });
      setResult(res);
      qc.invalidateQueries({ queryKey: getGetBreachPuzzleQueryKey(puzzleId) });
      qc.invalidateQueries({ queryKey: getListMyBreachPuzzlesQueryKey() });
      if (res.rewardPaid) qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
    } catch (e) {
      // The board shows the locally-computed outcome, but the server did NOT
      // record this run — surface it so the player knows and can retry by
      // reloading. Reconciled authoritatively on the next load.
      toast({
        title: "Result not recorded",
        description: e instanceof Error ? e.message : "The server rejected this submission. Reload to retry.",
        variant: "destructive",
      });
    }
  };

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

  // The stored outcome for an already-completed puzzle (server-authoritative).
  const storedOutcome: BreachOutcome | null = alreadyDone
    ? {
        success: puzzle.status === "success",
        solvedCount: puzzle.solvedCount,
        expired: puzzle.status === "expired",
      }
    : null;

  // After a live submit, the server result is authoritative for the overlay.
  // Derive "expired" from the puzzle returned BY the submit (fresh status), not
  // the pre-submit query value which is still "sent".
  const liveOutcome: BreachOutcome | null = result
    ? { success: result.success, solvedCount: result.solvedCount, expired: result.puzzle.status === "expired" && !result.success }
    : null;

  const startAt = puzzle.startedAt ? new Date(puzzle.startedAt).getTime() : null;

  const heading = (
    <>
      <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
        <Cpu className="w-8 h-8 text-nc-magenta" /> BREACH PROTOCOL
      </h1>
      {difficultyBadge(puzzle.difficulty)}
    </>
  );

  const resultFooter = (
    <>
      {result?.rewardPaid && (
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
    </>
  );

  return (
    <div className="max-w-5xl mx-auto pb-12 space-y-6">
      {puzzle.contextLabel && (
        <p className="font-mono text-sm text-nc-cyan border border-nc-cyan/30 bg-nc-cyan/5 px-4 py-2">
          Context: {puzzle.contextLabel}
        </p>
      )}
      {puzzle.assignedCharacterName && (
        <p className="font-mono text-sm text-muted-foreground">
          Running as <span className="text-nc-cyan">{puzzle.assignedCharacterName}</span>. Breach all daemons before the buffer fills or the timer runs out.
        </p>
      )}

      <BreachBoard
        key={puzzleId}
        grid={grid}
        daemons={daemons}
        bufferSize={bufferSize}
        timeLimitSeconds={puzzle.timeLimitSeconds}
        startAt={startAt}
        readOnly={alreadyDone}
        initialSelection={(puzzle.selection ?? []) as Pos[]}
        outcomeOverride={liveOutcome ?? storedOutcome}
        onFinish={handleFinish}
        heading={heading}
        resultFooter={resultFooter}
      />
    </div>
  );
}

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateBreachPuzzle,
  usePreviewBreachPuzzle,
  useListBreachPuzzles,
  getListBreachPuzzlesQueryKey,
  type BreachPuzzleInputDifficulty,
  type BreachPreview,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import { useToast } from "@/hooks/use-toast";
import { statusBadge, difficultyBadge, rewardSummary } from "./breachUtils";
import { Cpu, Send, RefreshCw, Eye } from "lucide-react";

const DIFFICULTIES: BreachPuzzleInputDifficulty[] = ["easy", "medium", "hard", "impossible"];

export default function BreachHub() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [target, setTarget] = useState<CharacterPickerValue>(null);
  const [difficulty, setDifficulty] = useState<BreachPuzzleInputDifficulty>("medium");
  const [timeLimit, setTimeLimit] = useState<number>(60);
  const [rewardEddies, setRewardEddies] = useState<number>(0);
  const [rewardItemName, setRewardItemName] = useState<string>("");
  const [rewardItemCategory, setRewardItemCategory] = useState<string>("");
  const [rewardNote, setRewardNote] = useState<string>("");

  // The previewed (but not yet assigned) puzzle. Staff must preview before
  // sending so they can see a worked solution.
  const [preview, setPreview] = useState<BreachPreview | null>(null);

  // Poll the staff log so pass/fail status appears moments after a player
  // finishes, without a manual refresh.
  const { data: puzzles, isLoading: puzzlesLoading } = useListBreachPuzzles(undefined, {
    query: { queryKey: getListBreachPuzzlesQueryKey(), refetchInterval: 10_000 },
  });
  const previewMut = usePreviewBreachPuzzle();
  const createMut = useCreateBreachPuzzle();

  const errMsg = (e: unknown) =>
    (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? "Request failed";

  // Index map of solution path cells for highlighting in the preview grid.
  const solutionOrder = useMemo(() => {
    const m = new Map<string, number>();
    preview?.solutionPath.forEach((p, i) => m.set(`${p.r},${p.c}`, i + 1));
    return m;
  }, [preview]);

  const doPreview = async () => {
    try {
      const result = await previewMut.mutateAsync({ data: { difficulty } });
      setPreview(result);
    } catch (e) {
      toast({ title: "Failed to generate preview", description: errMsg(e), variant: "destructive" });
    }
  };

  const assign = async () => {
    if (!preview) return;
    if (!target) {
      toast({ title: "Pick a character", description: "Search for who receives this breach.", variant: "destructive" });
      return;
    }
    if (timeLimit < 10 || timeLimit > 600) {
      toast({ title: "Invalid time limit", description: "Time limit must be 10–600 seconds.", variant: "destructive" });
      return;
    }
    try {
      const puzzle = await createMut.mutateAsync({
        data: {
          assignedCharacterId: target.id,
          difficulty,
          timeLimitSeconds: timeLimit,
          rewardEddies: rewardEddies > 0 ? rewardEddies : undefined,
          rewardItemName: rewardItemName.trim() || undefined,
          rewardItemCategory: rewardItemCategory.trim() || undefined,
          rewardNote: rewardNote.trim() || undefined,
          puzzle: {
            grid: preview.grid,
            daemons: preview.daemons,
            bufferSize: preview.bufferSize,
          },
        },
      });
      qc.invalidateQueries({ queryKey: getListBreachPuzzlesQueryKey() });
      toast({
        title: "Breach sent",
        description: `Puzzle #${puzzle.id} sent to ${puzzle.assignedCharacterName ?? "player"}${puzzle.dmSentAt ? " — DM delivered." : " — DM could not be delivered."}`,
      });
      setPreview(null);
      setTarget(null);
      setRewardEddies(0);
      setRewardItemName("");
      setRewardItemCategory("");
      setRewardNote("");
    } catch (e) {
      toast({ title: "Failed to assign breach", description: errMsg(e), variant: "destructive" });
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto pb-12 space-y-8">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3">
          <Cpu className="w-8 h-8 text-nc-magenta" /> BREACH CONTROL
        </h1>
        <p className="font-mono text-sm text-muted-foreground mt-1">
          Generate a timed Breach Protocol puzzle, preview the solution, then send the play link to a character's player via Discord DM.
        </p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-8">
        {/* Create form */}
        <Card className="rounded-none border-border bg-card/50 h-fit">
          <CardHeader>
            <CardTitle className="font-display tracking-widest text-nc-cyan">NEW BREACH</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Target Character</Label>
              <CharacterPicker
                value={target}
                onChange={setTarget}
                scope="all"
                placeholder="Search by character or player name..."
                testId="picker-character"
              />
              <p className="font-mono text-[11px] text-muted-foreground">
                The play link is DM'd to the character's linked player.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Difficulty</Label>
                <Select
                  value={difficulty}
                  onValueChange={(v) => {
                    setDifficulty(v as BreachPuzzleInputDifficulty);
                    setPreview(null);
                  }}
                >
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-difficulty">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-none">
                    {DIFFICULTIES.map((d) => (
                      <SelectItem key={d} value={d} className="font-mono">{d.toUpperCase()}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Time Limit (s)</Label>
                <Input
                  type="number"
                  min={10}
                  max={600}
                  value={timeLimit}
                  onChange={(e) => setTimeLimit(Number(e.target.value))}
                  className="rounded-none font-mono"
                  data-testid="input-timelimit"
                />
              </div>
            </div>

            <div className="border-t border-border/40 pt-4 space-y-4">
              <p className="font-mono text-xs uppercase tracking-widest text-nc-yellow">Reward (optional)</p>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Eddies</Label>
                <Input
                  type="number"
                  min={0}
                  value={rewardEddies}
                  onChange={(e) => setRewardEddies(Number(e.target.value))}
                  className="rounded-none font-mono"
                  data-testid="input-reward-eddies"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Item Name</Label>
                  <Input
                    value={rewardItemName}
                    onChange={(e) => setRewardItemName(e.target.value)}
                    placeholder="e.g. Militech Datashard"
                    className="rounded-none font-mono"
                    data-testid="input-reward-item"
                  />
                </div>
                <div className="space-y-2">
                  <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Item Category</Label>
                  <Input
                    value={rewardItemCategory}
                    onChange={(e) => setRewardItemCategory(e.target.value)}
                    placeholder="e.g. gear"
                    className="rounded-none font-mono"
                    data-testid="input-reward-category"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Note</Label>
                <Textarea
                  value={rewardNote}
                  onChange={(e) => setRewardNote(e.target.value)}
                  placeholder="Flavour / context for the reward"
                  className="rounded-none font-mono"
                  data-testid="input-reward-note"
                />
              </div>
            </div>

            <div className="border-t border-border/40 pt-4 space-y-3">
              <Button
                onClick={doPreview}
                disabled={previewMut.isPending}
                variant="outline"
                className="w-full rounded-none font-display tracking-widest border-nc-cyan text-nc-cyan hover:bg-nc-cyan/10"
                data-testid="button-preview-breach"
              >
                <Eye className="w-4 h-4 mr-2" />
                {previewMut.isPending ? "GENERATING..." : preview ? "REGENERATE PREVIEW" : "GENERATE & PREVIEW"}
              </Button>
              <Button
                onClick={assign}
                disabled={!preview || createMut.isPending}
                className="w-full rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80 disabled:opacity-40"
                data-testid="button-send-breach"
              >
                <Send className="w-4 h-4 mr-2" />
                {createMut.isPending ? "SENDING..." : "ASSIGN & SEND"}
              </Button>
              {!preview && (
                <p className="font-mono text-xs text-muted-foreground text-center">
                  Generate a preview to review the solution before assigning.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-8">
          {/* Preview panel */}
          {preview && (
            <Card className="rounded-none border-nc-cyan/50 bg-card/50">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="font-display tracking-widest text-nc-cyan">SOLUTION PREVIEW</CardTitle>
                <div className="flex items-center gap-3 font-mono text-xs text-muted-foreground">
                  {difficultyBadge(preview.difficulty)}
                  <span>BUFFER {preview.bufferSize}</span>
                  <span>{preview.solutionCount} SOLUTION{preview.solutionCount === 1 ? "" : "S"}</span>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex flex-wrap gap-8">
                  {/* Code matrix with the solution path highlighted */}
                  <div>
                    <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-2">Code Matrix</p>
                    <div className="inline-block border border-border/40 p-2 bg-background/40">
                      {preview.grid.map((row, r) => (
                        <div key={r} className="flex">
                          {row.map((cell, c) => {
                            const order = solutionOrder.get(`${r},${c}`);
                            return (
                              <div
                                key={c}
                                className={`relative w-10 h-10 flex items-center justify-center font-mono text-sm border ${
                                  order
                                    ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10 font-bold"
                                    : "border-border/20 text-muted-foreground"
                                }`}
                                data-testid={`preview-cell-${r}-${c}`}
                              >
                                {cell}
                                {order && (
                                  <span className="absolute -top-1.5 -left-1.5 text-[9px] text-nc-magenta font-bold">
                                    {order}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Daemons + solution sequence */}
                  <div className="space-y-4">
                    <div>
                      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-2">Daemons</p>
                      <div className="space-y-1">
                        {preview.daemons.map((d, i) => (
                          <div key={i} className="font-mono text-sm text-nc-yellow">
                            {d.join(" ")}
                          </div>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-2">Solution Path</p>
                      {preview.solutionPath.length > 0 ? (
                        <div className="font-mono text-sm text-nc-cyan">
                          {preview.solutionPath.map((p) => preview.grid[p.r][p.c]).join(" → ")}
                        </div>
                      ) : (
                        <div className="font-mono text-sm text-destructive">No solution exists (unsolvable).</div>
                      )}
                    </div>
                  </div>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  This exact grid will be assigned. Use REGENERATE PREVIEW for a different one.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Puzzle log */}
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="font-display tracking-widest text-nc-cyan">BREACH LOG</CardTitle>
              <Button
                variant="outline"
                size="sm"
                className="rounded-none font-mono"
                onClick={() => qc.invalidateQueries({ queryKey: getListBreachPuzzlesQueryKey() })}
              >
                <RefreshCw className="w-3 h-3 mr-1" /> REFRESH
              </Button>
            </CardHeader>
            <CardContent>
              {puzzlesLoading ? (
                <div className="py-8 text-center font-mono text-muted-foreground animate-pulse">Loading...</div>
              ) : !puzzles || puzzles.length === 0 ? (
                <div className="py-8 text-center font-mono text-muted-foreground italic">No breaches sent yet.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="font-mono text-xs uppercase tracking-widest text-muted-foreground border-b border-border/40">
                        <th className="text-left py-2 pr-4">#</th>
                        <th className="text-left py-2 pr-4">Target</th>
                        <th className="text-left py-2 pr-4">Diff</th>
                        <th className="text-left py-2 pr-4">Status</th>
                        <th className="text-left py-2 pr-4">Reward</th>
                        <th className="text-left py-2 pr-4">Sent</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      {puzzles.map((p) => (
                        <tr key={p.id} className="border-b border-border/20" data-testid={`puzzle-row-${p.id}`}>
                          <td className="py-2 pr-4 text-muted-foreground">{p.id}</td>
                          <td className="py-2 pr-4">
                            <div className="text-foreground">{p.assignedCharacterName ?? "—"}</div>
                            <div className="text-xs text-muted-foreground">{p.assignedUserName ?? p.assignedUserId}</div>
                          </td>
                          <td className="py-2 pr-4">{difficultyBadge(p.difficulty)}</td>
                          <td className="py-2 pr-4">
                            {statusBadge(p.status)}
                            {(p.status === "success" || p.status === "failed") && (
                              <span className="ml-2 text-xs text-muted-foreground">{p.solvedCount}/{p.daemons.length}</span>
                            )}
                          </td>
                          <td className="py-2 pr-4 text-nc-yellow">
                            {rewardSummary(p)}
                            {p.rewardPaidAt && <span className="ml-1 text-nc-green text-xs">✓paid</span>}
                          </td>
                          <td className="py-2 pr-4 text-xs text-muted-foreground">
                            {new Date(p.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="font-mono text-xs text-muted-foreground">
        Players see their assigned breaches under{" "}
        <Link href="/breach/mine" className="text-nc-cyan underline">My Breaches</Link>.
      </p>
    </div>
  );
}

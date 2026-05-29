import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useRollDice, useGetDiceHistory, getGetDiceHistoryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dice5, History, Zap, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const diceSchema = z.object({
  expression: z.string().min(1, "Expression required").max(64),
  label: z.string().optional(),
});

// Pure dice-rolling helper used for client-side unit tests. The portal itself
// dispatches rolls through the API for auditability — this helper mirrors the
// classic NdM(+K) expression grammar and is intentionally side-effect free so
// the test suite can pin down its math with a deterministic RNG.
//
// Supported grammar (whitespace ignored):
//   NdM           — roll N M-sided dice (N defaults to 1)
//   NdM+K / NdM-K — same, plus a flat modifier
//
// Invalid expressions throw. Counts/sides are bounded to keep the helper
// well-defined (matches the server limits in api-server/src/lib/dice.ts).
export interface ClientRollResult {
  expression: string;
  rolls: number[];
  modifier: number;
  total: number;
}

const SIMPLE_DICE_RE = /^(\d+)?d(\d+)(?:\s*([+-])\s*(\d+))?$/i;

export function rollExpression(
  expression: string,
  rng: () => number = Math.random,
): ClientRollResult {
  const m = expression.replace(/\s+/g, "").match(SIMPLE_DICE_RE);
  if (!m) throw new Error("Invalid expression");
  const count = m[1] ? parseInt(m[1], 10) : 1;
  const sides = parseInt(m[2], 10);
  if (!Number.isFinite(count) || !Number.isFinite(sides)) {
    throw new Error("Invalid expression");
  }
  if (count < 1 || count > 100 || sides < 2 || sides > 1000) {
    throw new Error("Dice out of bounds");
  }
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng();
    if (!(r >= 0 && r < 1)) throw new Error("rng() must return [0, 1)");
    rolls.push(1 + Math.floor(r * sides));
  }
  const modifier = m[4] ? parseInt(m[4], 10) * (m[3] === "-" ? -1 : 1) : 0;
  const total = rolls.reduce((s, n) => s + n, 0) + modifier;
  return { expression, rolls, modifier, total };
}

export default function DiceRoller() {
  const { data: history, isLoading } = useGetDiceHistory();
  const rollDice = useRollDice();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const form = useForm<z.infer<typeof diceSchema>>({
    resolver: zodResolver(diceSchema),
    defaultValues: {
      expression: "1d20+5",
      label: "",
    },
  });

  const onSubmit = (values: z.infer<typeof diceSchema>) => {
    rollDice.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetDiceHistoryQueryKey() });
        // Don't toast success, it shows visually in history immediately
      },
      onError: (err: any) => {
        toast({ title: "Roll Failed", description: err.message || "Invalid dice expression.", variant: "destructive" });
      }
    });
  };

  const quickRoll = (expr: string, label: string) => {
    form.setValue("expression", expr);
    form.setValue("label", label);
    form.handleSubmit(onSubmit)();
  };

  return (
    <div className="space-y-8 max-w-4xl mx-auto pb-12">
      <div>
        <h1 className="text-4xl font-display font-bold text-foreground flex items-center gap-3" data-testid="text-dice-title">
          <Dice5 className="w-8 h-8 text-nc-magenta" /> 
          DICE_ALGORITHM
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Cryptographically secure RNG for resolving actions.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-1 space-y-6">
          <Card className="rounded-none border-nc-magenta/30 bg-card/50 shadow-[0_0_20px_rgba(255,0,255,0.05)]">
            <CardHeader>
              <CardTitle className="font-display text-nc-magenta">EXECUTE_ROLL</CardTitle>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 font-mono">
                  <FormField
                    control={form.control}
                    name="expression"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Expression</FormLabel>
                        <FormControl>
                          <Input className="rounded-none border-border bg-background focus-visible:ring-nc-magenta font-mono text-lg" placeholder="1d20+5" {...field} data-testid="input-dice-expr" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="label"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Reason (Optional)</FormLabel>
                        <FormControl>
                          <Input className="rounded-none border-border bg-background focus-visible:ring-nc-magenta" placeholder="Persuasion check..." {...field} data-testid="input-dice-label" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={rollDice.isPending} className="w-full rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display text-lg tracking-widest mt-2 h-12" data-testid="button-submit-roll">
                    {rollDice.isPending ? "COMPUTING..." : "ROLL"}
                  </Button>
                </form>
              </Form>

              <div className="mt-8">
                <h4 className="font-display text-sm text-muted-foreground mb-3 uppercase tracking-widest border-b border-border/50 pb-1">Quick Macros</h4>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => quickRoll("1d10", "Stat Check")} className="rounded-none border-border text-foreground hover:border-nc-magenta hover:text-nc-magenta font-mono" data-testid="btn-quick-1d10">1d10</Button>
                  <Button variant="outline" size="sm" onClick={() => quickRoll("1d100", "Critical Injury")} className="rounded-none border-border text-foreground hover:border-nc-magenta hover:text-nc-magenta font-mono" data-testid="btn-quick-1d100">1d100</Button>
                  <Button variant="outline" size="sm" onClick={() => quickRoll("2d6", "Damage")} className="rounded-none border-border text-foreground hover:border-nc-magenta hover:text-nc-magenta font-mono" data-testid="btn-quick-2d6">2d6</Button>
                  <Button variant="outline" size="sm" onClick={() => quickRoll("4d6", "Heavy Damage")} className="rounded-none border-border text-foreground hover:border-nc-magenta hover:text-nc-magenta font-mono" data-testid="btn-quick-4d6">4d6</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <History className="w-5 h-5 text-nc-cyan" />
            <h2 className="text-xl font-display font-bold text-foreground">ROLL_HISTORY</h2>
          </div>

          <div className="space-y-4">
            {isLoading ? (
              <div className="text-nc-cyan font-mono animate-pulse">Loading archive...</div>
            ) : history?.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground font-mono border border-dashed border-border bg-card/30">
                NO_RECORDS_FOUND
              </div>
            ) : (
              history?.map((roll) => (
                <Card key={roll.id} className="rounded-none border-border bg-card/50 overflow-hidden" data-testid={`card-roll-${roll.id}`}>
                  <div className="flex flex-col sm:flex-row">
                    <div className="bg-muted/30 p-4 sm:w-1/3 flex flex-col justify-center border-b sm:border-b-0 sm:border-r border-border">
                      <div className="text-xs font-mono text-muted-foreground">{format(new Date(roll.createdAt), "MMM d, HH:mm:ss")}</div>
                      {roll.characterName ? (
                        <div className="text-nc-cyan font-display text-sm mt-1">{roll.characterName}</div>
                      ) : (
                        <div className="text-muted-foreground font-display text-sm mt-1">OOC Roll</div>
                      )}
                      <div className="font-mono text-xs mt-2 border border-border/50 inline-block px-1.5 py-0.5 bg-background text-nc-magenta self-start">
                        {roll.expression}
                      </div>
                      {roll.label && <div className="text-sm font-mono mt-2 italic text-foreground/80">"{roll.label}"</div>}
                    </div>
                    
                    <div className="p-4 sm:w-2/3 flex items-center justify-between">
                      <div className="flex-1">
                        <div className="text-xs font-mono text-muted-foreground mb-1 uppercase">Results</div>
                        <div className="flex flex-wrap gap-1 font-mono">
                          {roll.rolls.map((r, i) => (
                            <span key={i} className="inline-block px-2 py-1 bg-background border border-border text-foreground">
                              {r}
                            </span>
                          ))}
                          {roll.modifier !== undefined && roll.modifier !== 0 && (
                            <span className="inline-block px-2 py-1 text-nc-cyan self-center">
                              {roll.modifier > 0 ? '+' : ''}{roll.modifier}
                            </span>
                          )}
                        </div>
                      </div>
                      
                      <div className="text-right pl-4 border-l border-border/50 ml-4 min-w-[80px]">
                        <div className="text-xs font-mono text-muted-foreground mb-1 uppercase tracking-widest">Total</div>
                        <div className="text-4xl font-display font-bold text-nc-magenta">
                          {roll.total}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

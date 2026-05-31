import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDownToLine, ArrowUpFromLine, Wallet } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface VenueTransaction {
  id: number;
  amount: number;
  kind: string;
  memo?: string | null;
  createdAt: string;
  previousBalance?: number | null;
  newBalance?: number | null;
}

interface Props {
  balance: number;
  transactions: VenueTransaction[];
  onDeposit: (amount: number) => Promise<unknown>;
  onWithdraw: (amount: number) => Promise<unknown>;
  busy?: boolean;
  accent?: "cyan" | "magenta";
  testIdPrefix: string;
}

export default function VenueWalletPanel({
  balance,
  transactions,
  onDeposit,
  onWithdraw,
  busy,
  accent = "cyan",
  testIdPrefix,
}: Props) {
  const [amount, setAmount] = useState(0);
  const accentClass = accent === "magenta" ? "bg-nc-magenta" : "bg-nc-cyan";
  const { toast } = useToast();

  // Deposit/withdraw used to be fire-and-forget, so when the economy was
  // disabled (409) or in test mode (dry-run), the click appeared to do nothing.
  // Await the mutation and always surface the outcome: success, simulated, or
  // the server's error message.
  const move = async (dir: "deposit" | "withdraw") => {
    if (amount <= 0) return;
    const moved = amount;
    try {
      const res = (await (dir === "deposit" ? onDeposit(moved) : onWithdraw(moved))) as
        | { dryRun?: boolean }
        | undefined;
      setAmount(0);
      if (res?.dryRun) {
        toast({
          title: "Economy in test mode",
          description: `Simulated only — no eddies were actually ${dir === "deposit" ? "deposited" : "withdrawn"}. Balances are unchanged.`,
        });
        return;
      }
      toast({
        title: dir === "deposit" ? "Deposit complete" : "Withdrawal complete",
        description: `${moved.toLocaleString()} €$ ${dir === "deposit" ? "moved into" : "moved out of"} this account.`,
      });
    } catch (err) {
      const data = (err as { data?: { error?: string } })?.data;
      const msg = data?.error || (err instanceof Error ? err.message : "Something went wrong — no money moved.");
      toast({
        title: dir === "deposit" ? "Deposit failed" : "Withdrawal failed",
        description: msg,
        variant: "destructive",
      });
    }
  };

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest flex items-center gap-2">
          <Wallet className="w-4 h-4" /> ACCOUNT
        </CardTitle>
        <span className="font-mono text-nc-yellow text-lg" data-testid={`text-${testIdPrefix}-balance`}>
          {balance.toLocaleString()} €$
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <Input
            type="number"
            min={0}
            placeholder="Amount"
            value={amount || ""}
            onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
            className="w-40"
            data-testid={`input-${testIdPrefix}-amount`}
          />
          <Button
            disabled={busy || amount <= 0}
            onClick={() => void move("deposit")}
            className={`rounded-none ${accentClass} text-background font-display`}
            data-testid={`button-${testIdPrefix}-deposit`}
          >
            <ArrowDownToLine className="w-4 h-4 mr-1" /> DEPOSIT
          </Button>
          <Button
            disabled={busy || amount <= 0 || amount > balance}
            onClick={() => void move("withdraw")}
            variant="outline"
            className="rounded-none font-display border-border"
            data-testid={`button-${testIdPrefix}-withdraw`}
          >
            <ArrowUpFromLine className="w-4 h-4 mr-1" /> WITHDRAW
          </Button>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          Deposit moves eddies from your personal wallet into this account. Withdraw moves them back.
        </p>

        <div className="space-y-1">
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">History</p>
          {transactions.length === 0 ? (
            <p className="font-mono text-xs text-muted-foreground py-2">No transactions yet.</p>
          ) : (
            <div className="divide-y divide-border/30">
              {transactions.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between py-2 font-mono text-xs"
                  data-testid={`row-${testIdPrefix}-txn-${t.id}`}
                >
                  <div className="flex flex-col">
                    <span className="text-foreground">{t.memo || t.kind}</span>
                    <span className="text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</span>
                  </div>
                  <span className={t.amount >= 0 ? "text-nc-cyan" : "text-destructive"}>
                    {t.amount >= 0 ? "+" : ""}
                    {t.amount.toLocaleString()} €$
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

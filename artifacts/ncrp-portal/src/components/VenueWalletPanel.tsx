import { useState } from "react";
import { formatEddies, formatDateTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDownToLine, ArrowUpFromLine, Wallet, Banknote } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";

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
  // Admin-only: mint eddies straight into the venue account with no personal
  // wallet leg. When provided, a GRANT button appears next to deposit/withdraw.
  onGrant?: (amount: number) => Promise<unknown>;
  busy?: boolean;
  accent?: "cyan" | "magenta";
  testIdPrefix: string;
}

export default function VenueWalletPanel({
  balance,
  transactions,
  onDeposit,
  onWithdraw,
  onGrant,
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
  const VERB = {
    deposit: { done: "Deposit complete", failed: "Deposit failed", sim: "deposited", flow: "moved into" },
    withdraw: { done: "Withdrawal complete", failed: "Withdrawal failed", sim: "withdrawn", flow: "moved out of" },
    grant: { done: "Grant complete", failed: "Grant failed", sim: "granted", flow: "added to" },
  } as const;

  const move = async (dir: "deposit" | "withdraw" | "grant") => {
    if (amount <= 0) return;
    const moved = amount;
    const v = VERB[dir];
    try {
      const fn = dir === "deposit" ? onDeposit : dir === "withdraw" ? onWithdraw : onGrant!;
      const res = (await fn(moved)) as { dryRun?: boolean } | undefined;
      setAmount(0);
      if (res?.dryRun) {
        toast({
          title: "Economy in test mode",
          description: `Simulated only — no eddies were actually ${v.sim}. Balances are unchanged.`,
        });
        return;
      }
      toast({
        title: v.done,
        description: `${formatEddies(moved)} ${v.flow} this account.`,
      });
    } catch (err) {
      toast({
        title: v.failed,
        description: apiErrorMessage(err, "Something went wrong — no money moved."),
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
          {formatEddies(balance)}
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
          {onGrant && (
            <Button
              disabled={busy || amount <= 0}
              onClick={() => void move("grant")}
              variant="outline"
              className="rounded-none font-display border-nc-yellow text-nc-yellow"
              data-testid={`button-${testIdPrefix}-grant`}
            >
              <Banknote className="w-4 h-4 mr-1" /> GRANT
            </Button>
          )}
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          Deposit moves eddies from your personal wallet into this account. Withdraw moves them back.
          {onGrant && " Grant (admin) adds eddies directly to this account with no personal-wallet deduction."}
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
                    <span className="text-muted-foreground">{formatDateTime(t.createdAt)}</span>
                  </div>
                  <span className={t.amount >= 0 ? "text-nc-cyan" : "text-destructive"}>
                    {t.amount >= 0 ? "+" : ""}
                    {formatEddies(t.amount)}
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

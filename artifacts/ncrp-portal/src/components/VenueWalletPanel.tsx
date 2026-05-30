import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowDownToLine, ArrowUpFromLine, Wallet } from "lucide-react";

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
  onDeposit: (amount: number) => void;
  onWithdraw: (amount: number) => void;
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
            onClick={() => {
              if (amount <= 0) return;
              onDeposit(amount);
              setAmount(0);
            }}
            className={`rounded-none ${accentClass} text-background font-display`}
            data-testid={`button-${testIdPrefix}-deposit`}
          >
            <ArrowDownToLine className="w-4 h-4 mr-1" /> DEPOSIT
          </Button>
          <Button
            disabled={busy || amount <= 0 || amount > balance}
            onClick={() => {
              if (amount <= 0) return;
              onWithdraw(amount);
              setAmount(0);
            }}
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

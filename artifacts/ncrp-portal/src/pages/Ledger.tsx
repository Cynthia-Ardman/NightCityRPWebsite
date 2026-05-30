import {
  useGetMyWallet,
  useGetMyWalletTransactions,
  useListMyCharacters,
  useTransferEddies,
  getGetMyWalletQueryKey,
  getGetMyWalletTransactionsQueryKey,
  type WalletTransaction,
} from "@workspace/api-client-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import { Receipt, ArrowDownLeft, ArrowUpRight } from "lucide-react";

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Ledger() {
  const { data: me } = useAuthMe();
  const { data: wallet } = useGetMyWallet({
    query: { enabled: !!me, queryKey: getGetMyWalletQueryKey() },
  });
  const { data: txns, isLoading } = useGetMyWalletTransactions({
    query: { enabled: !!me, queryKey: getGetMyWalletTransactionsQueryKey() },
  });

  const rows = (txns ?? []) as WalletTransaction[];

  return (
    <div className="space-y-8 max-w-4xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-ledger-title"
        >
          <Receipt className="w-8 h-8 text-nc-yellow" /> LEDGER
        </h1>
        <p className="text-muted-foreground font-mono mt-2">
          Every eddie in and out of your account, across all your characters.
        </p>
      </div>

      <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5" data-testid="card-ledger-balance">
        <CardContent className="flex items-center justify-between p-6">
          <div className="font-display tracking-widest text-nc-yellow text-sm">CURRENT BALANCE</div>
          <div className="font-mono text-3xl font-bold text-nc-yellow">
            {typeof wallet?.balance === "number" ? wallet.balance.toLocaleString() : "—"}
            <span className="text-nc-yellow/50 text-base ml-2">€$</span>
          </div>
        </CardContent>
      </Card>

      <TransferCard />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan">TRANSACTION HISTORY</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-16 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground font-mono text-sm">
              No transactions yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[600px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Date</th>
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Memo</th>
                    <th className="text-right p-3">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    const credit = t.amount >= 0;
                    return (
                      <tr
                        key={t.id}
                        className="border-b border-border/30 hover:bg-card/80"
                        data-testid={`row-ledger-${t.id}`}
                      >
                        <td className="p-3 text-muted-foreground whitespace-nowrap">
                          {new Date(t.createdAt).toLocaleString()}
                        </td>
                        <td className="p-3">{humanizeKind(t.kind)}</td>
                        <td className="p-3 text-muted-foreground">
                          {t.memo ?? (t.counterpartyName ? `→ ${t.counterpartyName}` : "—")}
                        </td>
                        <td
                          className={`p-3 text-right whitespace-nowrap font-bold ${credit ? "text-nc-green" : "text-nc-magenta"}`}
                        >
                          <span className="inline-flex items-center gap-1 justify-end">
                            {credit ? (
                              <ArrowDownLeft className="w-3 h-3" />
                            ) : (
                              <ArrowUpRight className="w-3 h-3" />
                            )}
                            {credit ? "+" : "−"}
                            {Math.abs(t.amount).toLocaleString()} €$
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Transfer eddies from one of the player's own characters to another
// character. Relocated here from the old per-character Ledger tab — the
// per-player Ledger page is now the single home for money movement.
function TransferCard() {
  const qc = useQueryClient();
  const { data: myChars } = useListMyCharacters();
  const [fromId, setFromId] = useState<number | null>(null);
  const [to, setTo] = useState<CharacterPickerValue>(null);
  const [amount, setAmount] = useState(0);
  const [memo, setMemo] = useState("");

  const transfer = useTransferEddies({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
        qc.invalidateQueries({ queryKey: getGetMyWalletTransactionsQueryKey() });
        setTo(null);
        setAmount(0);
        setMemo("");
      },
    },
  });

  const chars = myChars ?? [];
  const canSubmit = !!fromId && !!to?.id && amount > 0 && fromId !== to.id && !transfer.isPending;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">TRANSFER EDDIES</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-mono text-xs text-muted-foreground">
          Eddies are account-level (UnbelievaBoat). Transfers are recorded against the chosen
          characters so the ledger stays auditable.
        </p>
        <form
          className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit || !to?.id || !fromId) return;
            transfer.mutate({ id: fromId, data: { toCharacterId: to.id, amount, memo: memo || undefined } });
          }}
        >
          <div className="sm:col-span-3">
            <Label className="text-xs font-mono">FROM</Label>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              className="w-full h-10 bg-background border border-border rounded-none px-2 font-mono text-sm text-foreground"
              data-testid="select-transfer-from"
            >
              <option value="">Select character…</option>
              {chars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <Label className="text-xs font-mono">TO</Label>
            <CharacterPicker value={to} onChange={setTo} testId="input-transfer-to" />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs font-mono">AMOUNT (€$)</Label>
            <Input
              type="number"
              min={1}
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
              data-testid="input-transfer-amount"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs font-mono">MEMO</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-transfer-memo" />
          </div>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-transfer"
            >
              {transfer.isPending ? "SENDING..." : "SEND"}
            </Button>
          </div>
        </form>
        {fromId && to?.id && fromId === to.id && (
          <div className="text-nc-yellow font-mono text-xs">Pick two different characters.</div>
        )}
        {transfer.error && (
          <div className="text-destructive font-mono text-sm" data-testid="text-transfer-error">
            Transfer failed. Check funds or try again.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

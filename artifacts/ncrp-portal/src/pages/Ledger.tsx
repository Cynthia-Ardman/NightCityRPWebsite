import { formatEddies, formatDateTime } from "@/lib/format";
import {
  useGetMyWallet,
  useGetMyWalletTransactions,
  useListMyCharacters,
  useTransferEddies,
  useSinkEddies,
  useWithdrawEddies,
  useDepositEddies,
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
import { Receipt, ArrowDownLeft, ArrowUpRight, Flame } from "lucide-react";
import { Link } from "wouter";

function humanizeKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Pull the human-readable message off a failed API mutation. The custom fetch
// client throws an ApiError whose `.data` carries the server's `{ error }`
// payload; fall back to a generic message when it's missing.
function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  const msg = (data as { error?: unknown } | null)?.error;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

// The Type column prefers the coarse `category` (rent, cyberware, mission, …)
// which is meaningful for legacy rows whose kind is the generic 'historical'.
// Falls back to the humanized kind when no category is present.
function typeLabel(t: WalletTransaction): string {
  if (t.category) return humanizeKind(t.category);
  return humanizeKind(t.kind);
}

// Whether a transaction has anything to show in the Details column: a memo, a
// named counterparty, or a counterparty venue. When none are present we render a
// placeholder dash instead of an empty cell.
function hasDetails(t: WalletTransaction): boolean {
  return Boolean(
    t.memo ?? t.counterpartyCharacterName ?? t.counterpartyName ?? t.counterpartyVenueName,
  );
}

// Renders the other side of a transaction with a direction prefix so players
// can read at a glance who sent or received the money. A credit (money in)
// shows "From <counterparty>"; a debit (money out) shows "To <counterparty>".
// When the counterparty resolves to a character, link straight to its detail
// page; when it resolves to a venue (store/ripperdoc), link to that venue.
function Counterparty({ t }: { t: WalletTransaction }) {
  const credit = t.amount >= 0;
  const prefix = credit ? "From" : "To";
  const venueHref =
    t.counterpartyVenueKind === "store" && t.counterpartyVenueId != null
      ? `/directory/stores/${t.counterpartyVenueId}`
      : t.counterpartyVenueKind === "ripperdoc" && t.counterpartyVenueId != null
        ? `/directory/ripperdocs/${t.counterpartyVenueId}`
        : null;
  const label = t.counterpartyCharacterName ?? t.counterpartyName ?? t.counterpartyVenueName;
  if (!label) return null;
  if (t.counterpartyCharacterId != null) {
    return (
      <span className="whitespace-nowrap">
        <span className="text-muted-foreground/60">{prefix} </span>
        <Link
          href={`/characters/${t.counterpartyCharacterId}`}
          className="text-nc-cyan hover:underline cursor-pointer"
          data-testid={`link-ledger-counterparty-${t.id}`}
        >
          {label}
        </Link>
      </span>
    );
  }
  if (venueHref != null) {
    return (
      <span className="whitespace-nowrap">
        <span className="text-muted-foreground/60">{prefix} </span>
        <Link
          href={venueHref}
          className="text-nc-cyan hover:underline cursor-pointer"
          data-testid={`link-ledger-venue-${t.id}`}
        >
          {label}
        </Link>
      </span>
    );
  }
  return (
    <span className="whitespace-nowrap text-foreground">
      <span className="text-muted-foreground/60">{prefix} </span>
      {label}
    </span>
  );
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
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
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
        <CardContent className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="font-display tracking-widest text-nc-yellow text-sm">CURRENT BALANCE</div>
            <div className="font-mono text-3xl font-bold text-nc-yellow" data-testid="text-balance-total">
              {typeof wallet?.balance === "number" ? wallet.balance.toLocaleString() : "—"}
              <span className="text-nc-yellow/50 text-base ml-2">€$</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 border-t border-nc-yellow/20 pt-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Cash (spendable)
              </div>
              <div className="font-mono text-xl font-bold text-nc-green" data-testid="text-balance-cash">
                {typeof wallet?.cash === "number" ? wallet.cash.toLocaleString() : "—"}
                <span className="text-nc-green/50 text-sm ml-1">€$</span>
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Bank</div>
              <div className="font-mono text-xl font-bold text-nc-cyan" data-testid="text-balance-bank">
                {typeof wallet?.bank === "number" ? wallet.bank.toLocaleString() : "—"}
                <span className="text-nc-cyan/50 text-sm ml-1">€$</span>
              </div>
            </div>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            Transfers spend <span className="text-nc-green">cash</span> only. Withdraw from your bank to make
            those eddies spendable.
          </p>
        </CardContent>
      </Card>

      <WithdrawDepositCard cash={wallet?.cash ?? null} bank={wallet?.bank ?? null} />

      <TransferCard cash={wallet?.cash ?? null} total={wallet?.balance ?? null} />

      <SinkCard cash={wallet?.cash ?? null} total={wallet?.balance ?? null} />

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
            <>
            {/* Mobile: stacked two-line cards instead of a wide table. */}
            <ul className="md:hidden divide-y divide-border/30 font-mono text-sm">
              {rows.map((t) => {
                const credit = t.amount >= 0;
                return (
                  <li key={t.id} className="p-3 space-y-1" data-testid={`card-ledger-${t.id}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-foreground truncate">{typeLabel(t)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {formatDateTime(t.createdAt)}
                        </div>
                      </div>
                      <div
                        className={`shrink-0 text-right font-bold ${credit ? "text-nc-green" : "text-nc-magenta"}`}
                      >
                        <span className="inline-flex items-center gap-1">
                          {credit ? (
                            <ArrowDownLeft className="w-3 h-3" />
                          ) : (
                            <ArrowUpRight className="w-3 h-3" />
                          )}
                          {credit ? "+" : "−"}
                          {formatEddies(Math.abs(t.amount))}
                        </span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      {t.characterId != null ? (
                        <Link
                          href={`/characters/${t.characterId}`}
                          className="text-nc-cyan hover:underline cursor-pointer"
                        >
                          {t.characterName ?? `#${t.characterId}`}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground/70">Account</span>
                      )}
                      {hasDetails(t) && <Counterparty t={t} />}
                    </div>
                    {t.memo && (
                      <div className="text-xs text-muted-foreground/80 break-words">{t.memo}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* Desktop: full table. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[600px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Date</th>
                    <th className="text-left p-3">Character</th>
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Details</th>
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
                          {formatDateTime(t.createdAt)}
                        </td>
                        <td
                          className="p-3 whitespace-nowrap text-foreground"
                          data-testid={`text-ledger-character-${t.id}`}
                        >
                          {t.characterId != null ? (
                            <Link
                              href={`/characters/${t.characterId}`}
                              className="text-nc-cyan hover:underline cursor-pointer"
                            >
                              {t.characterName ?? `#${t.characterId}`}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground/70">Account</span>
                          )}
                        </td>
                        <td className="p-3">{typeLabel(t)}</td>
                        <td className="p-3 text-muted-foreground">
                          {hasDetails(t) ? (
                            <div className="flex flex-col gap-0.5">
                              <Counterparty t={t} />
                              {t.memo && <span className="text-muted-foreground/80">{t.memo}</span>}
                            </div>
                          ) : (
                            <>—</>
                          )}
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
                            {formatEddies(Math.abs(t.amount))}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Transfer eddies from one of the player's own characters to another
// character. Relocated here from the old per-character Ledger tab — the
// per-player Ledger page is now the single home for money movement.
function TransferCard({ cash, total }: { cash: number | null; total: number | null }) {
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

  // When a transfer fails, prefer the server's specific message. If it failed
  // for lack of cash but the bank would cover it, add a withdraw nudge so the
  // player isn't left with the old generic "check funds" dead end.
  let transferError: string | null = null;
  if (transfer.error) {
    transferError = apiErrorMessage(transfer.error, "Transfer failed. Check funds or try again.");
    // Only enhance the message when the server actually reported a cash/funds
    // problem — otherwise we'd mask unrelated errors (e.g. a recipient issue)
    // with a misleading withdraw nudge.
    const isFundsError = /cash|insufficient funds/i.test(transferError);
    if (
      isFundsError &&
      cash != null &&
      total != null &&
      amount > 0 &&
      cash < amount &&
      total >= amount
    ) {
      transferError = `Not enough cash on hand — you have ${formatEddies(cash)} in cash. Withdraw at least ${formatEddies(amount - cash)} from your bank first, then try again.`;
    }
  }

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
            transfer.mutate({ id: fromId, data: { toCharacterId: to.id, amount, memo: memo || undefined, idempotencyKey: crypto.randomUUID() } });
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
        {transferError && (
          <div className="text-destructive font-mono text-sm" data-testid="text-transfer-error">
            {transferError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Money sink: pay "Night City Bot" to permanently burn eddies out of the
// economy. A debit-only movement (no recipient), recorded in the ledger as a
// payment to Night City Bot. Only spends cash, so it shows the same
// withdraw-from-bank nudge as transfers when funds sit in the bank.
function SinkCard({ cash, total }: { cash: number | null; total: number | null }) {
  const qc = useQueryClient();
  const { data: myChars } = useListMyCharacters();
  const [fromId, setFromId] = useState<number | null>(null);
  const [amount, setAmount] = useState(0);
  const [memo, setMemo] = useState("");

  const sink = useSinkEddies({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
        qc.invalidateQueries({ queryKey: getGetMyWalletTransactionsQueryKey() });
        setAmount(0);
        setMemo("");
      },
    },
  });

  const chars = myChars ?? [];
  const canSubmit = !!fromId && amount > 0 && !sink.isPending;

  let sinkError: string | null = null;
  if (sink.error) {
    sinkError = apiErrorMessage(sink.error, "Payment failed. Check funds or try again.");
    const isFundsError = /cash|insufficient funds/i.test(sinkError);
    if (isFundsError && cash != null && total != null && amount > 0 && cash < amount && total >= amount) {
      sinkError = `Not enough cash on hand — you have ${formatEddies(cash)} in cash. Withdraw at least ${formatEddies(amount - cash)} from your bank first, then try again.`;
    }
  }

  return (
    <Card className="rounded-none border-nc-yellow/40 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-yellow flex items-center gap-2">
          <Flame className="w-5 h-5" /> PAY NIGHT CITY BOT
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-mono text-xs text-muted-foreground">
          Burn eddies out of the economy by paying Night City Bot. This spends the eddies with no
          recipient — the payment is recorded in your ledger and can't be undone.
        </p>
        <form
          className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit || !fromId) return;
            sink.mutate({ id: fromId, data: { amount, memo: memo || undefined, idempotencyKey: crypto.randomUUID() } });
          }}
        >
          <div className="sm:col-span-4">
            <Label className="text-xs font-mono">FROM</Label>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              className="w-full h-10 bg-background border border-border rounded-none px-2 font-mono text-sm text-foreground"
              data-testid="select-sink-from"
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
            <Label className="text-xs font-mono">AMOUNT (€$)</Label>
            <Input
              type="number"
              min={1}
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
              data-testid="input-sink-amount"
            />
          </div>
          <div className="sm:col-span-3">
            <Label className="text-xs font-mono">MEMO</Label>
            <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-sink-memo" />
          </div>
          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display"
              data-testid="button-sink"
            >
              {sink.isPending ? "BURNING..." : "PAY"}
            </Button>
          </div>
        </form>
        {sinkError && (
          <div className="text-destructive font-mono text-sm" data-testid="text-sink-error">
            {sinkError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Move eddies between the player's account-level bank and cash ("on person").
// Transfers can only spend cash, so a player whose money sits in the bank uses
// Withdraw to make it spendable; Deposit moves it back. Both call the new
// /me/wallet endpoints, then refresh the balance + history. UB writes only fire
// in the deployed environment, so in dev these no-op with a 502.
function WithdrawDepositCard({ cash, bank }: { cash: number | null; bank: number | null }) {
  const qc = useQueryClient();
  const [withdrawAmount, setWithdrawAmount] = useState(0);
  const [depositAmount, setDepositAmount] = useState(0);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
    qc.invalidateQueries({ queryKey: getGetMyWalletTransactionsQueryKey() });
  };

  const withdraw = useWithdrawEddies({
    mutation: { onSuccess: () => { refresh(); setWithdrawAmount(0); } },
  });
  const deposit = useDepositEddies({
    mutation: { onSuccess: () => { refresh(); setDepositAmount(0); } },
  });

  const canWithdraw =
    withdrawAmount > 0 && !withdraw.isPending && (bank == null || withdrawAmount <= bank);
  const canDeposit =
    depositAmount > 0 && !deposit.isPending && (cash == null || depositAmount <= cash);

  const withdrawError = withdraw.error
    ? apiErrorMessage(withdraw.error, "Withdrawal failed. Try again.")
    : bank != null && withdrawAmount > bank
      ? `You only have ${formatEddies(bank)} in the bank.`
      : null;
  const depositError = deposit.error
    ? apiErrorMessage(deposit.error, "Deposit failed. Try again.")
    : cash != null && depositAmount > cash
      ? `You only have ${formatEddies(cash)} in cash.`
      : null;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">BANK</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono text-xs text-muted-foreground">
          Withdraw moves eddies from your <span className="text-nc-cyan">bank</span> to your spendable
          <span className="text-nc-green"> cash</span>. Deposit moves cash back into the bank. Your total
          never changes.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {/* Withdraw: bank -> cash */}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canWithdraw) return;
              withdraw.mutate({ data: { amount: withdrawAmount, idempotencyKey: crypto.randomUUID() } });
            }}
          >
            <Label className="text-xs font-mono">WITHDRAW (BANK → CASH)</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={withdrawAmount || ""}
                onChange={(e) => setWithdrawAmount(Number(e.target.value))}
                data-testid="input-withdraw-amount"
              />
              <Button
                type="submit"
                disabled={!canWithdraw}
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display whitespace-nowrap"
                data-testid="button-withdraw"
              >
                {withdraw.isPending ? "..." : "WITHDRAW"}
              </Button>
            </div>
            {withdrawError && (
              <div className="text-destructive font-mono text-xs" data-testid="text-withdraw-error">
                {withdrawError}
              </div>
            )}
          </form>
          {/* Deposit: cash -> bank */}
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!canDeposit) return;
              deposit.mutate({ data: { amount: depositAmount, idempotencyKey: crypto.randomUUID() } });
            }}
          >
            <Label className="text-xs font-mono">DEPOSIT (CASH → BANK)</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                value={depositAmount || ""}
                onChange={(e) => setDepositAmount(Number(e.target.value))}
                data-testid="input-deposit-amount"
              />
              <Button
                type="submit"
                disabled={!canDeposit}
                className="rounded-none bg-nc-green text-background hover:bg-nc-green/80 font-display whitespace-nowrap"
                data-testid="button-deposit"
              >
                {deposit.isPending ? "..." : "DEPOSIT"}
              </Button>
            </div>
            {depositError && (
              <div className="text-destructive font-mono text-xs" data-testid="text-deposit-error">
                {depositError}
              </div>
            )}
          </form>
        </div>
      </CardContent>
    </Card>
  );
}

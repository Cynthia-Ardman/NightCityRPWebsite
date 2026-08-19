import { useAdminAdjustWallet, useAdminSinkWallet } from "@workspace/api-client-react";
import { formatEddies } from "@/lib/format";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiError";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";

// characterId is supplied from the CharacterPicker (see onSubmit), not a form
// field — validating it here would silently block submit since it never syncs.
const walletSchema = z.object({
  amount: z.coerce.number(),
  reason: z.string().min(1, "Reason is required"),
});

export function WalletTab() {
  const adjustWallet = useAdminAdjustWallet();
  const { toast } = useToast();
  const [target, setTarget] = useState<CharacterPickerValue>(null);

  const form = useForm<z.infer<typeof walletSchema>>({
    resolver: zodResolver(walletSchema),
    defaultValues: {
      amount: 0,
      reason: "",
    },
  });

  const onSubmit = (values: z.infer<typeof walletSchema>) => {
    if (!target || (!target.id && !target.userId)) {
      toast({ title: "Pick a target", description: "Search by character or player name.", variant: "destructive" });
      return;
    }
    adjustWallet.mutate({ data: { ...values, ...(target.id ? { characterId: target.id } : { userId: target.userId }) } }, {
      onSuccess: () => {
        toast({ title: "Wallet Adjusted", description: `Adjusted ${target.name}.` });
        form.reset();
        setTarget(null);
      },
      onError: (err) => {
        toast({ title: "Adjustment Failed", description: apiErrorMessage(err, "Adjustment failed"), variant: "destructive" });
      }
    });
  };

  return (
    <div className="space-y-6">
    <Card className="rounded-none border-destructive/50 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-destructive">Manual Wallet Adjustment</CardTitle>
        <CardDescription className="font-mono">Directly inject or drain eddies from a character. Logged as 'admin' transaction.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 font-mono max-w-md">
            <div className="space-y-2">
              <Label>Character</Label>
              <CharacterPicker value={target} onChange={setTarget} scope="all" allowPlayers testId="input-wallet-char" />
              {!target && (
                <p className="text-xs text-muted-foreground">Search by character or player name.</p>
              )}
            </div>
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount (Positive or Negative)</FormLabel>
                  <FormControl>
                    <Input type="number" className="rounded-none border-border bg-background focus-visible:ring-destructive" {...field} data-testid="input-wallet-amount" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason / Memo</FormLabel>
                  <FormControl>
                    <Input className="rounded-none border-border bg-background focus-visible:ring-destructive" placeholder="Admin adjustment" {...field} data-testid="input-wallet-reason" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={adjustWallet.isPending || (!target?.id && !target?.userId)} className="w-full rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display mt-4" data-testid="button-submit-wallet">
              {adjustWallet.isPending ? "PROCESSING..." : "EXECUTE TRANSFER"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>

    <AdminSinkCard />
    </div>
  );
}

const sinkSchema = z.object({
  amount: z.coerce.number().positive("Amount must be positive"),
  memo: z.string().optional(),
});

// Staff money sink: burn eddies from any character by "paying Night City Bot".
// Debit-only movement recorded with kind "sink" — reads clearly in the ledger.
// Requires the character to hold the cash; force-removal beyond balance stays in
// Manual Wallet Adjustment above.
function AdminSinkCard() {
  const sinkWallet = useAdminSinkWallet();
  const { toast } = useToast();
  const [target, setTarget] = useState<CharacterPickerValue>(null);

  const form = useForm<z.infer<typeof sinkSchema>>({
    resolver: zodResolver(sinkSchema),
    defaultValues: { amount: 0, memo: "" },
  });

  const onSubmit = (values: z.infer<typeof sinkSchema>) => {
    if (!target?.id) {
      toast({ title: "Pick a character", description: "Search by character or player name.", variant: "destructive" });
      return;
    }
    sinkWallet.mutate(
      {
        data: {
          characterId: target.id,
          amount: values.amount,
          memo: values.memo || undefined,
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Eddies Burned", description: `${target.name} paid Night City Bot ${formatEddies(values.amount)}.` });
          form.reset();
          setTarget(null);
        },
        onError: (err: any) => {
          toast({ title: "Payment Failed", description: err?.data?.error ?? err?.message ?? "Try again.", variant: "destructive" });
        },
      },
    );
  };

  return (
    <Card className="rounded-none border-nc-yellow/50 bg-card/50">
      <CardHeader>
        <CardTitle className="font-display text-nc-yellow">Pay Night City Bot (Money Sink)</CardTitle>
        <CardDescription className="font-mono">Burn eddies out of the economy from any character. Recorded in the ledger as a payment to Night City Bot.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 font-mono max-w-md">
            <div className="space-y-2">
              <Label>Character</Label>
              <CharacterPicker value={target} onChange={setTarget} scope="all" testId="input-sink-char" />
              {!target && (
                <p className="text-xs text-muted-foreground">Search by character or player name.</p>
              )}
            </div>
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Amount to burn (€$)</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} className="rounded-none border-border bg-background focus-visible:ring-nc-yellow" {...field} data-testid="input-sink-amount" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="memo"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason / Memo</FormLabel>
                  <FormControl>
                    <Input className="rounded-none border-border bg-background focus-visible:ring-nc-yellow" placeholder="Paid Night City Bot" {...field} data-testid="input-sink-reason" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={sinkWallet.isPending || !target?.id} className="w-full rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display mt-4" data-testid="button-submit-sink">
              {sinkWallet.isPending ? "BURNING..." : "PAY NIGHT CITY BOT"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

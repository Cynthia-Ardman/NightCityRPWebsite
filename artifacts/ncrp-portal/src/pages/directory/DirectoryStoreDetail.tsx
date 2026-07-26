import { useState } from "react";
import { formatEddies } from "@/lib/format";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetStorePublic, useGiveToStore, useListMyStores, getGetStorePublicQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Settings, Gift } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

export default function DirectoryStoreDetail() {
  const { id } = useParams<{ id: string }>();
  const storeId = Number(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetStorePublic(storeId);
  const { data: me } = useEffectiveMe();
  const isStaff = !!me && (me.isAdmin || me.isFixer);
  // The owner and any employee of this store reach the management view from
  // here too — not just staff. /stores/mine already returns stores the user
  // owns OR is employed at, so a hit means they have management access.
  const { data: myStores } = useListMyStores();
  const canManage = isStaff || (myStores ?? []).some((s) => s.id === storeId);
  const [giveAmount, setGiveAmount] = useState(0);
  const [giveMemo, setGiveMemo] = useState("");
  const give = useGiveToStore({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetStorePublicQueryKey(storeId) }),
    },
  });
  const submitGive = async () => {
    if (giveAmount <= 0) return;
    const sent = giveAmount;
    try {
      const res = (await give.mutateAsync({
        id: storeId,
        data: { amount: sent, memo: giveMemo.trim() || undefined, idempotencyKey: crypto.randomUUID() },
      })) as { dryRun?: boolean } | undefined;
      setGiveAmount(0);
      setGiveMemo("");
      if (res?.dryRun) {
        toast({
          title: "Economy in test mode",
          description: "Simulated only — no eddies were actually transferred.",
        });
        return;
      }
      toast({ title: "Gift sent", description: `${formatEddies(sent)} given to ${data?.name ?? "this store"}.` });
    } catch (err) {
      const msg = (err as { data?: { error?: string } })?.data?.error
        || (err instanceof Error ? err.message : "Something went wrong — no money moved.");
      toast({ title: "Gift failed", description: msg, variant: "destructive" });
    }
  };
  if (isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;
  if (!data) return <div className="font-display text-destructive">STORE NOT FOUND</div>;
  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      {data.bannerUrl && (
        <div className="w-full overflow-hidden border border-nc-cyan/40 bg-black/30">
          <img
            src={data.bannerUrl}
            alt={`${data.name} banner`}
            className="w-full max-h-72 object-contain"
            data-testid="img-store-banner"
          />
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-store-name">{data.name}</h1>
          <p className="font-mono text-xs text-muted-foreground mt-1">{data.location ?? "—"} · <Badge variant="outline" className="rounded-none border-nc-yellow text-nc-yellow uppercase">{data.kind}</Badge></p>
          <p className="font-mono text-xs text-nc-cyan mt-1" data-testid="text-store-owner">OWNER: {data.ownerName ?? "UNCLAIMED"}</p>
          {data.purpose && <p className="font-mono text-xs text-muted-foreground mt-1" data-testid="text-store-purpose">{data.purpose}</p>}
        </div>
        {canManage && (
          <Link href={`/stores/${data.id}`}>
            <Button className="rounded-none bg-nc-cyan text-background font-display shrink-0" data-testid="button-manage-store">
              <Settings className="w-4 h-4 mr-2" /> MANAGE
            </Button>
          </Link>
        )}
      </div>
      {data.description && <Card className="rounded-none border-border bg-card/50"><CardContent className="pt-6 font-mono text-sm whitespace-pre-wrap">{data.description}</CardContent></Card>}
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">STAFF</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {(data.employeeNames ?? []).length === 0 ? <p className="text-muted-foreground font-mono text-sm">No staff listed.</p> :
            (data.employeeNames ?? []).map((n, i) => (
              <div key={i} className="flex justify-between border-b border-border/30 py-2 text-sm font-mono" data-testid={`row-employee-${i}`}>
                <span>{n}</span>
              </div>
            ))}
        </CardContent>
      </Card>
      {me && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest flex items-center gap-2">
              <Gift className="w-4 h-4" /> GIVE EDDIES
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="font-mono text-xs text-muted-foreground">
              Send eddies from your personal wallet straight into this store's account. This is one-way — the store keeps it.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Input
                type="number"
                min={1}
                placeholder="Amount"
                value={giveAmount || ""}
                onChange={(e) => setGiveAmount(Math.max(0, Math.floor(Number(e.target.value))))}
                className="w-40"
                data-testid="input-store-give-amount"
              />
              <Button
                disabled={give.isPending || giveAmount <= 0}
                onClick={() => void submitGive()}
                className="rounded-none bg-nc-yellow text-background font-display"
                data-testid="button-store-give"
              >
                <Gift className="w-4 h-4 mr-1" /> {give.isPending ? "SENDING..." : "GIVE"}
              </Button>
            </div>
            <Textarea
              placeholder="Optional note (e.g. what it's for)"
              value={giveMemo}
              onChange={(e) => setGiveMemo(e.target.value)}
              maxLength={200}
              className="font-mono text-xs"
              data-testid="input-store-give-memo"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  useListCustomRequests,
  useApproveCustomRequest,
  useRejectCustomRequest,
  useListPendingSheets,
  getListCustomRequestsQueryKey,
  type CustomRequest,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Clock, FileText, Inbox, Home, Crosshair, Cpu } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuthMe } from "@/hooks/useAuthMe";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";

const TYPE_META: Record<
  CustomRequest["type"],
  { label: string; Icon: typeof Home }
> = {
  property: { label: "PROPERTY", Icon: Home },
  gun: { label: "GUN", Icon: Crosshair },
  cyberware: { label: "CYBERWARE", Icon: Cpu },
};

function MiscRequestsTab() {
  const { data, isLoading } = useListCustomRequests({ status: "pending" });
  const requests = (data ?? []) as CustomRequest[];
  const [approveTarget, setApproveTarget] = useState<CustomRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<CustomRequest | null>(null);

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (requests.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <Inbox className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No miscellaneous requests require attention.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {requests.map((r) => {
        const meta = TYPE_META[r.type];
        const Icon = meta.Icon;
        return (
          <Card
            key={r.id}
            className="rounded-none border-border bg-card/50 flex flex-col"
            data-testid={`card-misc-request-${r.id}`}
          >
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" className="rounded-none border-nc-cyan text-nc-cyan font-mono text-[10px]">
                  <Icon className="w-3 h-3 mr-1" /> {meta.label}
                </Badge>
                <span className="text-xs font-mono text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()}
                </span>
              </div>
              <CardTitle className="text-lg font-display truncate mt-2">{r.title}</CardTitle>
              <CardDescription className="font-mono text-xs">
                {r.characterName} · by {r.requestedByName || r.requestedById}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col flex-1 gap-4">
              {r.description ? (
                <p className="font-mono text-sm text-muted-foreground whitespace-pre-wrap">{r.description}</p>
              ) : (
                <p className="font-mono text-sm text-muted-foreground italic">No description provided.</p>
              )}
              <div className="mt-auto flex gap-2 pt-3 border-t border-border/40">
                <Button
                  className="rounded-none flex-1 bg-nc-green text-background hover:bg-nc-green/80 font-display text-xs tracking-widest"
                  onClick={() => setApproveTarget(r)}
                  data-testid={`button-approve-misc-${r.id}`}
                >
                  APPROVE
                </Button>
                <Button
                  variant="outline"
                  className="rounded-none flex-1 border-destructive text-destructive hover:bg-destructive/10 font-display text-xs tracking-widest"
                  onClick={() => setRejectTarget(r)}
                  data-testid={`button-reject-misc-${r.id}`}
                >
                  REJECT
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <ApproveDialog request={approveTarget} onClose={() => setApproveTarget(null)} />
      <RejectDialog request={rejectTarget} onClose={() => setRejectTarget(null)} />
    </div>
  );
}

function ApproveDialog({ request, onClose }: { request: CustomRequest | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewerNote, setReviewerNote] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [kind, setKind] = useState<"residential" | "business">("residential");
  const [cwp, setCwp] = useState("");

  // Re-seed local form state whenever a different request is opened.
  const seedKey = request?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (request && seededFor !== seedKey) {
    setReviewerNote("");
    setMonthlyRent("");
    setKind("residential");
    setCwp("");
    setSeededFor(seedKey);
  }

  const approve = useApproveCustomRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey({ status: "pending" }) });
        toast({ title: "Request approved", description: "It has been applied to the character." });
        onClose();
      },
      onError: (err) => {
        toast({
          title: "Could not approve",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  if (!request) return null;

  const isProperty = request.type === "property";
  const isCyberware = request.type === "cyberware";
  const rentNum = parseInt(monthlyRent, 10);
  const cwpNum = parseInt(cwp, 10);
  const valid =
    (!isProperty || (Number.isFinite(rentNum) && rentNum >= 0)) &&
    (!isCyberware || (Number.isFinite(cwpNum) && cwpNum >= 0));

  return (
    <Dialog open={!!request} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-none border-nc-green/40 bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-green">
            APPROVE — {request.title.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Approving auto-applies this to {request.characterName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {isProperty && (
            <>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Monthly Rent (€$)</Label>
                <Input
                  type="number"
                  min={0}
                  value={monthlyRent}
                  onChange={(e) => setMonthlyRent(e.target.value)}
                  placeholder="e.g. 2500"
                  className="rounded-none font-mono"
                  data-testid="input-approve-rent"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Kind</Label>
                <Select value={kind} onValueChange={(v) => setKind(v as "residential" | "business")}>
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-approve-kind">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="residential">Residential</SelectItem>
                    <SelectItem value="business">Business</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {isCyberware && (
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">CWP (chrome point cost)</Label>
              <Input
                type="number"
                min={0}
                value={cwp}
                onChange={(e) => setCwp(e.target.value)}
                placeholder="e.g. 2"
                className="rounded-none font-mono"
                data-testid="input-approve-cwp"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reviewer Note (optional)</Label>
            <Input
              value={reviewerNote}
              onChange={(e) => setReviewerNote(e.target.value)}
              placeholder="Visible to the player"
              className="rounded-none font-mono"
              data-testid="input-approve-note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" className="rounded-none font-display" onClick={onClose}>
            CANCEL
          </Button>
          <Button
            className="rounded-none font-display tracking-widest bg-nc-green text-background hover:bg-nc-green/80"
            disabled={!valid || approve.isPending}
            onClick={() =>
              approve.mutate({
                id: request.id,
                data: {
                  reviewerNote: reviewerNote.trim() || undefined,
                  ...(isProperty ? { monthlyRent: rentNum, kind } : {}),
                  ...(isCyberware ? { cwp: cwpNum } : {}),
                },
              })
            }
            data-testid="button-confirm-approve"
          >
            {approve.isPending ? "APPLYING..." : "APPROVE & APPLY"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({ request, onClose }: { request: CustomRequest | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reviewerNote, setReviewerNote] = useState("");

  const seedKey = request?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (request && seededFor !== seedKey) {
    setReviewerNote("");
    setSeededFor(seedKey);
  }

  const reject = useRejectCustomRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListCustomRequestsQueryKey({ status: "pending" }) });
        toast({ title: "Request rejected" });
        onClose();
      },
      onError: (err) => {
        toast({
          title: "Could not reject",
          description: err instanceof Error ? err.message : "Please try again.",
          variant: "destructive",
        });
      },
    },
  });

  if (!request) return null;

  return (
    <Dialog open={!!request} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="rounded-none border-destructive/40 bg-card sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-destructive">
            REJECT — {request.title.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Let the player know why this request can't be granted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-2">
          <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Reviewer Note (optional)</Label>
          <Input
            value={reviewerNote}
            onChange={(e) => setReviewerNote(e.target.value)}
            placeholder="Reason for rejection"
            className="rounded-none font-mono"
            data-testid="input-reject-note"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" className="rounded-none font-display" onClick={onClose}>
            CANCEL
          </Button>
          <Button
            variant="outline"
            className="rounded-none font-display tracking-widest border-destructive text-destructive hover:bg-destructive/10"
            disabled={reject.isPending}
            onClick={() => reject.mutate({ id: request.id, data: { reviewerNote: reviewerNote.trim() || undefined } })}
            data-testid="button-confirm-reject"
          >
            {reject.isPending ? "REJECTING..." : "REJECT"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewCharactersTab() {
  const { data: sheets, isLoading } = useListPendingSheets();

  if (isLoading) {
    return <div className="py-20 text-center text-nc-cyan animate-pulse font-display text-xl">LOADING_QUEUE...</div>;
  }
  if (!sheets || sheets.length === 0) {
    return (
      <div className="py-20 text-center border border-dashed border-border bg-card/30">
        <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
        <h3 className="text-xl font-display text-foreground mb-2">QUEUE EMPTY</h3>
        <p className="text-muted-foreground font-mono text-sm">No pending sheets require attention.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {sheets.map((sheet: any) => (
        <Link key={sheet.id} href={`/sheets/${sheet.id}`}>
          <Card
            className="rounded-none border-border bg-card/50 hover:border-nc-yellow hover:shadow-[0_0_15px_rgba(255,255,0,0.1)] transition-all cursor-pointer h-full flex flex-col"
            data-testid={`card-pending-sheet-${sheet.id}`}
          >
            <CardHeader>
              <CardTitle className="text-xl font-display truncate">{sheet.name}</CardTitle>
              <CardDescription className="font-mono text-xs">By {sheet.ownerName || sheet.ownerId}</CardDescription>
            </CardHeader>
            <CardContent className="mt-auto flex justify-between items-center border-t border-border/50 pt-4">
              <div className="text-xs font-mono text-muted-foreground">
                {new Date(sheet.createdAt).toLocaleDateString()}
              </div>
              <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none animate-pulse">
                REVIEW REQ
              </Badge>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export default function PendingRequests() {
  const { data: me } = useAuthMe();
  const canMisc = !!(me?.isAdmin || me?.isFixer);
  const canNewChars = !!(me?.isAdmin || me?.isCsApprover);

  // Default to the first tab the staffer can act on.
  const defaultTab = canMisc ? "misc" : "edits";

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div>
        <h1
          className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
          data-testid="text-pending-requests-title"
        >
          <Clock className="w-8 h-8 text-nc-yellow" /> PENDING REQUESTS
        </h1>
        <p className="text-muted-foreground font-mono mt-2">Review player submissions across the server.</p>
      </div>

      <Tabs defaultValue={defaultTab}>
        <TabsList className="rounded-none bg-card/60 border border-border p-1 flex flex-wrap h-auto justify-start gap-1">
          {canMisc && (
            <TabsTrigger value="misc" className="rounded-none font-display tracking-widest" data-testid="tab-misc">
              MISC REQUESTS
            </TabsTrigger>
          )}
          <TabsTrigger value="edits" className="rounded-none font-display tracking-widest" data-testid="tab-edits">
            CHARACTER EDITS
          </TabsTrigger>
          {canNewChars && (
            <TabsTrigger value="sheets" className="rounded-none font-display tracking-widest" data-testid="tab-sheets">
              NEW CHARACTERS
            </TabsTrigger>
          )}
        </TabsList>

        {canMisc && (
          <TabsContent value="misc" className="mt-6">
            <MiscRequestsTab />
          </TabsContent>
        )}
        <TabsContent value="edits" className="mt-6">
          <PendingEditsList embedded />
        </TabsContent>
        {canNewChars && (
          <TabsContent value="sheets" className="mt-6">
            <NewCharactersTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

import { useState } from "react";
import {
  useGetTraumaStatus,
  useCallTraumaTeam,
  useListMyCharacters,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Siren } from "lucide-react";

/**
 * Dashboard "CALL TRAUMA TEAM" button.
 *
 * Only rendered for users who POSITIVELY hold one of the Trauma Team
 * subscription roles on Discord (Silver/Gold/Platinum/Diamond) — the server
 * checks live role ids, and re-checks again on the actual call, so this is
 * cosmetic gating only. Clicking opens a confirm dialog where the player picks
 * which character needs extraction; the server then DMs every Trauma Team
 * responder with the character, the caller, and their subscription tier.
 */
export default function TraumaCallButton() {
  const { data: status } = useGetTraumaStatus();
  const { data: characters } = useListMyCharacters();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [characterId, setCharacterId] = useState<string>("");

  const call = useCallTraumaTeam({
    mutation: {
      onSuccess: (r) => {
        setOpen(false);
        toast({
          title: r.simulated ? "Trauma Team call simulated (test site)" : "Trauma Team is on the way!",
          description: r.simulated
            ? `No real DMs were sent from this environment (${r.responders} responders on file).`
            : `Paged ${r.notified} of ${r.responders} responders (Trauma Team ${r.tier}).`,
        });
      },
      onError: (err) => {
        const msg =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          "Could not call Trauma Team. Try again shortly.";
        toast({ title: "Call failed", description: msg, variant: "destructive" });
      },
    },
  });

  // Hide entirely unless we positively know the viewer is a subscriber.
  if (!status?.determined || !status.eligible) return null;

  const chars = (characters ?? []).filter((c) => c.lifeStatus !== "dead");

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        className="rounded-none bg-destructive text-destructive-foreground font-display tracking-widest hover:bg-destructive/90"
        data-testid="button-call-trauma"
      >
        <Siren className="w-4 h-4 mr-2" /> CALL TRAUMA TEAM
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display tracking-widest text-destructive">
              CALL TRAUMA TEAM
            </DialogTitle>
            <DialogDescription className="font-mono text-xs">
              Every on-duty Trauma Team responder will be paged immediately with your
              character&apos;s name and your {status.tier} subscription. Use this only when your
              character needs extraction right now.
            </DialogDescription>
          </DialogHeader>
          <Select value={characterId} onValueChange={setCharacterId}>
            <SelectTrigger className="rounded-none" data-testid="select-trauma-character">
              <SelectValue placeholder="Select a character" />
            </SelectTrigger>
            <SelectContent>
              {chars.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-none font-display"
              onClick={() => setOpen(false)}
              data-testid="button-trauma-cancel"
            >
              CANCEL
            </Button>
            <Button
              disabled={!characterId || call.isPending}
              onClick={() => call.mutate({ data: { characterId: Number(characterId) } })}
              className="rounded-none bg-destructive text-destructive-foreground font-display hover:bg-destructive/90"
              data-testid="button-trauma-confirm"
            >
              <Siren className="w-4 h-4 mr-1" />
              {call.isPending ? "CALLING..." : "CALL TRAUMA TEAM"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

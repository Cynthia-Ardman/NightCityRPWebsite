import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";
import { UserPlus } from "lucide-react";

interface NpcRoleStatus {
  hasRole: boolean;
  // false when the Discord lookup failed and we genuinely can't tell. Lets the
  // dashboard CTA stay hidden during a transient outage instead of wrongly
  // prompting someone who may already be an NPC.
  determined: boolean;
}

// Shared query so the dashboard CTA and the guidebook button stay in sync — a
// grant from one place flips the other immediately via cache invalidation.
export function useNpcRole() {
  const { data: me } = useAuthMe();
  return useQuery<NpcRoleStatus>({
    queryKey: ["npc-role"],
    queryFn: async () => {
      const r = await fetch("/api/auth/npc-role", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!me,
    staleTime: 60_000,
  });
}

/**
 * One-click self-service NPC role button.
 *
 * - variant="dashboard": a prominent CTA banner shown ONLY while the user lacks
 *   the role (and hidden while the status is still loading so it never flashes).
 * - variant="guidebook": always rendered, but DISABLED once the user holds the
 *   role, so the NPC Acting page consistently advertises the action.
 */
export default function BecomeNpcButton({ variant }: { variant: "dashboard" | "guidebook" }) {
  const { data: me } = useAuthMe();
  const { data, isLoading } = useNpcRole();
  const { toast } = useToast();
  const qc = useQueryClient();

  const grant = useMutation({
    mutationFn: async (): Promise<NpcRoleStatus> => {
      const r = await fetch("/api/auth/npc-role", { method: "POST", credentials: "include" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          (body as { error?: string })?.error || `Could not grant the NPC role (HTTP ${r.status}).`,
        );
      }
      return body as NpcRoleStatus;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["npc-role"] });
      toast({
        title: "You're an NPC now!",
        description: "The NPC role has been added to your Discord account.",
      });
    },
    onError: (err) => {
      toast({
        title: "Couldn't grant the NPC role",
        description: err instanceof Error ? err.message : "Please try again later.",
        variant: "destructive",
      });
    },
  });

  if (!me) return null;
  const hasRole = data?.hasRole ?? false;

  if (variant === "dashboard") {
    // Surface the CTA only to people we POSITIVELY know aren't NPCs yet. Hidden
    // while loading (so role-holders never see a flash), when they have the
    // role, and when the Discord lookup couldn't determine status — better to
    // stay quiet than prompt someone who may already be an NPC.
    if (isLoading || !data?.determined || hasRole) return null;
    return (
      <Card
        className="rounded-none border-nc-magenta/50 bg-gradient-to-r from-nc-magenta/15 via-nc-magenta/5 to-transparent shadow-[0_0_20px_rgba(255,0,255,0.15)]"
        data-testid="card-become-npc"
      >
        <CardContent className="p-4 flex flex-wrap items-center gap-4">
          <UserPlus className="w-8 h-8 text-nc-magenta shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-mono tracking-widest text-nc-magenta uppercase">
              Get involved
            </div>
            <div className="font-display text-lg text-foreground">BECOME AN NPC</div>
            <div className="font-mono text-xs text-muted-foreground">
              Help run the world — play background characters at events. One click adds the NPC role to your Discord.
            </div>
          </div>
          <Button
            onClick={() => grant.mutate()}
            disabled={grant.isPending}
            className="rounded-none bg-nc-magenta hover:bg-nc-magenta/80 text-foreground font-display shrink-0"
            data-testid="button-become-npc-dashboard"
          >
            {grant.isPending ? "GRANTING..." : "BECOME AN NPC TODAY"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Guidebook variant: always present, disabled once the user is an NPC.
  return (
    <div
      className="flex flex-wrap items-center gap-3 border border-nc-magenta/40 bg-nc-magenta/5 p-4"
      data-testid="cta-become-npc-guidebook"
    >
      <UserPlus className="w-6 h-6 text-nc-magenta shrink-0" />
      <span className="font-mono text-xs text-muted-foreground flex-1 min-w-0">
        {hasRole
          ? "You already have the NPC role — you're all set."
          : "Ready to play background characters? Grant yourself the NPC role instantly."}
      </span>
      <Button
        onClick={() => grant.mutate()}
        disabled={hasRole || isLoading || grant.isPending}
        className="rounded-none bg-nc-magenta hover:bg-nc-magenta/80 text-foreground font-display shrink-0 disabled:opacity-60"
        data-testid="button-become-npc-guidebook"
      >
        {hasRole ? "YOU'RE AN NPC" : grant.isPending ? "GRANTING..." : "BECOME AN NPC TODAY"}
      </Button>
    </div>
  );
}

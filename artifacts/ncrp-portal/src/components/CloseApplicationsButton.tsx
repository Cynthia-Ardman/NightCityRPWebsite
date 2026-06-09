import { useUpdateMission } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

// A fixer toggle for a live (posted) mission's player-application window.
//   Open    → PC applications accepted (NPC sign-ups also open)
//   Pending → PC applications closed (NPC sign-ups stay open)
// Flipping status moves the mission between the Open and Active browse tabs.
// Renders nothing for completed/cancelled missions, where the toggle is moot.
export function CloseApplicationsButton({
  missionId,
  status,
  onSuccess,
}: {
  missionId: number;
  status: string;
  onSuccess?: () => void;
}) {
  const update = useUpdateMission({ mutation: { onSuccess } });
  if (status !== "open" && status !== "pending") return null;
  const closing = status === "open";
  return (
    <Button
      type="button"
      size="sm"
      disabled={update.isPending}
      onClick={() =>
        update.mutate({ id: missionId, data: { status: closing ? "pending" : "open" } })
      }
      className={
        closing
          ? "rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display tracking-widest"
          : "rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest"
      }
      data-testid={`button-close-applications-${missionId}`}
    >
      {update.isPending
        ? "SAVING..."
        : closing
          ? "CLOSE PC APPLICATIONS"
          : "REOPEN PC APPLICATIONS"}
    </Button>
  );
}

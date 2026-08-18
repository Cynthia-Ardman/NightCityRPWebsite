import { useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage } from "@/lib/apiError";
import {
  useSignUpAsNpc,
  useSignUpAsEventNpc,
  getListMissionsQueryKey,
  getListEventsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

export type QuickNpcKind = "mission" | "event";

function msgOf(err: unknown): string {
  return apiErrorMessage(err, "Please try again later.");
}

// One-tap "sign up as an NPC" used by the calendar, the dashboard "NPCs needed"
// card, and the weekly session banner. Defaults to no specific character / no
// note (the detail page is where you pick a character). On success both the
// missions and events lists are invalidated so every surface — including the
// chip you tapped — flips to the "NPC" state immediately.
export function useQuickNpcSignup() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListMissionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListEventsQueryKey() });
  };
  const onSuccess = () => {
    invalidate();
    toast({ title: "You're signed up as an NPC", description: "See you there, choom." });
  };
  const onError = (err: unknown) =>
    toast({ title: "Couldn't sign up as NPC", description: msgOf(err), variant: "destructive" });

  const missionNpc = useSignUpAsNpc({ mutation: { onSuccess, onError } });
  const eventNpc = useSignUpAsEventNpc({ mutation: { onSuccess, onError } });

  // occurrenceStartAt targets one concrete occurrence of a recurring event
  // (ISO string); omitted = the event's current startAt (server default).
  const signUp = (kind: QuickNpcKind, id: number, occurrenceStartAt?: string) => {
    if (kind === "mission") missionNpc.mutate({ id, data: { characterId: null } });
    else eventNpc.mutate({ id, data: { characterId: null, note: null, occurrenceStartAt: occurrenceStartAt ?? null } });
  };

  const pendingKey =
    missionNpc.isPending && missionNpc.variables
      ? `mission-${missionNpc.variables.id}`
      : eventNpc.isPending && eventNpc.variables
        ? `event-${eventNpc.variables.id}`
        : null;

  return { signUp, pendingKey, isPending: missionNpc.isPending || eventNpc.isPending };
}

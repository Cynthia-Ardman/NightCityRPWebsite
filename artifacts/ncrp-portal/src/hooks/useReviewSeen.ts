import { useQueryClient } from "@tanstack/react-query";
import {
  useMarkReviewSeen,
  getGetReviewUnseenIdsQueryKey,
  getGetReviewUnseenCountsQueryKey,
  getGetMyUnseenQueryKey,
  getGetReviewUnreadDetailQueryKey,
  type ReviewUnseenIds,
  type ReviewUnseenCounts,
  type MyUnseen,
  type ReviewUnreadDetail,
} from "@workspace/api-client-react";

type SubjectType = "edit" | "request" | "sheet" | "lore";

// unseen-ids / my-unseen key the arrays by the singular subject type; the
// staff counts object keys the numbers by the plural form. Map between them so
// an optimistic clear updates every surface in one shot.
const COUNT_KEY: Record<SubjectType, keyof Pick<ReviewUnseenCounts, "edits" | "requests" | "sheets" | "lore">> = {
  edit: "edits",
  request: "requests",
  sheet: "sheets",
  lore: "lore",
};

// Marking a review subject "seen" must clear EVERY unread surface the instant
// the user opens it — the per-card magenta line + NEW dot (unseen-ids), the
// staff queue tab counts and sidebar badge (unseen-counts), and the player's
// "My Submissions" dots + nav badge (my-unseen). The generated markSeen mutation
// only updates the server, and the previous wiring forgot to refresh unseen-ids
// at all (so the line/dot lingered until a natural refetch) and waited on a
// network round-trip for the rest (so nothing cleared "instantly").
//
// This hook does an optimistic, simultaneous clear of all three caches, then
// fires the server mutation and reconciles every cache on settle. The optimistic
// edits only ever REMOVE the opened id / decrement counts when that id was
// actually present, so re-opening an already-seen item is a no-op and we never
// drive a badge negative.
export function useMarkReviewSeenInstant() {
  const qc = useQueryClient();
  const seen = useMarkReviewSeen();

  return (subjectType: SubjectType, subjectId: number) => {
    const idsKey = getGetReviewUnseenIdsQueryKey();
    const countsKey = getGetReviewUnseenCountsQueryKey();
    const myKey = getGetMyUnseenQueryKey();
    const unreadDetailKey = getGetReviewUnreadDetailQueryKey();

    // (1) Per-card dots/line (reviewer view). Track whether this id was actually
    // unseen so we only decrement the matching count when it was.
    let wasReviewerUnseen = false;
    qc.setQueryData<ReviewUnseenIds>(idsKey, (old) => {
      if (!old) return old;
      const arr = old[subjectType] ?? [];
      if (!arr.includes(subjectId)) return old;
      wasReviewerUnseen = true;
      return { ...old, [subjectType]: arr.filter((x) => x !== subjectId) };
    });

    // (2) Staff tab counts + sidebar badge — decrement only if it was counted.
    if (wasReviewerUnseen) {
      qc.setQueryData<ReviewUnseenCounts>(countsKey, (old) => {
        if (!old) return old;
        const k = COUNT_KEY[subjectType];
        return {
          ...old,
          [k]: Math.max(0, (old[k] ?? 0) - 1),
          total: Math.max(0, (old.total ?? 0) - 1),
        };
      });
    }

    // (3) Player "My Submissions" dots + nav badge (submitter view).
    qc.setQueryData<MyUnseen>(myKey, (old) => {
      if (!old) return old;
      const arr = old[subjectType] ?? [];
      if (!arr.includes(subjectId)) return old;
      return {
        ...old,
        [subjectType]: arr.filter((x) => x !== subjectId),
        total: Math.max(0, (old.total ?? 0) - 1),
      };
    });

    // (4) Per-card VIEW & RESPOND discussion-unread badge — opening the ticket
    // (which is what calls this) marks it seen, so its unread comment count
    // drops to 0 immediately instead of waiting for a refetch.
    qc.setQueryData<ReviewUnreadDetail>(unreadDetailKey, (old) => {
      if (!old) return old;
      const map = old[subjectType] ?? {};
      if (!(subjectId in map)) return old;
      const next = { ...map };
      delete next[subjectId];
      return { ...old, [subjectType]: next };
    });

    // Persist server-side, then reconcile every surface against the source of
    // truth (covers the case where another tab/device changed the state).
    seen.mutate(
      { subjectType, id: subjectId },
      {
        onSettled: () => {
          qc.invalidateQueries({ queryKey: idsKey });
          qc.invalidateQueries({ queryKey: countsKey });
          qc.invalidateQueries({ queryKey: myKey });
          qc.invalidateQueries({ queryKey: unreadDetailKey });
        },
      },
    );
  };
}

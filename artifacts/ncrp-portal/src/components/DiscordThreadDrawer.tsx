import { useEffect, useMemo, useState } from "react";
import {
  useGetReviewDiscordThread,
  getGetReviewDiscordThreadQueryKey,
  type DiscordThreadMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Hash } from "lucide-react";
import DiscordThreadPanel from "@/components/DiscordThreadPanel";

type SubjectType = "edit" | "request" | "sheet";

const seenKey = (t: SubjectType, id: number) => `discordThreadSeen:${t}:${id}`;

// Newest message timestamp (ms) in a thread payload, 0 when empty/unlinked.
function newestMs(messages: DiscordThreadMessage[]): number {
  let max = 0;
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

// Pop-out wrapper around the read-only DiscordThreadPanel. Renders a button that
// slides the cs-approver thread mirror in from the right edge, so reviewers can
// read it without scrolling the ticket — and dismiss it just as easily. STAFF
// ONLY: gate the mount like the inline panel (the server endpoint is
// reviewer-gated regardless).
//
// The panel — and its 15s polling query — only mounts while the drawer is open,
// so a queue full of these buttons never fires one poll per card.
//
// `watchUnread` opts a button in to a lightweight background poll of the thread
// so it can flash gold when a Discord reply has arrived since the reviewer last
// opened it. It is safe on a queue of cards: the server caches each thread for
// ~8s keyed by thread id (shared across cards and reviewers), so N polling
// cards collapse to at most one Discord fetch per thread per cache window.
// "Seen" is tracked per-browser in localStorage (there is no server-side seen
// state for the Discord mirror), and is advanced whenever the drawer is open.
export default function DiscordThreadDrawer({
  subjectType,
  subjectId,
  buttonLabel = "DISCORD THREAD",
  buttonClassName,
  iconOnly = false,
  watchUnread = false,
}: {
  subjectType: SubjectType;
  subjectId: number;
  buttonLabel?: string;
  buttonClassName?: string;
  iconOnly?: boolean;
  watchUnread?: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Background poll (shares the panel's query key, so when the drawer is open
  // there is still only one in-flight request). Disabled unless opted in.
  const { data: watchData } = useGetReviewDiscordThread(subjectType, subjectId, {
    query: {
      queryKey: getGetReviewDiscordThreadQueryKey(subjectType, subjectId),
      refetchInterval: 30_000,
      enabled: watchUnread,
    },
  });

  const newest = useMemo(
    () => newestMs((watchData?.messages ?? []) as DiscordThreadMessage[]),
    [watchData],
  );

  const [seen, setSeen] = useState<number>(() => {
    if (typeof window === "undefined") return 0;
    return Number(window.localStorage.getItem(seenKey(subjectType, subjectId)) ?? 0);
  });

  // Reload the seen marker when the subject changes (route-param navigation
  // between tickets keeps this component mounted), so unread state doesn't leak
  // from the previously-viewed ticket.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSeen(Number(window.localStorage.getItem(seenKey(subjectType, subjectId)) ?? 0));
  }, [subjectType, subjectId]);

  const unread = watchUnread && newest > 0 && newest > seen;

  // Mark the thread read whenever it is open and newer than what we've seen.
  useEffect(() => {
    if (open && newest > seen) {
      window.localStorage.setItem(seenKey(subjectType, subjectId), String(newest));
      setSeen(newest);
    }
  }, [open, newest, seen, subjectType, subjectId]);

  const baseClassName =
    buttonClassName ??
    "rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-display text-xs tracking-widest h-8 shrink-0";
  // Gold flash for an unread reply. Ring + glow + pulse read clearly even when
  // the base button keeps its magenta border.
  const flashClassName = unread
    ? "border-nc-yellow text-nc-yellow ring-2 ring-nc-yellow shadow-[0_0_12px_rgba(255,255,0,0.75)] animate-pulse"
    : "";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`${baseClassName} ${flashClassName}`.trim()}
          data-testid={`button-discord-thread-${subjectType}-${subjectId}`}
        >
          <Hash className={iconOnly ? "w-4 h-4" : "w-3 h-3 mr-1"} />
          {iconOnly ? <span className="sr-only">{buttonLabel}</span> : buttonLabel}
          {unread && (
            <span
              className="ml-2 inline-block w-2 h-2 rounded-full bg-nc-yellow shadow-[0_0_6px_rgba(255,255,0,0.9)]"
              data-testid={`discord-thread-unread-${subjectType}-${subjectId}`}
            />
          )}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto p-0 bg-background border-l-nc-magenta/60"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>CS-Approver Discord Thread</SheetTitle>
        </SheetHeader>
        <div className="p-4 pt-12">
          {open && <DiscordThreadPanel subjectType={subjectType} subjectId={subjectId} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

import { useEffect, useMemo, useState } from "react";
import {
  useGetReviewDiscordThread,
  getGetReviewDiscordThreadQueryKey,
  type DiscordThreadMessage,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Hash, ChevronDown, ChevronUp } from "lucide-react";
import DiscordThreadPanel from "@/components/DiscordThreadPanel";
import { useMarkReviewSeenInstant } from "@/hooks/useReviewSeen";

type SubjectType = "edit" | "request" | "sheet" | "mission";

// The server tracks "seen" only for review subjects; missions have no review
// unread state, so opening a mission thread never marks anything seen.
const REVIEW_SUBJECTS = ["edit", "request", "sheet"] as const;
function isReviewSubject(t: SubjectType): t is "edit" | "request" | "sheet" {
  return (REVIEW_SUBJECTS as readonly string[]).includes(t);
}

const seenKey = (t: SubjectType, id: number) => `discordThreadSeen:${t}:${id}`;

// Read the persisted "seen" timestamp (ms). A missing/corrupt value must read
// as 0 (everything unread-eligible), never NaN — `newest > NaN` is always false,
// which would silently suppress the glow forever.
function readSeen(t: SubjectType, id: number): number {
  if (typeof window === "undefined") return 0;
  const n = Number(window.localStorage.getItem(seenKey(t, id)) ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Newest HUMAN (non-bot) message timestamp (ms) in a thread payload; 0 when
// there are no human messages (empty/unlinked, or only the bot's posts).
//
// The unread glow must reflect "a real reply a reviewer hasn't read yet", so
// bot-authored posts are deliberately excluded:
//   - the thread's INITIAL message is the bot's mirror post — a brand-new thread
//     with only that message must NOT glow;
//   - later bot status mirrors (website-originated) would otherwise bump the
//     newest timestamp above the seen marker and re-trigger the glow on refresh
//     even though nothing new was actually said in Discord.
function newestHumanMs(messages: DiscordThreadMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (m.authorIsBot) continue;
    const t = new Date(m.createdAt).getTime();
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

// Expandable wrapper around the read-only DiscordThreadPanel. Renders a button
// that toggles the cs-approver thread mirror open INLINE below the button row
// (matching the "PLAYER COMMUNICATION" expand-below pattern). The panel itself
// carries the "OPEN IN DISCORD" link for replying. STAFF ONLY: gate the mount
// like the inline panel (the server endpoint is reviewer-gated regardless).
//
// The panel — and its 15s polling query — only mounts while expanded, so a
// queue full of these buttons never fires one poll per card.
//
// Layout contract: callers place this inside a `flex flex-wrap` button row; the
// expanded panel uses `basis-full` to wrap onto its own full-width line.
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
  const markSeen = useMarkReviewSeenInstant();

  // Expanding the thread is a reviewer's "I read this" action, so it must clear
  // the SERVER unread state (per-card line/dot, queue counts, sidebar badge) the
  // same way expanding the inline discussion does — not just the localStorage
  // Discord glow below. Missions have no review unread state, so they no-op.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && isReviewSubject(subjectType)) markSeen(subjectType, subjectId);
  };

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
    () => newestHumanMs((watchData?.messages ?? []) as DiscordThreadMessage[]),
    [watchData],
  );

  const [seen, setSeen] = useState<number>(() => readSeen(subjectType, subjectId));

  // Reload the seen marker when the subject changes (route-param navigation
  // between tickets keeps this component mounted), so unread state doesn't leak
  // from the previously-viewed ticket.
  useEffect(() => {
    setSeen(readSeen(subjectType, subjectId));
  }, [subjectType, subjectId]);

  // Count of HUMAN (non-bot) Discord messages newer than the reviewer's
  // per-browser seen marker — the number shown on the button. Bot posts are
  // excluded for the same reasons newestHumanMs excludes them (initial mirror
  // post + website-originated status mirrors are not "new replies to read").
  const unreadCount = useMemo(() => {
    if (!watchUnread) return 0;
    let n = 0;
    for (const m of (watchData?.messages ?? []) as DiscordThreadMessage[]) {
      if (m.authorIsBot) continue;
      const t = new Date(m.createdAt).getTime();
      if (Number.isFinite(t) && t > seen) n++;
    }
    return n;
  }, [watchData, seen, watchUnread]);

  const unread = unreadCount > 0;

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
    <>
      <Button
        variant="outline"
        size="sm"
        className={`${baseClassName} ${flashClassName}`.trim()}
        onClick={() => handleOpenChange(!open)}
        data-testid={`button-discord-thread-${subjectType}-${subjectId}`}
      >
        <Hash className={iconOnly ? "w-4 h-4" : "w-3 h-3 mr-1"} />
        {iconOnly ? <span className="sr-only">{buttonLabel}</span> : buttonLabel}
        {unread && (
          <span
            className="ml-2 inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full bg-nc-yellow text-background font-mono text-[10px] font-bold shadow-[0_0_6px_rgba(255,255,0,0.9)]"
            data-testid={`discord-thread-unread-${subjectType}-${subjectId}`}
          >
            {unreadCount}
          </span>
        )}
        {!iconOnly &&
          (open ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />)}
      </Button>
      {open && (
        <div className="w-full basis-full" data-testid={`discord-thread-inline-${subjectType}-${subjectId}`}>
          <DiscordThreadPanel subjectType={subjectType} subjectId={subjectId} />
        </div>
      )}
    </>
  );
}

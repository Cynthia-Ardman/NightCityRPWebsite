import { formatDate } from "@/lib/format";
import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  getListNotificationsQueryKey,
  useGetNotificationsUnreadCount,
  getGetNotificationsUnreadCountQueryKey,
  useMarkNotificationsRead,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Bell } from "lucide-react";

// Relative "3m ago" style timestamp for the feed rows.
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return formatDate(iso);
}

/**
 * Notification bell with unread badge + dropdown feed. Rendered in both the
 * desktop TopBar and the mobile header. Opening the dropdown marks everything
 * read (the badge is a "something new" signal, not a per-item unread tracker);
 * each row deep-links to its subject page when the server provided a href.
 */
export function NotificationBell() {
  const { data: user } = useEffectiveMe();
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();

  const { data: unread } = useGetNotificationsUnreadCount({
    query: {
      enabled: !!user,
      queryKey: getGetNotificationsUnreadCountQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    },
  });
  const { data: page, isLoading } = useListNotifications(
    { limit: 20 },
    {
      query: {
        enabled: !!user && open,
        queryKey: getListNotificationsQueryKey({ limit: 20 }),
      },
    },
  );
  const markRead = useMarkNotificationsRead({
    mutation: {
      onSettled: () => {
        void qc.invalidateQueries({ queryKey: getGetNotificationsUnreadCountQueryKey() });
        void qc.invalidateQueries({ queryKey: getListNotificationsQueryKey({ limit: 20 }) });
      },
    },
  });

  const count = unread?.count ?? 0;

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Mark everything read when the feed is opened — the badge means "new
    // since you last looked", so looking clears it. Fire unconditionally: the
    // polled badge count can be stale (60s), so gating on count > 0 would skip
    // freshly arrived unread rows and leave a phantom badge later.
    if (next) {
      markRead.mutate({ data: { all: true } });
    }
  }

  if (!user) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative border-nc-cyan/50 text-nc-cyan hover:text-nc-cyan hover:border-nc-cyan"
          aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
          data-testid="button-notifications"
        >
          <Bell className="h-5 w-5" />
          {count > 0 && (
            <span
              className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-nc-magenta text-white font-mono text-[10px] font-bold leading-none shadow-[0_0_8px_rgba(255,0,128,0.6)]"
              data-testid="badge-notifications-unread"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 sm:w-96 p-0 border-nc-cyan/40 bg-card/95 backdrop-blur-sm"
        data-testid="dropdown-notifications"
      >
        <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
          <span className="font-display text-xs tracking-widest uppercase text-nc-cyan">
            Notifications
          </span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {isLoading && (
            <div className="px-4 py-6 font-mono text-xs text-muted-foreground text-center">
              Loading…
            </div>
          )}
          {!isLoading && (page?.items?.length ?? 0) === 0 && (
            <div className="px-4 py-6 font-mono text-xs text-muted-foreground text-center" data-testid="text-notifications-empty">
              No notifications yet.
            </div>
          )}
          {page?.items?.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                setOpen(false);
                if (n.href) navigate(n.href);
              }}
              className={`w-full text-left px-4 py-3 border-b border-border/60 last:border-b-0 transition-colors hover:bg-nc-cyan/10 ${
                n.readAt ? "" : "bg-nc-cyan/5"
              } ${n.href ? "cursor-pointer" : "cursor-default"}`}
              data-testid={`notification-item-${n.id}`}
            >
              <div className="flex items-start gap-2">
                {!n.readAt && (
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-nc-magenta" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-foreground leading-snug">{n.title}</div>
                  {n.body && (
                    <div className="font-mono text-xs text-muted-foreground mt-0.5 line-clamp-2 whitespace-pre-line">
                      {n.body}
                    </div>
                  )}
                  <div className="font-mono text-[10px] text-muted-foreground/70 mt-1 uppercase tracking-wider">
                    {timeAgo(n.createdAt)}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

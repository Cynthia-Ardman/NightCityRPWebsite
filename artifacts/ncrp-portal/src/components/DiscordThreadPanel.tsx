import {
  useGetReviewDiscordThread,
  getGetReviewDiscordThreadQueryKey,
  type DiscordThreadMessage,
} from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Hash, ExternalLink } from "lucide-react";
import { handleDiscordLinkClick } from "@/lib/discordDeepLink";

type SubjectType = "edit" | "request" | "sheet" | "mission";

// READ-ONLY mirror of a ticket's cs-approver Discord thread, shown on the
// review detail page. STAFF ONLY — gate the mount on the reviewer flags, this
// component assumes the caller already checked. The portal NEVER posts to
// Discord; there is deliberately no compose box here. Discussion that should
// reach the submitter goes through ReviewCommentThread instead.
export default function DiscordThreadPanel({
  subjectType,
  subjectId,
}: {
  subjectType: SubjectType;
  subjectId: number;
}) {
  const { data, isLoading } = useGetReviewDiscordThread(subjectType, subjectId, {
    query: {
      queryKey: getGetReviewDiscordThreadQueryKey(subjectType, subjectId),
      // Thread is mirrored from Discord; poll so new replies surface without a
      // manual refresh. Server already caches, so this stays cheap.
      refetchInterval: 15_000,
    },
  });

  const messages = (data?.messages ?? []) as DiscordThreadMessage[];
  const webUrl = data?.webUrl ?? null;

  return (
    <Card className="rounded-none border-nc-magenta/60 bg-card/40" data-testid={`discord-thread-${subjectType}-${subjectId}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="font-display text-sm tracking-widest text-nc-magenta flex items-center gap-2">
            <Hash className="w-4 h-4" /> CS-APPROVER THREAD
          </CardTitle>
          {webUrl ? (
            <Button
              asChild
              size="sm"
              variant="outline"
              className="rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-mono text-[10px] h-7"
            >
              <a
                href={webUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => handleDiscordLinkClick(e, webUrl)}
                data-testid="button-open-discord-thread"
              >
                <ExternalLink className="w-3 h-3 mr-1" /> OPEN IN DISCORD
              </a>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="font-mono text-[10px] text-muted-foreground/70 uppercase tracking-wider">
          Read-only mirror — reply in Discord.
        </p>
        {isLoading ? (
          <div className="font-mono text-xs text-muted-foreground animate-pulse">LOADING THREAD...</div>
        ) : !data?.linked ? (
          <div className="font-mono text-xs text-muted-foreground italic" data-testid="discord-thread-unlinked">
            No Discord thread linked to this ticket yet.
          </div>
        ) : messages.length === 0 ? (
          <div className="font-mono text-xs text-muted-foreground italic" data-testid="discord-thread-empty">
            No messages in the thread yet.
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <div key={m.id} className="flex gap-3" data-testid={`discord-message-${m.id}`}>
                <Avatar className="h-7 w-7 rounded-none border border-border shrink-0">
                  <AvatarImage src={m.authorAvatarUrl ?? ""} />
                  <AvatarFallback className="bg-background text-nc-magenta rounded-none text-[10px]">
                    {(m.authorName || "?").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground font-bold truncate">{m.authorName || m.authorId}</span>
                    {m.authorIsBot ? (
                      <span className="text-nc-cyan uppercase tracking-widest text-[9px] border border-nc-cyan/50 px-1">
                        Bot
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="font-mono text-sm text-foreground/90 whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-0.5">
                    {m.content}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

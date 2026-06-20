import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListReviewComments,
  usePostReviewComment,
  getListReviewCommentsQueryKey,
  getGetReviewUnseenIdsQueryKey,
  getGetReviewUnseenCountsQueryKey,
  getGetMyUnseenQueryKey,
  type ReviewComment,
} from "@workspace/api-client-react";
import { useMarkReviewSeenInstant } from "@/hooks/useReviewSeen";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import MentionTextarea from "@/components/MentionTextarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquare, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffectiveMe } from "@/contexts/ViewAsContext";

type SubjectType = "edit" | "request" | "sheet" | "lore";

// Two-way discussion thread shared by every review queue (character edits,
// custom requests, sheets). Posting a comment NEVER changes the subject's
// status, so a comment can never block an approval — it's purely a back-and-
// forth between the submitter and reviewers. Mounting the thread also marks
// the subject seen for the current user (drives the unseen notification
// counts), unless `markSeenOnMount` is disabled.
export default function ReviewCommentThread({
  subjectType,
  subjectId,
  markSeenOnMount = true,
}: {
  subjectType: SubjectType;
  subjectId: number;
  markSeenOnMount?: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [body, setBody] = useState("");
  // Mention/channel autocomplete hits staff-only Discord lookups, so only enable
  // it for fixers/admins. Everyone else gets a plain textarea.
  const { data: me } = useEffectiveMe();
  const canMention = !!(me?.isAdmin || me?.isFixer);

  const { data: comments, isLoading } = useListReviewComments(subjectType, subjectId, {
    query: { queryKey: getListReviewCommentsQueryKey(subjectType, subjectId) },
  });

  // Optimistic, all-surfaces clear (per-card line/dot, staff counts + sidebar,
  // player My-Requests dots/badge) so the unread markers vanish the instant the
  // thread opens instead of after a refetch.
  const markSeen = useMarkReviewSeenInstant();

  // Mark seen once when the thread opens. Run on id change so re-using the
  // component for a different subject re-marks correctly.
  useEffect(() => {
    if (!markSeenOnMount) return;
    markSeen(subjectType, subjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectType, subjectId, markSeenOnMount]);

  const post = usePostReviewComment({
    mutation: {
      onSuccess: () => {
        setBody("");
        qc.invalidateQueries({ queryKey: getListReviewCommentsQueryKey(subjectType, subjectId) });
        qc.invalidateQueries({ queryKey: getGetReviewUnseenIdsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetReviewUnseenCountsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetMyUnseenQueryKey() });
      },
      onError: (err) => {
        const msg = (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ?? "Could not post comment";
        toast({ title: "Comment failed", description: msg, variant: "destructive" });
      },
    },
  });

  const trimmed = body.trim();
  const list = (comments ?? []) as ReviewComment[];

  return (
    <Card className="rounded-none border-nc-cyan/60 bg-card/40" data-testid={`review-thread-${subjectType}-${subjectId}`}>
      <CardHeader className="pb-2">
        <CardTitle className="font-display text-sm tracking-widest text-nc-cyan flex items-center gap-2">
          <MessageSquare className="w-4 h-4" /> DISCUSSION
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="font-mono text-xs text-muted-foreground animate-pulse">LOADING THREAD...</div>
        ) : list.length === 0 ? (
          <div className="font-mono text-xs text-muted-foreground italic" data-testid="review-thread-empty">
            No messages yet. Start the conversation — comments never block approval.
          </div>
        ) : (
          <div className="space-y-3">
            {list.map((c) => (
              <div key={c.id} className="flex gap-3" data-testid={`review-comment-${c.id}`}>
                <Avatar className="h-7 w-7 rounded-none border border-border shrink-0">
                  <AvatarImage src={c.authorAvatarUrl ?? ""} />
                  <AvatarFallback className="bg-background text-nc-cyan rounded-none text-[10px]">
                    {(c.authorName ?? "?").substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-[11px]">
                    <span className="text-foreground font-bold truncate">{c.authorName ?? c.authorId}</span>
                    {c.isReviewer ? (
                      <span className="text-nc-yellow uppercase tracking-widest text-[9px] border border-nc-yellow/50 px-1">
                        Fixer
                      </span>
                    ) : (
                      <span className="text-nc-green uppercase tracking-widest text-[9px] border border-nc-green/50 px-1">
                        Player
                      </span>
                    )}
                    <span className="text-muted-foreground">{new Date(c.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="font-mono text-sm text-foreground/90 whitespace-pre-wrap break-words [overflow-wrap:anywhere] mt-0.5">
                    {c.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2 border-t border-border/40 pt-3">
          <MentionTextarea
            value={body}
            onChange={setBody}
            enableMentions={canMention}
            placeholder={canMention ? "Write a message…  @ to mention, # for a channel" : "Write a message..."}
            rows={2}
            maxLength={4000}
            testId="input-review-comment"
          />
          <Button
            onClick={() => post.mutate({ subjectType, id: subjectId, data: { body: trimmed } })}
            disabled={post.isPending || trimmed.length === 0}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
            data-testid="button-post-review-comment"
          >
            <Send className="w-4 h-4 mr-1" /> {post.isPending ? "SENDING..." : "SEND"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// Small banner shown to a reviewer when a subject is awaiting their action
// (they can still vote and haven't yet). Comments never gate this — it's about
// the vote/decision only.
export function AwaitingVoteBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      className="border border-nc-yellow bg-nc-yellow/10 text-nc-yellow px-4 py-2 font-mono text-xs tracking-wider flex items-center gap-2 animate-pulse"
      data-testid="banner-awaiting-vote"
    >
      <MessageSquare className="w-4 h-4" /> AWAITING YOUR VOTE — this item is in your review queue and you haven't voted yet.
    </div>
  );
}

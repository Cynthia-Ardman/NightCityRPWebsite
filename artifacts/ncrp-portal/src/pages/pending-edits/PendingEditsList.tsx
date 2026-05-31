import { Link } from "wouter";
import { useListPendingEdits } from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, CheckCircle2, XCircle, Clock, MessageSquareWarning } from "lucide-react";

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none font-mono text-xs animate-pulse">
          <Clock className="w-3 h-3 mr-1" /> PENDING
        </Badge>
      );
    case "approved":
      return (
        <Badge variant="outline" className="border-nc-green text-nc-green rounded-none font-mono text-xs">
          <CheckCircle2 className="w-3 h-3 mr-1" /> APPROVED
        </Badge>
      );
    case "rejected":
      return (
        <Badge variant="outline" className="border-destructive text-destructive rounded-none font-mono text-xs">
          <XCircle className="w-3 h-3 mr-1" /> REJECTED
        </Badge>
      );
    case "changes_requested":
      return (
        <Badge variant="outline" className="border-nc-magenta text-nc-magenta rounded-none font-mono text-xs">
          <MessageSquareWarning className="w-3 h-3 mr-1" /> CHANGES REQ
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="border-muted-foreground text-muted-foreground rounded-none font-mono text-xs">
          CANCELLED
        </Badge>
      );
    default:
      return <Badge variant="outline" className="rounded-none font-mono text-xs">{status}</Badge>;
  }
}

export default function PendingEditsList({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: edits, isLoading } = useListPendingEdits();
  return (
    <div className={embedded ? "space-y-6" : "max-w-5xl mx-auto p-6 space-y-6"}>
      {!embedded && (
        <div className="border-b border-border pb-4">
          <h1 className="font-display text-3xl tracking-widest text-nc-cyan flex items-center gap-2">
            <ShieldAlert className="w-7 h-7" /> CHARACTER EDIT QUEUE
          </h1>
          <p className="font-mono text-xs text-muted-foreground mt-2 leading-relaxed">
            Edits to characters require a majority of fixers / approvers / admins to sign off before they apply.
            Submitters cannot vote on their own edits.
            <br />
            <span className="text-muted-foreground/80">
              Reviewers see every pending edit. Players see only their own submissions and can withdraw them from the detail view.
            </span>
          </p>
        </div>
      )}
      {isLoading ? (
        <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
      ) : !edits || edits.length === 0 ? (
        <div className="font-mono text-sm text-muted-foreground italic border border-border p-6 bg-card/30">
          No pending edits.
        </div>
      ) : (
        <div className="space-y-2" data-testid="pending-edits-list">
          {edits.map((e) => {
            const changed = e.proposedDiff ? Object.keys(e.proposedDiff) : [];
            return (
              <Link key={e.id} href={`/pending-edits/${e.id}`}>
                <a
                  className="block border border-border hover:border-nc-cyan bg-card/30 hover:bg-card/60 p-4 transition-colors"
                  data-testid={`pending-edit-row-${e.id}`}
                >
                  <div className="flex items-center gap-4">
                    <Avatar className="h-10 w-10 rounded-none border border-border">
                      <AvatarImage src={e.submitterAvatarUrl ?? ""} />
                      <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-xs">
                        {(e.submitterName ?? "?").substring(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="font-display text-lg text-foreground truncate">
                        {e.characterName}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        by {e.submitterName ?? "(unknown)"} · {new Date(e.submittedAt).toLocaleString()}
                      </div>
                      {changed.length > 0 && (
                        <div className="font-mono text-xs text-nc-cyan/70 mt-1">
                          {changed.length} field{changed.length === 1 ? "" : "s"}: {changed.join(", ")}
                        </div>
                      )}
                      {e.updateNote && (
                        <div className="font-mono text-xs text-foreground/80 italic mt-1 line-clamp-1">
                          "{e.updateNote}"
                        </div>
                      )}
                      {e.status === "pending" && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5" data-testid={`pending-edit-tally-${e.id}`}>
                          <span className="font-mono text-xs text-nc-green">
                            {e.approveCount}/{e.threshold} approve
                          </span>
                          {e.rejectCount > 0 && (
                            <span className="font-mono text-xs text-destructive">
                              {e.rejectCount} reject
                            </span>
                          )}
                          {e.voters.length === 0 ? (
                            <span className="font-mono text-xs text-muted-foreground italic">no votes yet</span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1">
                              {e.voters.map((v, i) => (
                                <Badge
                                  key={`${e.id}-${v.name}-${i}`}
                                  variant="outline"
                                  className={`rounded-none font-mono text-[10px] ${
                                    v.vote === "approve"
                                      ? "border-nc-green/60 text-nc-green"
                                      : "border-destructive/60 text-destructive"
                                  }`}
                                >
                                  {v.vote === "approve" ? (
                                    <CheckCircle2 className="w-3 h-3 mr-1" />
                                  ) : (
                                    <XCircle className="w-3 h-3 mr-1" />
                                  )}
                                  {v.name}
                                </Badge>
                              ))}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0">{statusBadge(e.status)}</div>
                  </div>
                </a>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

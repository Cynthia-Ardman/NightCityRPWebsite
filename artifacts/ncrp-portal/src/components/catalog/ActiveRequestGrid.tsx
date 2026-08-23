import { ArrowUpRight, CalendarDays, MessageSquareText, UserRound } from "lucide-react";
import { Link } from "wouter";
import type { CustomRequest } from "@workspace/api-client-react";
import { formatDate } from "@/lib/format";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";

const TERMINAL_REQUEST_STATUSES = new Set(["rejected", "closed", "cancelled"]);

function requestTypeLabel(type: CustomRequest["type"]) {
  switch (type) {
    case "cyberware":
      return "Cyberware";
    case "ripperdoc":
      return "Ripperdoc";
    case "stock_cost":
      return "Stock cost";
    default:
      return type.charAt(0).toUpperCase() + type.slice(1);
  }
}

export function activeCustomRequests(requests: CustomRequest[]) {
  return requests.filter(
    (request) => !TERMINAL_REQUEST_STATUSES.has(request.status.toLowerCase()),
  );
}

export function ActiveRequestGrid({ requests }: { requests: CustomRequest[] }) {
  const activeRequests = activeCustomRequests(requests);

  if (activeRequests.length === 0) return null;

  return (
    <section
      className="border border-border bg-card/20 p-4 sm:p-5 space-y-4"
      data-testid="active-request-grid"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-sm tracking-widest text-nc-cyan uppercase">
            Your Active Requests
          </p>
          <p className="font-mono text-xs text-muted-foreground mt-1">
            Track drafts, reviews, and anything that needs your attention.
          </p>
        </div>
        <Link
          href="/submissions"
          className="inline-flex items-center gap-1.5 font-display text-[11px] tracking-widest text-nc-cyan hover:text-foreground transition-colors"
          data-testid="link-view-all-requests"
        >
          VIEW ALL <ArrowUpRight className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-3">
        {activeRequests.map((request) => (
          <article
            key={request.id}
            className="group min-w-0 border border-border/70 bg-background/35 p-4 flex min-h-44 flex-col transition-colors hover:border-nc-cyan/70 hover:bg-card/55"
            data-testid={`my-request-row-${request.id}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[10px] tracking-widest text-nc-cyan uppercase">
                  {requestTypeLabel(request.type)} Request
                </p>
                <h3
                  className="mt-1 font-display text-base leading-tight text-foreground break-words"
                  title={request.title}
                >
                  {request.title}
                </h3>
              </div>
              <div className="shrink-0">
                <RequestStatusBadge status={request.status} stagedApproval />
              </div>
            </div>

            <div className="mt-4 grid gap-2 font-mono text-[11px] text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <UserRound className="h-3.5 w-3.5 shrink-0 text-nc-cyan/80" />
                <span className="truncate">{request.characterName}</span>
              </div>
              <div className="flex items-center gap-2">
                <CalendarDays className="h-3.5 w-3.5 shrink-0 text-nc-cyan/80" />
                <span>
                  {request.status === "draft" ? "Created" : "Submitted"}{" "}
                  {formatDate(request.createdAt)}
                </span>
              </div>
              {request.reviewerNote ? (
                <div className="flex min-w-0 items-start gap-2 border-l border-nc-magenta/50 pl-2 text-foreground/80">
                  <MessageSquareText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-nc-magenta" />
                  <span className="line-clamp-2 break-words">“{request.reviewerNote}”</span>
                </div>
              ) : null}
            </div>

            <Link
              href={`/submissions?focus=request-${request.id}`}
              className="mt-auto pt-4 inline-flex items-center gap-1.5 self-start font-display text-[10px] tracking-widest text-muted-foreground transition-colors group-hover:text-nc-cyan"
              data-testid={`link-request-details-${request.id}`}
            >
              OPEN REQUEST <ArrowUpRight className="w-3 h-3" />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}
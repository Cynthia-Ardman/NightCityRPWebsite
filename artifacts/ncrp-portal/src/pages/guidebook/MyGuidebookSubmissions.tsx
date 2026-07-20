import { formatDate } from "@/lib/format";
import { Link } from "wouter";
import { useListMyGuidebookEdits, type GuidebookPendingEdit, type GuidebookPageUpdate } from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";
import { BookMarked, ArrowLeft } from "lucide-react";

function pageNameOf(edit: GuidebookPendingEdit): string {
  const diff = (edit.proposedDiff ?? {}) as GuidebookPageUpdate;
  return (diff.title as string) || edit.pageTitle || "New guidebook page";
}

export default function MyGuidebookSubmissions() {
  const { data: me } = useAuthMe();
  const { data, isLoading } = useListMyGuidebookEdits();
  const edits = (data ?? []) as GuidebookPendingEdit[];

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto pb-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1
            className="text-4xl font-display font-bold text-foreground flex items-center gap-3"
            data-testid="text-my-guidebook-title"
          >
            <BookMarked className="w-8 h-8 text-nc-cyan" /> MY GUIDEBOOK SUBMISSIONS
          </h1>
          <p className="text-muted-foreground font-mono mt-2">
            Every guidebook page and edit you've proposed — with the admin's decision and notes.
          </p>
        </div>
        <Link href="/guidebook">
          <Button variant="outline" className="rounded-none font-display" data-testid="button-back-to-guidebook">
            <ArrowLeft className="w-4 h-4 mr-2" /> GUIDEBOOK
          </Button>
        </Link>
      </div>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest text-nc-cyan">SUBMISSION HISTORY</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!me ? (
            <div className="py-16 text-center text-muted-foreground font-mono text-sm">
              Log in to see your submissions.
            </div>
          ) : isLoading ? (
            <div className="py-16 text-center text-nc-cyan animate-pulse font-display">LOADING...</div>
          ) : edits.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground font-mono text-sm">
              You haven't proposed any guidebook changes yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[720px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3">Type</th>
                    <th className="text-left p-3">Page</th>
                    <th className="text-left p-3">Submitted</th>
                    <th className="text-left p-3">Decided</th>
                    <th className="text-left p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {edits.map((e) => (
                    <tr
                      key={e.id}
                      className="border-b border-border/30 hover:bg-card/80 align-top"
                      data-testid={`row-my-guidebook-${e.id}`}
                    >
                      <td className="p-3 font-bold whitespace-nowrap text-nc-magenta">
                        {e.kind.toUpperCase()}
                      </td>
                      <td className="p-3">
                        {e.status === "approved" && e.appliedPageId ? (
                          <Link
                            href={`/guidebook/${e.appliedPageId}`}
                            className="text-foreground hover:text-nc-cyan underline-offset-2 hover:underline"
                            data-testid={`link-my-guidebook-page-${e.id}`}
                          >
                            {pageNameOf(e)}
                          </Link>
                        ) : (
                          <span className="text-foreground">{pageNameOf(e)}</span>
                        )}
                        {e.decisionSummary ? (
                          <div className="text-[11px] text-muted-foreground italic mt-0.5">
                            "{e.decisionSummary}"
                          </div>
                        ) : null}
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {formatDate(e.createdAt)}
                      </td>
                      <td className="p-3 text-muted-foreground whitespace-nowrap">
                        {e.decidedAt ? formatDate(e.decidedAt) : "—"}
                      </td>
                      <td className="p-3">
                        <RequestStatusBadge status={e.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

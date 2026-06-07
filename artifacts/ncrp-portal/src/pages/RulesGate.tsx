import { useMemo } from "react";
import {
  useListGuidebook,
  useGetGuidebookPage,
  getGetGuidebookPageQueryKey,
  useAcceptRules,
  getGetMeQueryKey,
  type Me,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import Markdown from "@/components/Markdown";
import { ScrollText, Check, LogOut } from "lucide-react";

// Guidebook section key that holds the server rules (RP Rules, Avatar
// Restrictions, …). The splash renders every page in this section so it always
// mirrors the live rules without duplicating their text.
const RULES_SECTION_KEY = "rules";

// One rules page rendered inline. Fetched individually so we always get the full
// `body` markdown regardless of what the section listing returns.
function RulesPageBlock({ id }: { id: number }) {
  const { data: page } = useGetGuidebookPage(id, {
    query: { queryKey: getGetGuidebookPageQueryKey(id) },
  });
  if (!page) {
    return (
      <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
    );
  }
  return (
    <section className="space-y-2" data-testid={`rules-page-${id}`}>
      <h2 className="font-display text-lg text-nc-cyan">{page.title}</h2>
      {page.description ? (
        <p className="font-sans text-xs text-muted-foreground">
          {page.description}
        </p>
      ) : null}
      <Markdown className="font-mono text-sm leading-relaxed text-foreground/90">
        {page.body}
      </Markdown>
    </section>
  );
}

/**
 * First-run rules gate. Shown to any signed-in member who has not yet accepted
 * the server rules. It is the ONLY screen such a member can reach: it renders the
 * guidebook rules inline and an "I've read the rules" button that persists the
 * acknowledgement and grants the rules Discord role. Once accepted, the backend
 * `rulesAccepted` flag flips and the member falls through to the normal portal.
 */
export default function RulesGate() {
  const qc = useQueryClient();
  const { data: browse, isLoading } = useListGuidebook();
  const rulesPages = useMemo(() => {
    const section = (browse?.sections ?? []).find(
      (s) => s.key === RULES_SECTION_KEY,
    );
    return section?.pages ?? [];
  }, [browse]);

  const accept = useAcceptRules({
    mutation: {
      onSuccess: () => {
        qc.setQueryData(getGetMeQueryKey(), (prev: Me | undefined) =>
          prev ? { ...prev, rulesAccepted: true } : prev,
        );
        qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
    },
  });

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="crt-overlay pointer-events-none fixed inset-0 z-50">
        <div className="scanline" />
      </div>
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-6">
        <Card className="rounded-none border-nc-cyan/60 bg-card/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-3 font-display text-nc-cyan">
              <ScrollText className="h-6 w-6 shrink-0" />
              READ THE RULES
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 font-sans text-sm text-muted-foreground">
            <p>
              Before you enter Night City, take a moment to read the server
              rules. You only need to acknowledge them once to access the portal.
            </p>
            <ScrollArea className="h-[55vh] rounded-none border border-border bg-background/40 p-4">
              <div className="space-y-8 pr-4">
                {isLoading ? (
                  <div className="font-display text-nc-cyan animate-pulse">
                    LOADING RULES...
                  </div>
                ) : rulesPages.length === 0 ? (
                  <p className="font-mono text-sm text-muted-foreground">
                    No rules content is available right now. Please contact staff.
                  </p>
                ) : (
                  rulesPages.map((p) => <RulesPageBlock key={p.id} id={p.id} />)
                )}
              </div>
            </ScrollArea>
            {accept.isError ? (
              <p className="font-mono text-xs text-nc-yellow">
                Something went wrong saving your acknowledgement. Please try
                again.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button
                className="rounded-none bg-nc-cyan text-background font-display"
                data-testid="button-accept-rules"
                disabled={accept.isPending}
                onClick={() => accept.mutate()}
              >
                <Check className="mr-2 h-4 w-4" />
                {accept.isPending ? "SAVING..." : "I've read the rules"}
              </Button>
              <form action="/api/auth/logout" method="POST">
                <Button
                  type="submit"
                  variant="ghost"
                  className="rounded-none text-muted-foreground"
                  data-testid="button-logout"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Log out
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

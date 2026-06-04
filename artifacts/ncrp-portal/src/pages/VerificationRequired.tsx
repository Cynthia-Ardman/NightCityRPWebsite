import { useMemo } from "react";
import {
  useListGuidebook,
  useGetGuidebookPage,
  getGetGuidebookPageQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import Markdown from "@/components/Markdown";
import { ShieldAlert, ExternalLink, RefreshCw, LogOut } from "lucide-react";

// Stable slug of the "Link VRChat & Discord" guidebook page. The serial page id
// differs per environment, so we resolve the page by slug rather than hardcoding
// an id. (Originating Discord channel id: 1351049157875339274.)
const VRC_LINK_SLUG = "link-vrchat-discord";

// The #how-to-verify help channel, linked so a member who still needs the
// Verified 18+ role knows exactly where to go.
const HELP_CHANNEL_URL =
  "https://discord.com/channels/1348601552083882108/1349160087322624102";

/**
 * Age-verification landing. Shown to any signed-in member who lacks the guild's
 * Verified 18+ role. It is the ONLY screen such a member can reach: it embeds the
 * VRChat↔Discord linking guidebook page inline and links to the help channel, so
 * there is no navigation out into the rest of the portal.
 */
export default function VerificationRequired() {
  const qc = useQueryClient();
  const { data: browse } = useListGuidebook();
  const pageId = useMemo(() => {
    for (const section of browse?.sections ?? []) {
      const match = section.pages.find((p) => p.slug === VRC_LINK_SLUG);
      if (match) return match.id;
    }
    return undefined;
  }, [browse]);
  const { data: page } = useGetGuidebookPage(pageId as number, {
    query: {
      enabled: typeof pageId === "number",
      queryKey: getGetGuidebookPageQueryKey(pageId as number),
    },
  });

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div className="crt-overlay pointer-events-none fixed inset-0 z-50">
        <div className="scanline" />
      </div>
      <div className="mx-auto max-w-3xl px-4 py-10 space-y-6">
        <Card className="rounded-none border-nc-yellow/60 bg-card/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-3 font-display text-nc-yellow">
              <ShieldAlert className="h-6 w-6 shrink-0" />
              AGE VERIFICATION REQUIRED
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 font-sans text-sm text-muted-foreground">
            <p>
              Night City RP is an 18+ community. To access the portal you must
              hold the{" "}
              <span className="text-foreground font-semibold">Verified 18+</span>{" "}
              role in our Discord. Once you have it, refresh this page and you'll
              have full access.
            </p>
            <p>
              Need to get verified, or have a question? Head to the help channel:
            </p>
            <div className="flex flex-wrap gap-3">
              <a href={HELP_CHANNEL_URL} target="_blank" rel="noreferrer">
                <Button
                  variant="outline"
                  className="rounded-none border-nc-cyan text-nc-cyan"
                  data-testid="link-help-channel"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open help channel
                </Button>
              </a>
              <Button
                variant="outline"
                className="rounded-none"
                data-testid="button-refresh-verification"
                onClick={() => {
                  qc.invalidateQueries();
                  window.location.reload();
                }}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                I'm verified — refresh
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

        {page ? (
          <Card className="rounded-none border-border bg-card/50">
            <CardHeader>
              <CardTitle className="font-display text-nc-cyan">
                {page.title}
              </CardTitle>
              {page.description ? (
                <p className="font-sans text-sm text-muted-foreground">
                  {page.description}
                </p>
              ) : null}
            </CardHeader>
            <CardContent>
              <Markdown className="font-mono text-sm leading-relaxed text-foreground/90">
                {page.body}
              </Markdown>
            </CardContent>
          </Card>
        ) : (
          <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>
        )}
      </div>
    </div>
  );
}

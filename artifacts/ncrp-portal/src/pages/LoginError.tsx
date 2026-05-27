import { Link, useSearch } from "wouter";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";

type ReasonInfo = {
  title: string;
  message: string;
  showRetry: boolean;
};

function describeReason(reason: string | null, detail: string | null): ReasonInfo {
  switch (reason) {
    case "state":
      return {
        title: "SESSION HANDSHAKE FAILED",
        message:
          "Your login session expired or didn't match. This usually happens if the page sat open too long or you opened the login in another tab. Try again from scratch.",
        showRetry: true,
      };
    case "upstream":
      return {
        title: "DISCORD UPLINK UNSTABLE",
        message: `Discord returned an error while signing you in${
          detail ? ` (HTTP ${detail})` : ""
        }. This is almost always a temporary blip on their side — please try again in a moment.`,
        showRetry: true,
      };
    case "config":
      return {
        title: "LOGIN MISCONFIGURED",
        message:
          "The portal isn't set up correctly to talk to Discord right now. Retrying won't help — please contact an administrator.",
        showRetry: false,
      };
    case "unknown":
    default:
      return {
        title: "LOGIN FAILED",
        message:
          "Something went wrong completing your Discord login. Please try again; if it keeps happening, ping an administrator.",
        showRetry: true,
      };
  }
}

export default function LoginError() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const reason = params.get("reason");
  const detail = params.get("detail");
  const info = describeReason(reason, detail);

  return (
    <div className="min-h-[60vh] w-full flex items-center justify-center p-4">
      <div className="w-full max-w-lg border border-destructive/40 bg-card/70 backdrop-blur-sm shadow-[0_0_30px_rgba(255,0,80,0.15)]">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-destructive/30 bg-destructive/5">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <div className="font-display tracking-widest text-destructive text-lg">
            {info.title}
          </div>
        </div>
        <div className="p-6 space-y-5">
          <p className="text-sm text-foreground/90 leading-relaxed font-sans">
            {info.message}
          </p>

          {reason === "config" && detail && (
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground bg-background/60 border border-border p-3">
              {detail}
            </pre>
          )}

          <div className="text-xs font-mono text-muted-foreground">
            <span className="text-nc-cyan">error_code</span> :: {reason ?? "unknown"}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {info.showRetry && (
              <Button
                asChild
                className="flex-1 rounded-none font-display bg-nc-cyan text-background hover:bg-nc-cyan/80"
                data-testid="button-retry-login"
              >
                <a href="/api/auth/discord/login">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  TRY AGAIN
                </a>
              </Button>
            )}
            <Button
              asChild
              variant="outline"
              className="flex-1 rounded-none font-display border-nc-cyan/50 text-nc-cyan hover:bg-nc-cyan/10"
              data-testid="link-home"
            >
              <Link href="/">
                <Home className="h-4 w-4 mr-2" />
                BACK TO PORTAL
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

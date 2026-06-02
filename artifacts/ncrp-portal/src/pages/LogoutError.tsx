import { Link, useSearch } from "wouter";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import ncrpLogo from "@assets/image_1780331782394.png";
import ncrpBanner from "@assets/NCRP_GroupBanner_1780331827566.png";

type ReasonInfo = {
  title: string;
  message: string;
};

function describeReason(reason: string | null): ReasonInfo {
  switch (reason) {
    case "session":
      return {
        title: "DISCONNECT FAILED",
        message:
          "We couldn't tear down your session cleanly. This is usually a temporary glitch with the session store — try disconnecting again in a moment. If it keeps happening, ping an administrator.",
      };
    default:
      return {
        title: "DISCONNECT FAILED",
        message:
          "Something went wrong signing you out. Please try again; if it keeps happening, ping an administrator.",
      };
  }
}

export default function LogoutError() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  const reason = params.get("reason");
  const detail = params.get("detail");
  const info = describeReason(reason);

  return (
    <div className="min-h-[60vh] w-full flex flex-col items-center justify-center gap-6 p-4">
      <img
        src={ncrpBanner}
        alt="Night City RP"
        className="w-full max-w-lg border border-nc-cyan/30 shadow-[0_0_30px_rgba(0,255,255,0.15)]"
        data-testid="img-logout-banner"
      />
      <div className="w-full max-w-lg border border-destructive/40 bg-card/70 backdrop-blur-sm shadow-[0_0_30px_rgba(255,0,80,0.15)]">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-destructive/30 bg-destructive/5">
          <img src={ncrpLogo} alt="NCRP" className="h-7 w-7 object-contain shrink-0" data-testid="img-logout-logo" />
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <div className="font-display tracking-widest text-destructive text-lg">
            {info.title}
          </div>
        </div>
        <div className="p-6 space-y-5">
          <p className="text-sm text-foreground/90 leading-relaxed font-sans">
            {info.message}
          </p>

          <div className="text-xs font-mono text-muted-foreground">
            <span className="text-nc-cyan">error_code</span> :: {reason ?? "unknown"}
            {detail ? ` / ${detail}` : ""}
          </div>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <form action="/api/auth/logout" method="POST" className="flex-1">
              <Button
                type="submit"
                className="w-full rounded-none font-display bg-nc-cyan text-background hover:bg-nc-cyan/80"
                data-testid="button-retry-logout"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                TRY AGAIN
              </Button>
            </form>
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

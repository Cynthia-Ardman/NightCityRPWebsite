import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

// Full-screen lockout shown to a signed-in NON-staff member while an admin has
// enabled staff-only login restriction. Staff (ADMIN / FIXER / ARCHIVIST) never
// see this — App routes them to the normal portal. The only action offered is
// to sign out, since every data route is server-side blocked (403 site_locked)
// while the lockdown is on.
export default function SiteLocked() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-lg border border-nc-yellow/40 bg-card/70 backdrop-blur-sm shadow-[0_0_30px_rgba(255,221,0,0.12)]">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-nc-yellow/30 bg-nc-yellow/5">
          <Lock className="h-6 w-6 text-nc-yellow" />
          <div className="font-display tracking-widest text-nc-yellow text-lg">
            PORTAL LOCKED
          </div>
        </div>
        <div className="p-6 space-y-5">
          <p className="text-sm text-foreground/90 leading-relaxed font-sans">
            Night City is offline for maintenance. Access is temporarily
            restricted to staff while the crew works on the subnet. Please check
            back later — your characters and data are safe.
          </p>
          <div className="text-xs font-mono text-muted-foreground">
            <span className="text-nc-cyan">status</span> :: staff_only
          </div>
          <Button
            asChild
            variant="outline"
            className="w-full rounded-none font-display border-nc-yellow/50 text-nc-yellow hover:bg-nc-yellow/10"
            data-testid="button-locked-logout"
          >
            <a href="/api/auth/logout">SIGN OUT</a>
          </Button>
        </div>
      </div>
    </div>
  );
}

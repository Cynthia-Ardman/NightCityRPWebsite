import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Hash } from "lucide-react";
import DiscordThreadPanel from "@/components/DiscordThreadPanel";

type SubjectType = "edit" | "request" | "sheet";

// Pop-out wrapper around the read-only DiscordThreadPanel. Renders a button that
// slides the cs-approver thread mirror in from the right edge, so reviewers can
// read it without scrolling the ticket — and dismiss it just as easily. STAFF
// ONLY: gate the mount like the inline panel (the server endpoint is
// reviewer-gated regardless).
//
// The panel — and its 15s polling query — only mounts while the drawer is open,
// so a queue full of these buttons never fires one poll per card.
export default function DiscordThreadDrawer({
  subjectType,
  subjectId,
  buttonLabel = "DISCORD THREAD",
  buttonClassName,
  iconOnly = false,
}: {
  subjectType: SubjectType;
  subjectId: number;
  buttonLabel?: string;
  buttonClassName?: string;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={
            buttonClassName ??
            "rounded-none border-nc-magenta/60 text-nc-magenta hover:bg-nc-magenta/10 font-display text-xs tracking-widest h-8 shrink-0"
          }
          data-testid={`button-discord-thread-${subjectType}-${subjectId}`}
        >
          <Hash className={iconOnly ? "w-4 h-4" : "w-3 h-3 mr-1"} />
          {iconOnly ? <span className="sr-only">{buttonLabel}</span> : buttonLabel}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto p-0 bg-background border-l-nc-magenta/60"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>CS-Approver Discord Thread</SheetTitle>
        </SheetHeader>
        <div className="p-4 pt-12">
          {open && <DiscordThreadPanel subjectType={subjectType} subjectId={subjectId} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

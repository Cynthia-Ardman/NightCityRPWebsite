// Single admin OVERRIDE control shared by every review queue (misc requests,
// character sheets, lore edits, character edits). One orange OVERRIDE button
// opens a menu with OVERRIDE APPROVE / OVERRIDE DENY; picking either asks for
// confirmation before firing, so an admin can't fat-finger a queue decision.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShieldCheck, X, ChevronDown } from "lucide-react";

export type OverrideDecision = "approve" | "deny";

export function OverrideButton({
  onDecide,
  disabled,
  testIdSuffix,
  subjectLabel,
}: {
  onDecide: (decision: OverrideDecision) => void;
  disabled?: boolean;
  /** e.g. `misc-42`, `sheet-7`, `lore-3`, `edit-9` — keeps testids per-row unique */
  testIdSuffix: string;
  /** Short human label for the confirmation copy, e.g. "this request" */
  subjectLabel?: string;
}) {
  const [confirming, setConfirming] = useState<OverrideDecision | null>(null);
  const what = subjectLabel ?? "this submission";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="rounded-none border-nc-orange text-nc-orange hover:bg-nc-orange/10 font-display text-xs tracking-widest"
            disabled={disabled}
            data-testid={`button-override-${testIdSuffix}`}
          >
            OVERRIDE <ChevronDown className="w-3 h-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="rounded-none border-nc-orange/60">
          <DropdownMenuItem
            className="font-display text-xs tracking-widest text-nc-green focus:text-nc-green cursor-pointer"
            onSelect={() => setConfirming("approve")}
            data-testid={`button-override-approve-${testIdSuffix}`}
          >
            <ShieldCheck className="w-3.5 h-3.5 mr-1" /> OVERRIDE APPROVE
          </DropdownMenuItem>
          <DropdownMenuItem
            className="font-display text-xs tracking-widest text-destructive focus:text-destructive cursor-pointer"
            onSelect={() => setConfirming("deny")}
            data-testid={`button-override-deny-${testIdSuffix}`}
          >
            <X className="w-3.5 h-3.5 mr-1" /> OVERRIDE DENY
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent className="rounded-none border-nc-orange/60">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display tracking-widest text-nc-orange">
              {confirming === "deny" ? "OVERRIDE DENY?" : "OVERRIDE APPROVE?"}
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-xs">
              {confirming === "deny"
                ? `This will deny ${what} immediately, bypassing the reviewer vote. Are you sure?`
                : `This will approve ${what} immediately, bypassing the reviewer vote. Are you sure?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              className="rounded-none font-display text-xs tracking-widest"
              data-testid={`button-override-cancel-${testIdSuffix}`}
            >
              CANCEL
            </AlertDialogCancel>
            <AlertDialogAction
              className={
                confirming === "deny"
                  ? "rounded-none bg-destructive text-destructive-foreground hover:bg-destructive/80 font-display text-xs tracking-widest"
                  : "rounded-none bg-nc-orange text-background hover:bg-nc-orange/80 font-display text-xs tracking-widest"
              }
              onClick={() => {
                if (confirming) onDecide(confirming);
                setConfirming(null);
              }}
              data-testid={`button-override-confirm-${testIdSuffix}`}
            >
              {confirming === "deny" ? "YES, DENY" : "YES, APPROVE"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useViewAs, useEffectiveMe, type ViewAsRole } from "@/contexts/ViewAsContext";

const ROLE_OPTIONS: { value: ViewAsRole; label: string }[] = [
  { value: "player", label: "Player" },
  { value: "new_user", label: "New User" },
  { value: "ripperdoc", label: "Ripperdoc" },
  { value: "fixer", label: "Fixer" },
];

function labelFor(role: ViewAsRole): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
}

// Admin-only dropdown that switches the preview role. Hidden for non-admins
// (the hook reports realIsAdmin from the true identity, not the override).
export function ViewAsControl() {
  const { realIsAdmin } = useEffectiveMe();
  const { viewAs, setViewAs } = useViewAs();
  if (!realIsAdmin) return null;

  const active = !!viewAs;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`rounded-none font-display tracking-widest text-xs gap-2 ${
            active
              ? "border-nc-yellow text-nc-yellow bg-nc-yellow/10"
              : "border-nc-cyan/40 text-nc-cyan hover:bg-nc-cyan/10"
          }`}
          data-testid="button-view-as"
        >
          <Eye className="h-4 w-4" />
          {active ? `VIEWING: ${labelFor(viewAs!).toUpperCase()}` : "VIEW AS"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48 rounded-none border-border bg-card">
        <DropdownMenuLabel className="font-display tracking-widest text-xs text-muted-foreground">
          Preview Role
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={viewAs ?? ""}
          onValueChange={(v) => setViewAs(v as ViewAsRole)}
        >
          {ROLE_OPTIONS.map((o) => (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              className="font-display tracking-wide text-sm rounded-none"
              data-testid={`view-as-${o.value}`}
            >
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setViewAs(null)}
              className="font-display tracking-wide text-sm rounded-none text-nc-yellow focus:text-nc-yellow"
              data-testid="view-as-exit"
            >
              <X className="h-4 w-4 mr-2" />
              Exit preview
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Sticky reminder bar shown only while an admin is previewing a role, so it's
// always obvious the view is downgraded (and how to leave it).
export function ViewAsBanner() {
  const { realIsAdmin } = useEffectiveMe();
  const { viewAs, setViewAs } = useViewAs();
  if (!realIsAdmin || !viewAs) return null;

  return (
    <div
      className="sticky top-16 z-10 flex items-center justify-between gap-4 px-4 md:px-8 py-2 bg-nc-yellow/10 border-b border-nc-yellow/40 text-nc-yellow"
      data-testid="banner-view-as"
    >
      <div className="flex items-center gap-2 font-display tracking-widest text-xs">
        <Eye className="h-4 w-4" />
        PREVIEW MODE — VIEWING AS {labelFor(viewAs).toUpperCase()}. STAFF CONTROLS ARE HIDDEN.
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setViewAs(null)}
        className="rounded-none font-display tracking-widest text-xs text-nc-yellow hover:bg-nc-yellow/20 h-7"
        data-testid="button-exit-preview"
      >
        <X className="h-4 w-4 mr-1" />
        EXIT
      </Button>
    </div>
  );
}

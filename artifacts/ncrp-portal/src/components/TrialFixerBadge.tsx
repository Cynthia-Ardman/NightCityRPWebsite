import { Badge } from "@/components/ui/badge";

// Display-only marker shown next to a fixer's identity when they are still on
// trial (Task: surface trial fixers in the staff UI). Trial fixers act as full
// fixers everywhere; this badge just lets staff watch their work more closely.
// Rendered conditionally by callers: pass `show` from the API's isTrialFixer /
// fixerIsTrial flag so it never appears for established fixers.
export function TrialFixerBadge({
  show = true,
  className = "",
  testId,
}: {
  show?: boolean;
  className?: string;
  testId?: string;
}) {
  if (!show) return null;
  return (
    <Badge
      variant="outline"
      title="This fixer is still on trial"
      data-testid={testId}
      className={`rounded-none font-mono text-[10px] px-1 py-0 border-orange-400 text-orange-400 ${className}`}
    >
      TRIAL
    </Badge>
  );
}

import { Badge } from "@/components/ui/badge";
import { formatEddies } from "@/lib/format";

// Shared roster badges used by both the Event and Mission detail pages.
// Previously each page had its own copy with drifting colors; the only
// deliberate divergence is the "signed up" accent (events are magenta,
// missions are yellow), so it's a prop.

export function NpcStateBadge({
  state,
  signedUpAccent = "yellow",
}: {
  state: string;
  signedUpAccent?: "magenta" | "yellow";
}) {
  const signedUpCls =
    signedUpAccent === "magenta"
      ? "border-nc-magenta text-nc-magenta bg-nc-magenta/10"
      : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const cls =
    state === "attended"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : state === "no_show"
        ? "border-destructive text-destructive bg-destructive/10"
        : signedUpCls;
  const label =
    state === "attended" ? "Attended" : state === "no_show" ? "No-show" : "Signed up";
  return (
    <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
      {label}
    </Badge>
  );
}

export function PaymentBadge({
  status,
  amount,
  error,
}: {
  status: string;
  amount?: number | null;
  error?: string | null;
}) {
  const cls =
    status === "paid"
      ? "border-green-500 text-green-400 bg-green-500/10"
      : status === "failed"
        ? "border-destructive text-destructive bg-destructive/10"
        : status === "simulated"
          ? "border-nc-cyan text-nc-cyan bg-nc-cyan/10"
          : "border-nc-yellow text-nc-yellow bg-nc-yellow/10";
  const label =
    status === "paid" ? "Paid" : status === "failed" ? "Failed" : status === "simulated" ? "Test" : "Unpaid";
  return (
    <div className="inline-flex flex-col items-end gap-0.5">
      <Badge variant="outline" className={`rounded-none text-[10px] ${cls}`}>
        {label}
        {amount ? ` ${formatEddies(amount)}` : ""}
      </Badge>
      {error && (
        <span className="text-[10px] font-mono text-destructive max-w-[12rem] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

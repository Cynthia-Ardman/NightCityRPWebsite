import { useMemo, useState } from "react";
import {
  useListRentListings,
  useListMyCharacters,
  useCreateHousingRequest,
  useListMyHousingRequests,
  useListLifestyleTiers,
  useUpdateRentListing,
  getListRentListingsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { X, Home, ImageIcon } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";
import SingleImageField from "@/components/catalog/SingleImageField";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";

const ALL = "__all__";

type Listing = {
  id: number;
  name: string;
  district?: string | null;
  tier?: string | null;
  monthlyRent: number;
  description?: string | null;
  imageUrl?: string | null;
  occupied?: boolean;
};

const FILTER_COLUMNS: Array<{ key: keyof Listing; label: string }> = [
  { key: "district", label: "District" },
  { key: "tier", label: "Tier" },
];

export default function CatalogRent() {
  const { data, isLoading } = useListRentListings();
  const { data: me } = useAuthMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [leaseTarget, setLeaseTarget] = useState<{ id: number; name: string; monthlyRent: number } | null>(null);
  const [imageTarget, setImageTarget] = useState<Listing | null>(null);

  const listings = (data ?? []) as Listing[];

  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { key } of FILTER_COLUMNS) {
      const set = new Set<string>();
      for (const r of listings) {
        const v = r[key];
        if (typeof v === "string" && v.trim()) set.add(v);
      }
      out[key as string] = Array.from(set).sort((a, b) => a.localeCompare(b));
    }
    return out;
  }, [listings]);

  const filtered = listings.filter((r) => {
    for (const { key } of FILTER_COLUMNS) {
      const want = filters[key as string];
      if (want && want !== ALL && r[key] !== want) return false;
    }
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      r.name.toLowerCase().includes(needle) ||
      (r.district ?? "").toLowerCase().includes(needle) ||
      (r.description ?? "").toLowerCase().includes(needle)
    );
  });

  return (
    <div className="max-w-6xl mx-auto space-y-6 pb-12">
      <div>
        <h1 className="text-4xl font-display" data-testid="text-catalog-rent-title">PROPERTY CATALOG</h1>
        <p className="font-mono text-muted-foreground mt-2">Available homes, apartments, and business spaces.</p>
      </div>
      <CatalogRequestSection
        type="property"
        buttonLabel="SUBMIT OFF-MAP PROPERTY REQUEST"
        dialogTitle="OFF-MAP PROPERTY REQUEST"
        dialogDescription="Ask staff for a home or business that isn't a listed property."
        titleLabel="Location / Address"
        titlePlaceholder="e.g. Loft above the Afterlife, Watson"
      />
      <div className="space-y-3">
        <Input
          placeholder="SEARCH NAME / DISTRICT / DESCRIPTION..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="rounded-none font-mono max-w-md"
          data-testid="input-search-rent"
        />
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-w-2xl">
          {FILTER_COLUMNS.map(({ key, label }) => (
            <div key={key as string}>
              <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
              <Select
                value={filters[key as string] ?? ALL}
                onValueChange={(v) => setFilters((prev) => ({ ...prev, [key as string]: v }))}
              >
                <SelectTrigger className="rounded-none font-mono text-xs" data-testid={`filter-rent-${String(key)}`}>
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All</SelectItem>
                  {options[key as string].map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      </div>
      {isLoading ? <div className="text-nc-cyan font-display animate-pulse">LOADING...</div> : (
        <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
          <table className="w-full font-mono text-sm min-w-[800px]">
            <thead className="border-b border-border bg-card">
              <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                <th className="text-left p-3 w-0">Image</th>
                <th className="text-left p-3">Name</th>
                <th className="text-left p-3">District</th>
                <th className="text-left p-3">Tier</th>
                <th className="text-left p-3">Description</th>
                <th className="text-right p-3">Rent/mo</th>
                <th className="p-3 w-0"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="border-b border-border/30 hover:bg-card/80" data-testid={`row-rent-${r.id}`}>
                  <td className="p-3">
                    {r.imageUrl ? (
                      <img
                        src={r.imageUrl}
                        alt={r.name}
                        className="w-16 h-16 object-cover border border-border"
                        data-testid={`img-rent-${r.id}`}
                      />
                    ) : (
                      <div className="w-16 h-16 border border-border/40 flex items-center justify-center text-muted-foreground/50">
                        <ImageIcon className="w-5 h-5" />
                      </div>
                    )}
                  </td>
                  <td className="p-3 font-bold">{r.name}</td>
                  <td className="p-3 text-nc-magenta">{r.district ?? "—"}</td>
                  <td className="p-3 uppercase">{r.tier ?? "—"}</td>
                  <td className="p-3 text-muted-foreground max-w-md truncate" title={r.description ?? ""}>{r.description ?? "—"}</td>
                  <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                  <td className="p-3 text-right">
                    <div className="flex justify-end gap-2">
                      {isStaff && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="rounded-none font-display text-xs"
                          onClick={() => setImageTarget(r)}
                          data-testid={`button-rent-image-${r.id}`}
                        >
                          <ImageIcon className="w-3 h-3 mr-1" /> IMAGE
                        </Button>
                      )}
                      {r.occupied ? (
                        <span
                          className="inline-block px-2 py-1 border border-nc-magenta/60 text-nc-magenta font-display text-[10px] tracking-widest"
                          data-testid={`badge-occupied-${r.id}`}
                        >
                          OCCUPIED
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs"
                          onClick={() => setLeaseTarget({ id: r.id, name: r.name, monthlyRent: r.monthlyRent })}
                          data-testid={`button-lease-${r.id}`}
                        >
                          <Home className="w-3 h-3 mr-1" /> LEASE
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={7} className="text-center p-8 text-muted-foreground">No results.</td></tr>}
            </tbody>
          </table>
        </Card>
      )}
      <MyHousingRequests />
      <LifestyleComparison />
      {leaseTarget && (
        <LeaseDialog
          listing={leaseTarget}
          onClose={() => setLeaseTarget(null)}
          onDone={() => setLeaseTarget(null)}
        />
      )}
      <RentImageDialog
        listing={imageTarget}
        open={!!imageTarget}
        onOpenChange={(v) => !v && setImageTarget(null)}
      />
    </div>
  );
}

// Staff-only dialog to attach/replace/clear the single image on a housing
// listing. Saves immediately via the audit-logged PATCH endpoint.
function RentImageDialog({
  listing,
  open,
  onOpenChange,
}: {
  listing: Listing | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [imageUrl, setImageUrl] = useState("");

  // Re-seed the local value each time a different listing is opened.
  const seedKey = listing?.id ?? -1;
  const [seededFor, setSeededFor] = useState(-1);
  if (open && seededFor !== seedKey) {
    setImageUrl(listing?.imageUrl ?? "");
    setSeededFor(seedKey);
  }

  const update = useUpdateRentListing({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
        toast({ title: "Listing image updated" });
        onOpenChange(false);
      },
      onError: () => {
        toast({ title: "Update failed", description: "Could not save the image.", variant: "destructive" });
      },
    },
  });

  if (!listing) return null;

  const save = () => {
    const next = imageUrl.trim() ? imageUrl.trim() : null;
    if ((listing.imageUrl ?? null) === next) {
      onOpenChange(false);
      return;
    }
    update.mutate({ id: listing.id, data: { imageUrl: next } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none border-nc-cyan/40 bg-card max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan">
            LISTING IMAGE — {listing.name.toUpperCase()}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-muted-foreground">
            Upload a single image for this housing listing. Saved immediately and recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <SingleImageField
          label="Listing image"
          value={imageUrl}
          onChange={setImageUrl}
          testIdPrefix="rent-image"
        />
        <div className="flex justify-end gap-2 pt-4 border-t border-border mt-2">
          <Button variant="ghost" className="rounded-none" onClick={() => onOpenChange(false)} data-testid="button-rent-image-cancel">
            Cancel
          </Button>
          <Button className="rounded-none" disabled={update.isPending} onClick={save} data-testid="button-rent-image-save">
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MyHousingRequests() {
  const { data, isLoading } = useListMyHousingRequests();
  const rows = data ?? [];
  if (isLoading || rows.length === 0) return null;
  return (
    <Card className="rounded-none border-nc-yellow/40 bg-card/50" data-testid="card-my-housing-requests">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-yellow">MY LEASE REQUESTS</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 font-mono text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 border-b border-border/30 py-2" data-testid={`row-my-request-${r.id}`}>
              <span className="min-w-0">
                <span className="text-foreground">{r.characterName}</span>
                <span className="text-muted-foreground"> → </span>
                <span className="text-nc-cyan">{r.listingName}</span>
                <span className="text-xs text-muted-foreground"> ({r.kind})</span>
                {r.reviewerNote ? (
                  <span className="block text-[11px] text-muted-foreground italic">"{r.reviewerNote}"</span>
                ) : null}
              </span>
              <span className="shrink-0">
                <RequestStatusBadge status={r.status} />
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function LifestyleComparison() {
  const { data: tiers, isLoading } = useListLifestyleTiers();
  const active = (tiers ?? []).filter((t) => !t.archived);
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-lifestyle-catalog">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">LIFESTYLE TIERS</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="font-mono text-xs text-muted-foreground mb-3">
          A monthly cost-of-living surcharge debited on the 1st of each month alongside rent. Pick a tier on each character's profile.
        </p>
        {isLoading ? (
          <div className="text-nc-cyan font-mono animate-pulse">LOADING...</div>
        ) : active.length === 0 ? (
          <div className="font-mono text-muted-foreground italic text-sm">No lifestyle tiers configured.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-sm min-w-[500px]">
              <thead className="border-b border-border bg-card">
                <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                  <th className="text-left p-2">Tier</th>
                  <th className="text-left p-2">Description</th>
                  <th className="text-right p-2">Cost/mo</th>
                </tr>
              </thead>
              <tbody>
                {active.map((t) => (
                  <tr key={t.id} className="border-b border-border/30" data-testid={`row-lifestyle-${t.id}`}>
                    <td className="p-2 font-bold">{t.name}</td>
                    <td className="p-2 text-muted-foreground">{t.description ?? "—"}</td>
                    <td className="p-2 text-right text-nc-yellow">€${t.monthlyCost.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeaseDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: { id: number; name: string; monthlyRent: number };
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: chars } = useListMyCharacters();
  const eligible = (chars ?? []).filter((c) => !c.archived);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const request = useCreateHousingRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: ["/housing/requests/mine"] });
        onDone();
      },
    },
  });
  const errMsg =
    (request.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (request.error ? "Request failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-lease">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">
            REQUEST LEASE: {listing.name}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-lease">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!characterId) return;
              request.mutate({ data: { catalogRentId: listing.id, characterId, notes: notes || undefined } });
            }}
          >
            <p className="text-muted-foreground">
              Submits a rental request to staff. Once approved, rent <span className="text-nc-yellow">€${listing.monthlyRent.toLocaleString()}/mo</span> auto-debits on the 1st of each month.
            </p>
            <div>
              <Label className="text-xs">CHARACTER</Label>
              {eligible.length === 0 ? (
                <div className="text-muted-foreground text-xs mt-1">No eligible characters.</div>
              ) : (
                <div className="space-y-1 mt-1 max-h-60 overflow-y-auto">
                  {eligible.map((c) => (
                    <label
                      key={c.id}
                      className={`flex items-center gap-2 p-2 border cursor-pointer ${characterId === c.id ? "border-nc-cyan bg-nc-cyan/10" : "border-border/40"}`}
                      data-testid={`option-lease-char-${c.id}`}
                    >
                      <input
                        type="radio"
                        name="leaseChar"
                        checked={characterId === c.id}
                        onChange={() => setCharacterId(c.id)}
                      />
                      <span>{c.name}</span>
                      {c.archetype ? <span className="text-xs text-muted-foreground">— {c.archetype}</span> : null}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label className="text-xs">NOTES (optional)</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Context for staff (move-in date, business purpose, etc.)"
                className="rounded-none font-mono"
                data-testid="input-request-notes"
              />
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-lease-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={request.isPending || !characterId}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-confirm-lease"
            >
              {request.isPending ? "SUBMITTING..." : "SUBMIT REQUEST"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

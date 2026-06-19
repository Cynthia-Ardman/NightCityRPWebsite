import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useListRentListings,
  useListMyCharacters,
  useLeaseHousing,
  useVacateHousing,
  useSubmitCustomRequest,
  useListMyHousingRequests,
  useUpdateRentListing,
  useDeleteRentListing,
  useGetListingHistory,
  getListRentListingsQueryKey,
  getGetListingHistoryQueryKey,
  getListMyCustomRequestsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { X, Home, ImageIcon, ImagePlus, Upload, Briefcase, UserMinus, History, UserPlus, Receipt, Clock, Pencil } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";
import { uploadImage } from "@/lib/uploadImage";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";
import CustomCatalogTab from "@/components/catalog/CustomCatalogTab";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import RentCreateDialog from "@/components/catalog/RentCreateDialog";
import { RequestStatusBadge } from "@/components/catalog/requestStatusBadge";
import { useSort, sortRows, SortableTh } from "@/components/catalog/sortableTable";

const ALL = "__all__";

type Listing = {
  id: number;
  name: string;
  district?: string | null;
  tier?: string | null;
  monthlyRent: number;
  description?: string | null;
  imageUrl?: string | null;
  kind?: "residential" | "business" | null;
  occupied?: boolean;
  occupantCharacterId?: number;
  occupantCharacterName?: string;
  housingId?: number;
};

const FILTER_COLUMNS: Array<{ key: keyof Listing; label: string }> = [
  { key: "district", label: "District" },
  { key: "tier", label: "Tier" },
];

// A listing is a business space if its kind says so OR (for older imported data
// where kind defaulted to residential) its tier is a "Business Tier N". This
// keeps the two catalog sections correct even when kind hasn't been backfilled.
function isBusinessListing(r: Listing): boolean {
  return r.kind === "business" || /business/i.test(r.tier ?? "");
}

// The importer encodes building + unit into the name as "<Building> #<Unit>"
// (apartments) or "<Building> (<Room>)" (business side-rooms). Split it back
// out so housing can be grouped by building and apartments listed per-unit.
function splitName(name: string): { building: string; unit: string | null } {
  const hash = name.indexOf(" #");
  if (hash >= 0) {
    return { building: name.slice(0, hash).trim(), unit: name.slice(hash + 2).trim() || null };
  }
  const paren = name.match(/^(.*)\s+\(([^)]+)\)\s*$/);
  if (paren) return { building: paren[1].trim(), unit: paren[2].trim() || null };
  return { building: name.trim(), unit: null };
}

// "Business Tier 3" / "Housing Tier 2" -> "Tier 3" / "Tier 2". The category is
// already conveyed by the section, so the prefix is redundant in the column.
function tierLabel(tier?: string | null): string | null {
  if (!tier) return null;
  return tier.replace(/^(business|housing)\s+/i, "").trim() || tier;
}

// Stable grouping key for a housing building (name + district, case-insensitive).
function buildingKey(building: string, district?: string | null): string {
  return `${building.toLowerCase()}|||${(district ?? "").toLowerCase()}`;
}

// For a business, the listing name IS the business name; the real building
// (when distinct) is stored by the importer in the description as a
// "Building: <name>" segment joined with " • ". Returns null when absent so the
// Building column doesn't just echo the business name.
function businessBuilding(description?: string | null): string | null {
  if (!description) return null;
  for (const part of description.split(" • ")) {
    const m = part.match(/^\s*building:\s*(.+)$/i);
    if (m) return m[1].trim() || null;
  }
  return null;
}

export default function CatalogRent() {
  const { data, isLoading } = useListRentListings();
  const { data: me, realIsAdmin, realIsFixer, viewAs } = useEffectiveMe();
  const isStaff = !!(me?.isAdmin || me?.isFixer);
  // Assign/remove a listing to a character is a staff action (admins + fixers).
  // It stays hidden while an admin previews a lower role (override active) so
  // the preview is faithful — the backend gates it anyway.
  const canAdminAssign = (realIsAdmin || realIsFixer) && !viewAs;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [leaseTarget, setLeaseTarget] = useState<Listing | null>(null);
  // The listing whose history/admin modal is open (staff click on a row).
  const [historyTarget, setHistoryTarget] = useState<Listing | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // Two independent sorts: the flat Business table, and the per-building Housing
  // unit tables (one shared sort applied within every building group).
  const bizSort = useSort<string>();
  const unitSort = useSort<string>();

  // Staff-only: remove the current occupant from a listing (ends their lease).
  const vacate = useVacateHousing({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
        toast({ title: "Occupant removed" });
      },
      onError: () => toast({ title: "Could not remove occupant", variant: "destructive" }),
    },
  });

  // Staff-only: clicking a listing image uploads/replaces it. For a housing
  // building the image is shared across all of its units, so we patch every
  // unit id in the group at once.
  const updateListing = useUpdateRentListing();
  const saveImage = async (ids: number[], url: string | null) => {
    try {
      await Promise.all(ids.map((id) => updateListing.mutateAsync({ id, data: { imageUrl: url } })));
      void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
      toast({ title: url ? "Image updated" : "Image removed" });
    } catch {
      toast({ title: "Could not update image", variant: "destructive" });
    }
  };

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

  const businesses = useMemo(() => {
    const base = filtered.filter(isBusinessListing).sort((a, b) => a.name.localeCompare(b.name));
    // Default order is alphabetical by name; a header click overrides it.
    return sortRows(base, bizSort.sortKey, bizSort.sortDir, (r, key) => {
      switch (key) {
        case "name":
          return r.name;
        case "building":
          return businessBuilding(r.description) ?? "";
        case "district":
          return r.district ?? "";
        case "tier":
          return tierLabel(r.tier) ?? "";
        case "monthlyRent":
          return r.monthlyRent;
        default:
          return null;
      }
    });
  }, [filtered, bizSort.sortKey, bizSort.sortDir]);

  // Every housing unit id per building, computed from the FULL (unfiltered)
  // list. A building image is shared across its units, so uploading/removing
  // must fan out to all of them — even ones hidden by the current search/filter.
  const allUnitIdsByBuilding = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of listings) {
      if (isBusinessListing(r)) continue;
      const { building } = splitName(r.name);
      const key = buildingKey(building, r.district);
      const arr = map.get(key);
      if (arr) arr.push(r.id);
      else map.set(key, [r.id]);
    }
    return map;
  }, [listings]);

  // Housing grouped by building (+ district, so identically-named buildings in
  // different districts stay separate). The building image is the first unit
  // that has one.
  const housingGroups = useMemo(() => {
    const map = new Map<
      string,
      { key: string; building: string; district: string | null; image: string | null; rows: Listing[] }
    >();
    for (const r of filtered) {
      if (isBusinessListing(r)) continue;
      const { building } = splitName(r.name);
      const key = buildingKey(building, r.district);
      let g = map.get(key);
      if (!g) {
        g = { key, building, district: r.district ?? null, image: null, rows: [] };
        map.set(key, g);
      }
      if (!g.image && r.imageUrl) g.image = r.imageUrl;
      g.rows.push(r);
    }
    for (const g of map.values()) {
      // Default unit order is by apartment number; a unit-table header click
      // re-sorts every building's rows by the chosen column.
      g.rows.sort((a, b) =>
        (splitName(a.name).unit ?? "").localeCompare(splitName(b.name).unit ?? "", undefined, {
          numeric: true,
        }),
      );
      g.rows = sortRows(g.rows, unitSort.sortKey, unitSort.sortDir, (r, key) => {
        switch (key) {
          case "unit":
            return splitName(r.name).unit ?? "";
          case "tier":
            return tierLabel(r.tier) ?? "";
          case "monthlyRent":
            return r.monthlyRent;
          default:
            return null;
        }
      });
    }
    return Array.from(map.values()).sort((a, b) => a.building.localeCompare(b.building));
  }, [filtered, unitSort.sortKey, unitSort.sortDir]);

  // The lease/availability control shared by both sections.
  const renderAction = (r: Listing) => {
    if (r.occupied) {
      if (isStaff) {
        return (
          <div className="flex flex-col items-end gap-1.5">
            {r.occupantCharacterName ? (
              <span
                className="font-mono text-xs text-nc-magenta text-right break-words max-w-[16rem]"
                data-testid={`text-occupant-${r.id}`}
              >
                {r.occupantCharacterName}
              </span>
            ) : null}
            <div className="flex items-center gap-2">
              <span
                className="inline-block px-2 py-1 border border-nc-magenta/60 text-nc-magenta font-display text-[10px] tracking-widest whitespace-nowrap"
                data-testid={`badge-occupied-${r.id}`}
              >
                OCCUPIED
              </span>
              {r.housingId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={vacate.isPending}
                  className="rounded-none border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-display text-xs"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${r.occupantCharacterName ?? "the occupant"} from ${r.name}? This ends their lease.`,
                      )
                    ) {
                      vacate.mutate({ id: r.housingId! });
                    }
                  }}
                  data-testid={`button-remove-occupant-${r.id}`}
                >
                  <UserMinus className="w-3 h-3 mr-1" /> REMOVE
                </Button>
              ) : null}
            </div>
          </div>
        );
      }
      return (
        <span
          className="inline-block px-2 py-1 border border-border text-muted-foreground font-display text-[10px] tracking-widest"
          data-testid={`badge-unavailable-${r.id}`}
        >
          NOT AVAILABLE
        </span>
      );
    }
    return (
      <Button
        type="button"
        size="sm"
        className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs"
        onClick={() => setLeaseTarget(r)}
        data-testid={`button-lease-${r.id}`}
      >
        {isBusinessListing(r) ? (
          <>
            <Briefcase className="w-3 h-3 mr-1" /> APPLY
          </>
        ) : (
          <>
            <Home className="w-3 h-3 mr-1" /> LEASE
          </>
        )}
      </Button>
    );
  };

  return (
    <div className="max-w-[1600px] mx-auto space-y-6 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl font-display" data-testid="text-catalog-rent-title">PROPERTY CATALOG</h1>
          <p className="font-mono text-muted-foreground mt-2">Available homes, apartments, and business spaces.</p>
        </div>
        {isStaff && (
          <Button
            className="rounded-none font-display tracking-widest bg-nc-magenta text-background hover:bg-nc-magenta/80"
            onClick={() => setCreateOpen(true)}
            data-testid="button-add-property"
          >
            + ADD NEW PROPERTY
          </Button>
        )}
      </div>
      <CatalogRequestSection
        type="property"
        buttonLabel="SUBMIT OFF-MAP PROPERTY REQUEST"
        dialogTitle="OFF-MAP PROPERTY REQUEST"
        dialogDescription="Ask staff for a home or business that isn't a listed property."
        titleLabel="Location / Address"
        titlePlaceholder="e.g. Loft above the Afterlife, Watson"
      />
      <Tabs defaultValue="catalog" className="space-y-4">
        {isStaff && (
          <TabsList className="rounded-none bg-card">
            <TabsTrigger value="catalog" className="rounded-none font-display tracking-widest">
              CATALOG
            </TabsTrigger>
            <TabsTrigger value="custom" className="rounded-none font-display tracking-widest">
              CUSTOM
            </TabsTrigger>
          </TabsList>
        )}
        <TabsContent value="catalog" className="space-y-6">
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

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">LOADING...</div>
      ) : (
        <>
          {/* BUSINESS SPACES */}
          <section className="space-y-3" data-testid="section-business">
            <h2 className="font-display tracking-widest text-nc-yellow flex items-center gap-2 text-xl">
              <Briefcase className="w-5 h-5" /> BUSINESS PROPERTIES
            </h2>
            <Card className="rounded-none border-border bg-card/50 p-0 overflow-x-auto">
              <table className="w-full font-mono text-sm min-w-[800px]">
                <thead className="border-b border-border bg-card">
                  <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                    <th className="text-left p-3 w-0">Image</th>
                    <SortableTh label="Business Name" columnKey="name" activeKey={bizSort.sortKey} dir={bizSort.sortDir} onSort={bizSort.toggle} />
                    <SortableTh label="Building" columnKey="building" activeKey={bizSort.sortKey} dir={bizSort.sortDir} onSort={bizSort.toggle} />
                    <SortableTh label="District" columnKey="district" activeKey={bizSort.sortKey} dir={bizSort.sortDir} onSort={bizSort.toggle} />
                    <SortableTh label="Tier" columnKey="tier" activeKey={bizSort.sortKey} dir={bizSort.sortDir} onSort={bizSort.toggle} />
                    <SortableTh label="Rent/mo" columnKey="monthlyRent" activeKey={bizSort.sortKey} dir={bizSort.sortDir} onSort={bizSort.toggle} align="right" />
                    <th className="p-3 w-0"></th>
                  </tr>
                </thead>
                <tbody>
                  {businesses.map((r) => {
                    const building = businessBuilding(r.description);
                    return (
                      <tr
                        key={r.id}
                        className={`border-b border-border/30 hover:bg-card/80 align-top ${isStaff ? "cursor-pointer" : ""}`}
                        data-testid={`row-rent-${r.id}`}
                        onClick={isStaff ? () => setHistoryTarget(r) : undefined}
                      >
                        <td className="p-3" onClick={(e) => e.stopPropagation()}>
                          <ListingImage
                            src={r.imageUrl}
                            alt={r.name}
                            canEdit={isStaff}
                            ids={[r.id]}
                            size="row"
                            onSave={saveImage}
                            testId={`rent-${r.id}`}
                          />
                        </td>
                        <td className="p-3 font-bold">
                          <Link
                            href="/directory/stores"
                            className="hover:text-nc-cyan hover:underline transition-colors cursor-pointer"
                            data-testid={`link-business-${r.id}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.name}
                          </Link>
                        </td>
                        <td className="p-3 text-foreground/80">{building ?? "—"}</td>
                        <td className="p-3 text-nc-magenta">{r.district ?? "—"}</td>
                        <td className="p-3 uppercase">{tierLabel(r.tier) ?? "—"}</td>
                        <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                        <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>{renderAction(r)}</td>
                      </tr>
                    );
                  })}
                  {businesses.length === 0 && (
                    <tr>
                      <td colSpan={7} className="text-center p-8 text-muted-foreground">No business spaces.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </section>

          {/* HOUSING — grouped by building */}
          <section className="space-y-3" data-testid="section-housing">
            <h2 className="font-display tracking-widest text-nc-cyan flex items-center gap-2 text-xl">
              <Home className="w-5 h-5" /> HOUSING
            </h2>
            {housingGroups.length === 0 ? (
              <Card className="rounded-none border-border bg-card/50 p-8 text-center text-muted-foreground font-mono">
                No housing listings.
              </Card>
            ) : (
              <div className="space-y-4">
                {housingGroups.map((g) => {
                  const ids = allUnitIdsByBuilding.get(g.key) ?? g.rows.map((r) => r.id);
                  return (
                    <Card
                      key={`${g.building}-${g.district ?? ""}`}
                      className="rounded-none border-border bg-card/50 overflow-hidden"
                      data-testid={`building-${g.building.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <div className="flex items-start gap-4 p-4 border-b border-border bg-card/60">
                        <ListingImage
                          src={g.image}
                          alt={g.building}
                          canEdit={isStaff}
                          ids={ids}
                          size="building"
                          onSave={saveImage}
                          testId={`building-${ids[0]}`}
                        />
                        <div className="min-w-0">
                          <div className="font-display text-lg text-foreground">{g.building}</div>
                          <div className="font-mono text-sm text-nc-magenta">{g.district ?? "—"}</div>
                          <div className="font-mono text-[11px] text-muted-foreground mt-1">
                            {g.rows.length} {g.rows.length === 1 ? "unit" : "units"}
                          </div>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full font-mono text-sm min-w-[600px]">
                          <thead className="border-b border-border/60">
                            <tr className="text-nc-cyan uppercase text-[10px] tracking-widest">
                              <SortableTh label="Apt #" columnKey="unit" activeKey={unitSort.sortKey} dir={unitSort.sortDir} onSort={unitSort.toggle} />
                              <SortableTh label="Tier" columnKey="tier" activeKey={unitSort.sortKey} dir={unitSort.sortDir} onSort={unitSort.toggle} />
                              <SortableTh label="Rent/mo" columnKey="monthlyRent" activeKey={unitSort.sortKey} dir={unitSort.sortDir} onSort={unitSort.toggle} align="right" />
                              <th className="p-3 w-0"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map((r) => {
                              const { unit } = splitName(r.name);
                              return (
                                <tr
                                  key={r.id}
                                  className={`border-b border-border/30 hover:bg-card/80 ${isStaff ? "cursor-pointer" : ""}`}
                                  data-testid={`row-rent-${r.id}`}
                                  onClick={isStaff ? () => setHistoryTarget(r) : undefined}
                                >
                                  <td className="p-3 font-bold">{unit ?? "—"}</td>
                                  <td className="p-3 uppercase">{tierLabel(r.tier) ?? "—"}</td>
                                  <td className="p-3 text-right text-nc-yellow">{r.monthlyRent.toLocaleString()} €$</td>
                                  <td className="p-3 text-right" onClick={(e) => e.stopPropagation()}>{renderAction(r)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
        </TabsContent>
        {isStaff && (
          <TabsContent value="custom">
            <CustomCatalogTab type="property" />
          </TabsContent>
        )}
      </Tabs>

      <MyHousingRequests />
      {leaseTarget && isBusinessListing(leaseTarget) ? (
        <BusinessLeaseDialog
          listing={leaseTarget}
          onClose={() => setLeaseTarget(null)}
          onDone={() => setLeaseTarget(null)}
        />
      ) : leaseTarget ? (
        <LeaseDialog
          listing={leaseTarget}
          onClose={() => setLeaseTarget(null)}
          onDone={() => setLeaseTarget(null)}
        />
      ) : null}
      {isStaff && <RentCreateDialog open={createOpen} onOpenChange={setCreateOpen} />}

      {historyTarget && (
        <PropertyHistoryDialog
          listing={historyTarget}
          canAdminAssign={canAdminAssign}
          canEdit={isStaff}
          onClose={() => setHistoryTarget(null)}
        />
      )}
    </div>
  );
}

// Staff-only modal opened by clicking a listing row. Shows the rent ledger and
// a best-effort occupancy/ownership timeline for the property. Real admins
// (when not previewing a role) also get an assign/remove panel.
function PropertyHistoryDialog({
  listing,
  canAdminAssign,
  canEdit,
  onClose,
}: {
  listing: Listing;
  canAdminAssign: boolean;
  canEdit: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: history, isLoading } = useGetListingHistory(listing.id);
  const [assignPick, setAssignPick] = useState<CharacterPickerValue>(null);

  // Staff edit form (name / business name, district, tier, rent, description).
  // Collapsed by default; seeded from the listing when opened.
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(listing.name);
  const [editDistrict, setEditDistrict] = useState(listing.district ?? "");
  const [editTier, setEditTier] = useState(listing.tier ?? "");
  const [editRent, setEditRent] = useState(String(listing.monthlyRent));
  const [editDescription, setEditDescription] = useState(listing.description ?? "");
  const updateListing = useUpdateRentListing();
  const deleteListing = useDeleteRentListing();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getGetListingHistoryQueryKey(listing.id) });
    void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
  };

  const lease = useLeaseHousing({
    mutation: {
      onSuccess: () => {
        refresh();
        setAssignPick(null);
        toast({ title: "Listing assigned" });
      },
      onError: () => toast({ title: "Could not assign listing", variant: "destructive" }),
    },
  });

  const vacate = useVacateHousing({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "Occupant removed" });
      },
      onError: () => toast({ title: "Could not remove occupant", variant: "destructive" }),
    },
  });

  const tenant = history?.currentTenant ?? null;
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="rounded-none border-border bg-card max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
            <History className="w-5 h-5" /> {listing.name}
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {[listing.district, tierLabel(listing.tier), `${listing.monthlyRent.toLocaleString()} €$/mo`]
              .filter(Boolean)
              .join(" • ")}
          </DialogDescription>
        </DialogHeader>

        {canEdit && (
          <section className="border border-nc-yellow/40 p-3 space-y-3" data-testid="history-edit-panel">
            <div className="flex items-center justify-between">
              <h3 className="font-display tracking-widest text-nc-yellow text-sm flex items-center gap-2">
                <Pencil className="w-4 h-4" /> EDIT LISTING
              </h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none font-display text-xs"
                onClick={() => {
                  if (!editing) {
                    setEditName(listing.name);
                    setEditDistrict(listing.district ?? "");
                    setEditTier(listing.tier ?? "");
                    setEditRent(String(listing.monthlyRent));
                    setEditDescription(listing.description ?? "");
                  }
                  setEditing((v) => !v);
                }}
                data-testid="history-button-edit-toggle"
              >
                {editing ? "CANCEL" : "EDIT"}
              </Button>
            </div>
            {editing && (
              <form
                className="space-y-3 font-mono text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  const rentNum = parseInt(editRent, 10);
                  const patch: Record<string, string | number> = {};
                  if (editName.trim() && editName.trim() !== listing.name) patch.name = editName.trim();
                  if (editDistrict.trim() !== (listing.district ?? "")) patch.district = editDistrict.trim();
                  if (editTier.trim() !== (listing.tier ?? "")) patch.tier = editTier.trim();
                  if (Number.isFinite(rentNum) && rentNum >= 0 && rentNum !== listing.monthlyRent) patch.monthlyRent = rentNum;
                  if (editDescription !== (listing.description ?? "")) patch.description = editDescription;
                  if (Object.keys(patch).length === 0) {
                    toast({ title: "No changes to save" });
                    return;
                  }
                  updateListing.mutate(
                    { id: listing.id, data: patch },
                    {
                      onSuccess: () => {
                        refresh();
                        setEditing(false);
                        toast({ title: "Listing updated" });
                      },
                      onError: (err) => {
                        const msg =
                          (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
                          "Could not update listing";
                        toast({ title: msg, variant: "destructive" });
                      },
                    },
                  );
                }}
              >
                <div>
                  <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Name / Business Name</Label>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="rounded-none font-mono"
                    data-testid="history-input-name"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">District</Label>
                    <Input
                      value={editDistrict}
                      onChange={(e) => setEditDistrict(e.target.value)}
                      className="rounded-none font-mono"
                      data-testid="history-input-district"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Tier</Label>
                    <Input
                      value={editTier}
                      onChange={(e) => setEditTier(e.target.value)}
                      className="rounded-none font-mono"
                      data-testid="history-input-tier"
                    />
                  </div>
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Monthly Rent (€$)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={editRent}
                    onChange={(e) => setEditRent(e.target.value)}
                    className="rounded-none font-mono"
                    data-testid="history-input-rent"
                  />
                </div>
                <div>
                  <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Description</Label>
                  <Textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    className="rounded-none font-mono min-h-[80px]"
                    data-testid="history-input-description"
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={updateListing.isPending}
                  className="rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display text-xs"
                  data-testid="history-button-save-edit"
                >
                  {updateListing.isPending ? "SAVING..." : "SAVE CHANGES"}
                </Button>
              </form>
            )}
            <div className="border-t border-border/50 pt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={deleteListing.isPending}
                className="rounded-none border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-display text-xs"
                onClick={() => {
                  if (
                    !window.confirm(
                      `Delete "${listing.name}" from the property catalog? This cannot be undone.`,
                    )
                  )
                    return;
                  deleteListing.mutate(
                    { id: listing.id },
                    {
                      onSuccess: () => {
                        void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
                        toast({ title: "Listing deleted" });
                        onClose();
                      },
                      onError: (err) => {
                        // The API returns 409 with an explanatory message when
                        // the property is still occupied; surface that directly.
                        const msg =
                          (err as { response?: { data?: { error?: string } } } | null)?.response
                            ?.data?.error ?? "Could not delete listing";
                        toast({ title: msg, variant: "destructive" });
                      },
                    },
                  );
                }}
                data-testid="history-button-delete"
              >
                {deleteListing.isPending ? "DELETING..." : "DELETE LISTING"}
              </Button>
            </div>
          </section>
        )}

        {isLoading ? (
          <div className="text-nc-cyan font-display animate-pulse py-8 text-center">LOADING...</div>
        ) : (
          <div className="space-y-6">
            {/* Current tenant */}
            <section>
              <h3 className="font-display tracking-widest text-nc-yellow text-sm mb-2">CURRENT OCCUPANT</h3>
              {tenant ? (
                <div className="font-mono text-sm border border-border p-3 space-y-1" data-testid="history-current-tenant">
                  <div className="text-foreground font-bold">{tenant.characterName}</div>
                  {tenant.ownerName && <div className="text-muted-foreground text-xs">Owner: {tenant.ownerName}</div>}
                  <div className="text-muted-foreground text-xs">Since {fmt(tenant.since)}</div>
                  {tenant.paidThrough && (
                    <div className="text-muted-foreground text-xs">Paid through {fmt(tenant.paidThrough)}</div>
                  )}
                  {tenant.delinquentSince && (
                    <div className="text-destructive text-xs">Delinquent since {fmt(tenant.delinquentSince)}</div>
                  )}
                </div>
              ) : (
                <div className="font-mono text-sm text-muted-foreground">Vacant.</div>
              )}
            </section>

            {/* Admin assign / remove */}
            {canAdminAssign && (
              <section className="border border-nc-cyan/30 p-3 space-y-3" data-testid="history-admin-panel">
                <h3 className="font-display tracking-widest text-nc-cyan text-sm flex items-center gap-2">
                  <UserPlus className="w-4 h-4" /> ADMIN ASSIGN
                </h3>
                {tenant ? (
                  <div className="flex items-center justify-between gap-3 font-mono text-sm">
                    <span className="text-muted-foreground">
                      Assigned to <span className="text-foreground">{tenant.characterName}</span>.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={vacate.isPending}
                      className="rounded-none border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground font-display text-xs"
                      onClick={() => {
                        if (window.confirm(`Remove ${tenant.characterName} from ${listing.name}? This ends their lease.`)) {
                          vacate.mutate({ id: tenant.housingId });
                        }
                      }}
                      data-testid="history-button-remove"
                    >
                      <UserMinus className="w-3 h-3 mr-1" /> REMOVE
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">Character</Label>
                      <CharacterPicker
                        value={assignPick}
                        onChange={setAssignPick}
                        scope="all"
                        placeholder="Search by character or player name..."
                        testId="history-select-character"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!assignPick || lease.isPending}
                      className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display text-xs"
                      onClick={() => {
                        if (!assignPick) return;
                        lease.mutate({
                          data: {
                            catalogRentId: listing.id,
                            characterId: assignPick.id,
                            kind: isBusinessListing(listing) ? "business" : "residential",
                          },
                        });
                      }}
                      data-testid="history-button-assign"
                    >
                      <UserPlus className="w-3 h-3 mr-1" /> ASSIGN
                    </Button>
                  </div>
                )}
              </section>
            )}

            {/* Payment history */}
            <section>
              <h3 className="font-display tracking-widest text-nc-yellow text-sm mb-2 flex items-center gap-2">
                <Receipt className="w-4 h-4" /> PAYMENT HISTORY
              </h3>
              {history && history.payments.length > 0 ? (
                <div className="border border-border divide-y divide-border/40" data-testid="history-payments">
                  {history.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 p-2 font-mono text-xs">
                      <div className="min-w-0">
                        <div className="text-foreground truncate">{p.memo ?? p.kind}</div>
                        <div className="text-muted-foreground">
                          {fmt(p.date)}
                          {p.characterName ? ` • ${p.characterName}` : ""}
                        </div>
                      </div>
                      <div className={p.amount < 0 ? "text-destructive" : "text-nc-yellow"}>
                        {p.amount.toLocaleString()} €$
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-mono text-sm text-muted-foreground">No payments on record for this listing.</div>
              )}
            </section>

            {/* Occupancy / ownership timeline */}
            <section>
              <h3 className="font-display tracking-widest text-nc-yellow text-sm mb-2 flex items-center gap-2">
                <Clock className="w-4 h-4" /> OCCUPANCY &amp; OWNERSHIP
              </h3>
              {history && history.timeline.length > 0 ? (
                <div className="border-l border-border/60 pl-3 space-y-3" data-testid="history-timeline">
                  {history.timeline.map((e) => (
                    <div key={e.id} className="font-mono text-xs">
                      <div className="text-muted-foreground">{fmt(e.date)}</div>
                      <div className="text-foreground">{e.message}</div>
                      {e.actorName && <div className="text-muted-foreground/70">by {e.actorName}</div>}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="font-mono text-sm text-muted-foreground">
                  No recorded occupancy or ownership events.
                </div>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A single listing/building image. For staff, the image itself is the upload
// control (no separate button): clicking it opens the file picker and replaces
// the image; a small X removes it. Non-staff just see the picture.
function ListingImage({
  src,
  alt,
  canEdit,
  ids,
  size,
  onSave,
  testId,
}: {
  src?: string | null;
  alt: string;
  canEdit: boolean;
  ids: number[];
  size: "row" | "building";
  onSave: (ids: number[], url: string | null) => void | Promise<void>;
  testId: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const dim = size === "building" ? "w-56 h-56" : "w-44 h-44";

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadImage(file);
      await onSave(ids, url);
    } catch (err: unknown) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  const inner = src ? (
    <img src={src} alt={alt} className="w-full h-full object-contain" data-testid={`img-${testId}`} />
  ) : (
    <div className="w-full h-full flex items-center justify-center text-muted-foreground/50">
      <ImageIcon className="w-7 h-7" />
    </div>
  );

  if (!canEdit) {
    return <div className={`${dim} border border-border/40 overflow-hidden bg-black/30`}>{inner}</div>;
  }

  return (
    <div className={`${dim} relative group shrink-0`}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        data-testid={`input-upload-${testId}`}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        title="Click to upload an image"
        className="w-full h-full border border-border/60 overflow-hidden bg-black/30 hover:border-nc-cyan focus:outline-none focus:border-nc-cyan"
        data-testid={`button-upload-${testId}`}
      >
        {inner}
        <span className="absolute inset-0 flex items-center justify-center bg-background/70 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-display tracking-widest text-nc-cyan">
          {uploading ? (
            <>
              <Upload className="w-3 h-3 mr-1 animate-pulse" /> UPLOADING
            </>
          ) : (
            <>
              <ImagePlus className="w-3 h-3 mr-1" /> {src ? "REPLACE" : "UPLOAD"}
            </>
          )}
        </span>
      </button>
      {src && !uploading && (
        <button
          type="button"
          onClick={() => onSave(ids, null)}
          title="Remove image"
          className="absolute -top-2 -right-2 h-6 w-6 flex items-center justify-center bg-background border border-destructive/60 text-destructive hover:bg-destructive hover:text-destructive-foreground"
          data-testid={`button-remove-${testId}`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
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

// Residential listings lease DIRECTLY — no staff approval. The housing row is
// created immediately and the monthly rent cron handles billing from there.
function LeaseDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: Listing;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: chars } = useListMyCharacters();
  const eligible = (chars ?? []).filter((c) => !c.archived);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const lease = useLeaseHousing({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListRentListingsQueryKey() });
        toast({ title: "Lease signed", description: `${listing.name} is now yours.` });
        onDone();
      },
    },
  });
  const errMsg =
    (lease.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (lease.error ? "Lease failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-lease">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">
            LEASE: {listing.name}
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
              lease.mutate({ data: { catalogRentId: listing.id, characterId, notes: notes || undefined } });
            }}
          >
            <p className="text-muted-foreground">
              Signs the lease immediately. Rent <span className="text-nc-yellow">€${listing.monthlyRent.toLocaleString()}/mo</span> auto-debits on the 1st of each month.
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
                placeholder="Move-in notes (optional)"
                className="rounded-none font-mono"
                data-testid="input-request-notes"
              />
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-lease-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={lease.isPending || !characterId}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-confirm-lease"
            >
              {lease.isPending ? "SIGNING..." : "SIGN LEASE"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// Business spaces are NOT self-serve: applying opens a form that becomes a
// fixer/admin-reviewed custom request (type "property"). Staff approve it and
// set the lease up from the request review screen.
function BusinessLeaseDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: Listing;
  onClose: () => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: chars } = useListMyCharacters();
  const eligible = (chars ?? []).filter((c) => !c.archived);
  const [characterId, setCharacterId] = useState<number | null>(null);
  const [businessName, setBusinessName] = useState("");
  const [purpose, setPurpose] = useState("");
  const submit = useSubmitCustomRequest({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListMyCustomRequestsQueryKey({ type: "property" }) });
        toast({ title: "Application submitted", description: "Staff will review your business space request." });
        onDone();
      },
    },
  });
  const errMsg =
    (submit.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (submit.error ? "Submission failed" : null);
  const canSubmit = !!characterId && !!businessName.trim() && !!purpose.trim() && !submit.isPending;
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-business-lease">
      <Card className="rounded-none border-nc-yellow bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-yellow">
            BUSINESS APPLICATION: {listing.name}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-business-lease">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!characterId) return;
              submit.mutate({
                data: {
                  type: "property",
                  characterId,
                  title: `${businessName.trim()} @ ${listing.name}`,
                  description:
                    `Business space: ${listing.name} (€$${listing.monthlyRent.toLocaleString()}/mo)\n` +
                    `Business name: ${businessName.trim()}\n` +
                    `Purpose: ${purpose.trim()}`,
                },
              });
            }}
          >
            <p className="text-muted-foreground">
              Business spaces require staff review. Submit your plans below — a fixer sets up the lease on approval.
            </p>
            <div>
              <Label className="text-xs">CHARACTER</Label>
              {eligible.length === 0 ? (
                <div className="text-muted-foreground text-xs mt-1">No eligible characters.</div>
              ) : (
                <div className="space-y-1 mt-1 max-h-48 overflow-y-auto">
                  {eligible.map((c) => (
                    <label
                      key={c.id}
                      className={`flex items-center gap-2 p-2 border cursor-pointer ${characterId === c.id ? "border-nc-yellow bg-nc-yellow/10" : "border-border/40"}`}
                      data-testid={`option-business-char-${c.id}`}
                    >
                      <input
                        type="radio"
                        name="bizChar"
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
              <Label className="text-xs">BUSINESS NAME</Label>
              <Input
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="e.g. Afterlife Annex"
                className="rounded-none font-mono"
                data-testid="input-business-name"
              />
            </div>
            <div>
              <Label className="text-xs">PURPOSE</Label>
              <Textarea
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="What the business is and how you'll use the space."
                className="rounded-none font-mono min-h-[90px]"
                data-testid="input-business-purpose"
              />
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-business-lease-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={!canSubmit}
              className="w-full rounded-none bg-nc-yellow text-background hover:bg-nc-yellow/80 font-display"
              data-testid="button-confirm-business-lease"
            >
              {submit.isPending ? "SUBMITTING..." : "SUBMIT APPLICATION"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

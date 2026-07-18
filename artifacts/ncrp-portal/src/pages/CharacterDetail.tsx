import {
  useGetCharacter,
  useListCharacterUpdates,
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
  useTransferInventoryItem,
  useGetCharacterHousing,
  useVacateHousing,
  useGetWalletTransactions,
  getGetCharacterHousingQueryKey,
  getGetWalletTransactionsQueryKey,
  getGetMyWalletQueryKey,
  getGetCharacterInventoryQueryKey,
  useGetCharacterPendingEdit,
  getGetCharacterQueryKey,
  useListMyMissions,
  getListMyMissionsQueryKey,
  useListOwnedMissions,
  getListOwnedMissionsQueryKey,
  useListCharacterBreachPuzzles,
} from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useState, useMemo, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, ShieldAlert, Package, Terminal, Plus, Trash2, Send, DollarSign, X, Home, Pencil, Briefcase, History, Cpu, Lock } from "lucide-react";
import EditCharacterDialog from "@/components/EditCharacterDialog";
import LifeStatusPill from "@/components/LifeStatusPill";
import CyberwareSection, { isCyberwareHeading } from "@/components/CyberwareSection";
import StaffCyberwareCard from "@/components/StaffCyberwareCard";
import { cwpFromNotes, hasCwpTag, deriveCwpBand, buildCyberNotes, parseCyberNotes, stripImportSentinel } from "@/components/CyberwareEditor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FIRE_MODES, GUN_CATEGORIES, GUN_WEAPON_TYPES, GUN_POWER_LEVELS } from "@/components/catalog/gunTypes";
import { useListCyberware } from "@workspace/api-client-react";
import StaffLeaseCard from "@/components/StaffLeaseCard";
import CatalogRequestSection from "@/components/catalog/CatalogRequestSection";
import CyberwareReqInput from "@/components/CyberwareReqInput";
import Markdown from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch as UiSwitch } from "@/components/ui/switch";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import NcpdRecordPanel from "@/components/NcpdRecordPanel";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { missionStatusClass, missionStatusLabel } from "@/lib/missionStatus";

export default function CharacterDetail() {
  const { id } = useParams();
  const charId = Number(id);

  const { data: char, isLoading: charLoading } = useGetCharacter(charId);
  const me = useEffectiveMe();
  const isAdmin = !!me.data?.isAdmin;
  // Deletion is broader than admin: archivists and coordinators can also
  // permanently delete a character (enforced server-side too).
  const canDelete = isAdmin || !!me.data?.isArchivist || !!me.data?.isCoordinator;
  const [editOpen, setEditOpen] = useState(false);
  // 204 means no pending edit; the generated hook returns undefined data in
  // that case so we just check truthiness to decide whether to render the
  // "review pending" banner that links to the queued edit.
  const { data: pendingEdit } = useGetCharacterPendingEdit(charId);

  if (charLoading) return <div className="p-8 text-nc-cyan font-display text-xl animate-pulse">DECRYPTING_IDENTITY...</div>;
  if (!char) return <div className="p-8 text-destructive font-display text-xl">ERROR: IDENTITY_NOT_FOUND</div>;

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row gap-6 items-start md:items-end border-b border-border pb-6">
        <Avatar className="h-32 w-32 border-2 border-nc-cyan rounded-none shadow-[0_0_20px_rgba(0,255,255,0.2)] bg-card p-1">
          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ""} className="object-contain rounded-none" />
          <AvatarFallback className="bg-background text-nc-cyan rounded-none font-display text-4xl">
            {char.name.substring(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-4xl md:text-5xl font-display font-bold text-foreground" data-testid="text-char-name">{char.name}</h1>
            {char.approved ? (
              <Badge variant="outline" className="border-nc-cyan text-nc-cyan rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs">
                <Shield className="w-3 h-3" /> VERIFIED
              </Badge>
            ) : (
              <Badge variant="outline" className="border-nc-yellow text-nc-yellow rounded-none px-2 py-1 flex items-center gap-1 font-mono text-xs animate-pulse">
                <ShieldAlert className="w-3 h-3" /> PENDING_APPROVAL
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm font-mono uppercase tracking-widest text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-foreground">TYPE:</span>
              <span className={char.kind === "pc" ? "text-nc-magenta" : "text-nc-yellow"}>{char.kind}</span>
            </div>
            {char.archetype && (
              <div className="flex items-center gap-2">
                <span className="text-foreground">ARCHETYPE:</span>
                <span className="text-nc-cyan">{char.archetype}</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="text-foreground">STATUS:</span>
              <LifeStatusPill status={char.lifeStatus ?? "active"} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => setEditOpen(true)}
            // A pending edit locks the normal edit flow, but admins must still be
            // able to open the dialog to reach the admin-only delete (danger
            // zone). A stray admin save during a pending edit is handled
            // gracefully by the 409 path, which routes them to the pending edit.
            disabled={!!pendingEdit && !isAdmin}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest disabled:opacity-50"
            data-testid="button-edit-character"
          >
            <Pencil className="w-4 h-4 mr-2" /> EDIT
          </Button>
        </div>
      </div>

      {pendingEdit ? (
        <Link href={`/pending-edits/${pendingEdit.id}`}>
          <a
            className="block border border-nc-yellow bg-nc-yellow/10 hover:bg-nc-yellow/20 p-3 font-mono text-xs text-nc-yellow transition-colors"
            data-testid="banner-pending-edit"
          >
            <ShieldAlert className="w-3 h-3 inline mr-2" />
            An edit to this character is awaiting fixer review — click to view, vote, or withdraw.
          </a>
        </Link>
      ) : null}

      <EditCharacterDialog character={char} open={editOpen} onOpenChange={setEditOpen} canDelete={canDelete} />

      <CharacterTabsPanel characterId={char.id} />
    </div>
  );
}

// The full owner tab panel (Profile / Property / Inventory / Cyberware /
// Missions / Breach). Extracted so the admin character archive page can render
// the exact same tabs (read + edit) for ANY character. `staffView` switches the
// Missions feed from the owner's "/missions/mine" to the staff-wide
// "/missions/owned" board so a moderator sees the target character's missions.
const CHAR_TAB_VALUES = ["profile", "property", "inventory", "cyberware", "missions", "breach", "ncpd"] as const;

// Cyberware (whether currently installed, category "cyberware", or removed,
// category "cyberware (removed)") is managed through the ripperdoc flow — it's
// never "equipped" like a gun or a gadget, so it shows a "via ripperdoc" label
// instead of an equip toggle. Match on the prefix so both variants count.
function isCyberwareCategory(category?: string | null): boolean {
  return (category ?? "").trim().toLowerCase().startsWith("cyberware");
}

function readCharTabFromHash(): string {
  if (typeof window === "undefined") return "profile";
  const h = window.location.hash.replace(/^#/, "");
  return (CHAR_TAB_VALUES as readonly string[]).includes(h) ? h : "profile";
}

export function CharacterTabsPanel({
  characterId,
  staffView = false,
}: {
  characterId: number;
  staffView?: boolean;
}) {
  const { data: char } = useGetCharacter(characterId);
  // Deep-linkable tabs: EditCharacterDialog (and external links) route here with
  // a #hash (e.g. /characters/:id#cyberware). Drive the Tabs from the hash and
  // keep it in sync when the hash changes while we're already on the page.
  const [tab, setTab] = useState<string>(() => readCharTabFromHash());
  useEffect(() => {
    const onHash = () => setTab(readCharTabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // NCPD records tab is staff-only (NCPD officers/commissioner, fixers,
  // admins) — an ordinary owner never sees their own rap sheet. Hook must sit
  // ABOVE the early return (React #310).
  const tabsMe = useEffectiveMe();
  const canSeeNcpd = !!(tabsMe.data?.isNcpd || tabsMe.data?.isFixer || tabsMe.data?.isAdmin);
  // A deep link like #ncpd from a non-privileged user would otherwise select a
  // tab with no trigger and no content — coerce it back to "profile" once we
  // know the viewer's roles (avoid coercing while roles are still loading).
  const effectiveTab = tab === "ncpd" && tabsMe.data && !canSeeNcpd ? "profile" : tab;
  if (!char) return null;
  return (
    <Tabs value={effectiveTab} onValueChange={setTab} className="w-full">
      <TabsList className="bg-card border border-border rounded-none p-0 h-auto flex overflow-x-auto w-full max-w-full no-scrollbar">
        <TabsTrigger value="profile" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-profile">
          <Terminal className="w-4 h-4 mr-2 hidden sm:inline" /> Profile
        </TabsTrigger>
        <TabsTrigger value="property" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-property">
          <Home className="w-4 h-4 mr-2 hidden sm:inline" /> Property
        </TabsTrigger>
        <TabsTrigger value="inventory" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-inv">
          <Package className="w-4 h-4 mr-2 hidden sm:inline" /> Inventory
        </TabsTrigger>
        <TabsTrigger value="cyberware" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-cyberware">
          <Cpu className="w-4 h-4 mr-2 hidden sm:inline" /> Cyberware
        </TabsTrigger>
        <TabsTrigger value="missions" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-missions">
          <Briefcase className="w-4 h-4 mr-2 hidden sm:inline" /> Missions
        </TabsTrigger>
        <TabsTrigger value="breach" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-breach">
          <Cpu className="w-4 h-4 mr-2 hidden sm:inline" /> Breach
        </TabsTrigger>
        {canSeeNcpd && (
          <TabsTrigger value="ncpd" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-ncpd">
            <ShieldAlert className="w-4 h-4 mr-2 hidden sm:inline" /> NCPD
          </TabsTrigger>
        )}
      </TabsList>

      <div className="mt-8">
        <TabsContent value="profile" className="space-y-6 outline-none focus:ring-0">
          <ProfileDossier sheetData={char.sheetData} background={char.background} />
          <ImageGallery title="PORTRAITS" urls={char.portraitUrls ?? []} />
          <ImageGallery title="STATS / SHEET IMAGES" urls={char.statsImageUrls ?? []} />
          <UpdatesLog characterId={char.id} />
        </TabsContent>

        <TabsContent value="property" className="outline-none focus:ring-0">
          <HousingCard characterId={char.id} characterName={char.name} />
        </TabsContent>

        <TabsContent value="inventory" className="outline-none focus:ring-0">
          <InventoryTab characterId={char.id} />
        </TabsContent>

        <TabsContent value="cyberware" className="outline-none focus:ring-0">
          <CyberwareTab characterId={char.id} />
        </TabsContent>

        <TabsContent value="missions" className="outline-none focus:ring-0">
          <MissionsTab characterId={char.id} staffView={staffView} />
        </TabsContent>

        <TabsContent value="breach" className="outline-none focus:ring-0">
          <BreachTab characterId={char.id} />
        </TabsContent>

        {canSeeNcpd && (
          <TabsContent value="ncpd" className="outline-none focus:ring-0">
            <NcpdRecordPanel characterId={char.id} />
          </TabsContent>
        )}
      </div>
    </Tabs>
  );
}

function BreachTab({ characterId }: { characterId: number }) {
  const { data, isLoading } = useListCharacterBreachPuzzles(characterId);
  const rows = data ?? [];

  const statusClass: Record<string, string> = {
    success: "text-nc-green",
    failed: "text-destructive",
    expired: "text-muted-foreground",
    in_progress: "text-nc-yellow",
    sent: "text-nc-cyan",
  };

  if (isLoading) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-8 font-mono text-muted-foreground text-center animate-pulse">Loading...</CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Cpu className="w-5 h-5" /> BREACH HISTORY
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-6 font-mono text-muted-foreground italic text-center">No breach protocols assigned to this character.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="font-mono text-xs uppercase tracking-widest text-muted-foreground border-b border-border/40">
                  <th className="text-left py-2 pr-4">#</th>
                  <th className="text-left py-2 pr-4">Difficulty</th>
                  <th className="text-left py-2 pr-4">Status</th>
                  <th className="text-left py-2 pr-4">Daemons</th>
                  <th className="text-left py-2 pr-4">Reward</th>
                  <th className="text-left py-2 pr-4">When</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((p) => (
                  <tr key={p.id} className="border-b border-border/20" data-testid={`char-breach-${p.id}`}>
                    <td className="py-2 pr-4 text-muted-foreground">{p.id}</td>
                    <td className="py-2 pr-4 uppercase">{p.difficulty}</td>
                    <td className={`py-2 pr-4 uppercase ${statusClass[p.status] ?? "text-foreground"}`}>{p.status.replace("_", " ")}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{p.solvedCount}/{p.daemons.length}</td>
                    <td className="py-2 pr-4 text-nc-yellow">
                      {p.rewardPaidAt
                        ? [p.rewardEddies > 0 ? `€$${p.rewardEddies.toLocaleString()}` : null, p.rewardItemName].filter(Boolean).join(" + ") || "—"
                        : "—"}
                    </td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">
                      {new Date(p.completedAt ?? p.createdAt).toLocaleString()}
                    </td>
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

function MissionsTab({ characterId, staffView = false }: { characterId: number; staffView?: boolean }) {
  // Owner view: the player-scope feed (/missions/mine) holds every mission this
  // character was assigned to. Staff view (admin archive): the owner isn't the
  // viewer, so fall back to the staff-wide board (/missions/owned, which admins
  // see in full) and filter to this character. Only one query runs at a time.
  const mine = useListMyMissions({ query: { enabled: !staffView, queryKey: getListMyMissionsQueryKey() } });
  const owned = useListOwnedMissions({ query: { enabled: staffView, queryKey: getListOwnedMissionsQueryKey() } });
  const data = staffView ? owned.data : mine.data;
  const isLoading = staffView ? owned.isLoading : mine.isLoading;
  const rows = (data ?? []).filter((m) =>
    (m.players ?? []).some((p) => p.characterId === characterId),
  );
  if (isLoading) return <div className="font-mono text-nc-cyan animate-pulse">Loading missions...</div>;
  if (rows.length === 0) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-8 font-mono text-muted-foreground italic text-center">
          This character has not run any missions yet.
        </CardContent>
      </Card>
    );
  }
  // Players are paid once the mission reaches a "players paid" or "fully paid"
  // state; before that the payout is still pending.
  const isPaid = (status: string) =>
    status === "completed_players_paid" || status === "completed_paid";
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Briefcase className="w-4 h-4" /> MISSION HISTORY
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {rows.map((m) => {
            const when = m.startAt ?? m.createdAt;
            return (
              <li key={m.id} className="border border-border/40 bg-background/40 hover:bg-background/70 transition-colors">
                <Link href={`/missions/${m.id}`}>
                  <a className="grid grid-cols-12 gap-2 p-3 items-center text-sm font-mono" data-testid={`char-mission-${m.id}`}>
                    <span className="col-span-3 text-muted-foreground text-xs">
                      {new Date(when).toLocaleDateString()}
                    </span>
                    <span className="col-span-6 text-foreground truncate" title={m.title}>{m.title}</span>
                    <span className="col-span-1 text-xs uppercase">
                      <Badge variant="outline" className={`rounded-none text-[10px] ${missionStatusClass(m.status)}`}>
                        {missionStatusLabel(m.status)}
                      </Badge>
                    </span>
                    <span className="col-span-2 text-right text-nc-yellow">
                      {m.playerPay > 0 ? `${m.playerPay.toLocaleString()} €$${isPaid(m.status) ? "" : " (pending)"}` : "—"}
                    </span>
                  </a>
                </Link>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function UpdatesLog({ characterId }: { characterId: number }) {
  const { data: updates } = useListCharacterUpdates(characterId);
  if (!updates || updates.length === 0) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-updates-log">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">UPDATE LOG</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {updates.map((u) => (
            <li key={u.id} className="flex gap-3 border-b border-border/30 pb-3 last:border-0 last:pb-0" data-testid={`update-${u.id}`}>
              <Avatar className="w-8 h-8 rounded-none border border-border shrink-0">
                {u.authorAvatarUrl ? <AvatarImage src={u.authorAvatarUrl} alt={u.authorName ?? ""} /> : null}
                <AvatarFallback className="rounded-none bg-card text-xs font-mono text-nc-cyan">
                  {(u.authorName ?? "?").slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 text-xs font-mono">
                  <span className="text-nc-cyan truncate">{u.authorName ?? "Unknown"}</span>
                  <span className="text-muted-foreground shrink-0">{new Date(u.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-foreground">{u.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function CheckupStreakCard({ characterId }: { characterId: number }) {
  const { data: char } = useGetCharacter(characterId);
  if (!char) return null;
  const last = char.lastCheckupAt ? new Date(char.lastCheckupAt) : null;
  // A character's creation counts as an implicit initial checkup, so a
  // brand-new PC reads e.g. "week 2" instead of jumping to the max streak.
  const created = char.createdAt ? new Date(char.createdAt) : null;
  const effective = last ?? created;
  // Weeks since this character's last checkup (or creation if they've never
  // had one). Note: the household streak (used for billing) takes the
  // MAX(lastCheckupAt) across all the owner's characters, so this number is
  // only a hint — see the dashboard for the actual billable streak.
  const weeksSince = effective
    ? Math.max(1, Math.floor((Date.now() - effective.getTime()) / (7 * 86400000)) + 1)
    : null;
  const danger = weeksSince !== null && weeksSince >= 4;
  // No button: checkups are a PER-USER action recorded by a ripperdoc,
  // not something a player triggers on their own character. The
  // ripperdoc console (/ripperdocs/...) is the only legitimate entry
  // point. This card is read-only status.
  return (
    <Card
      className={`rounded-none border ${danger ? "border-destructive bg-destructive/10" : "border-border bg-card/50"}`}
      data-testid="card-checkup-streak"
    >
      <CardContent className="py-3 font-mono text-sm space-y-1">
        <div className={`uppercase tracking-widest text-xs ${danger ? "text-destructive" : "text-nc-cyan"}`}>
          CYBERWARE CHECKUP
        </div>
        <div className="text-foreground leading-relaxed">
          {last === null ? (
            <>
              No checkup logged yet — counting from creation
              {effective ? (
                <>
                  {" · "}
                  <span className={danger ? "text-destructive font-bold" : "text-nc-yellow"}>
                    week {weeksSince}
                  </span>{" "}
                  of the doubling streak.
                </>
              ) : (
                <>.</>
              )}
            </>
          ) : (
            <>
              Last checkup <span className="text-foreground">{last.toLocaleDateString()}</span>
              {" · "}
              <span className={danger ? "text-destructive font-bold" : "text-nc-yellow"}>
                week {weeksSince}
              </span>{" "}
              of the doubling streak.
            </>
          )}
        </div>
        <div className="text-xs text-muted-foreground leading-relaxed">
          Checkups are tracked per player, not per character. Visit a ripperdoc to reset
          the streak — any checkup clears it for your whole household.
        </div>
      </CardContent>
    </Card>
  );
}

// Shows this character's wallet history filtered to a single coarse `category`
// (e.g. rent or cyberware). Legacy bot payments were imported as kind=
// 'historical' with their real type only in the memo; the API derives/stores a
// `category` so we can pull rent / cyberware payment runs onto the right tab.
// Account-level (multi-character) rows aren't linked to a character, so they
// won't appear here — only payments attributable to this PC.
function CategoryPaymentHistory({
  characterId,
  category,
  title,
  emptyLabel,
}: {
  characterId: number;
  category: string;
  title: string;
  emptyLabel: string;
}) {
  const { data: txns, isLoading } = useGetWalletTransactions(characterId);
  // The endpoint also returns account-level rows (characterId null) for the
  // owner, so scope strictly to rows attributed to THIS character. Multi-
  // character players' legacy rows stay account-level and never surface here.
  const rows = (txns ?? []).filter(
    (t) => t.category === category && t.characterId === characterId,
  );

  return (
    <Card
      className="rounded-none border-border bg-card/50"
      data-testid={`card-payments-${category}`}
    >
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-yellow flex items-center gap-2">
          <History className="w-4 h-4" /> {title} ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="font-mono text-muted-foreground animate-pulse">Loading history...</div>
        ) : rows.length === 0 ? (
          <p
            className="font-mono text-muted-foreground italic"
            data-testid={`empty-payments-${category}`}
          >
            {emptyLabel}
          </p>
        ) : (
          <ul className="divide-y divide-border/40 font-mono text-sm">
            {rows.map((t) => {
              const credit = t.amount >= 0;
              return (
                <li
                  key={t.id}
                  className="flex items-start justify-between gap-3 py-2"
                  data-testid={`row-payment-${t.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(t.createdAt).toLocaleDateString()}
                    </div>
                    {t.memo ? (
                      <div className="text-foreground/90 break-words [overflow-wrap:anywhere]">
                        {t.memo}
                      </div>
                    ) : null}
                  </div>
                  <span
                    className={`whitespace-nowrap font-bold ${credit ? "text-nc-green" : "text-nc-magenta"}`}
                  >
                    {credit ? "+" : "−"}
                    {Math.abs(t.amount).toLocaleString()} €$
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CyberwareTab({ characterId }: { characterId: number }) {
  const { data: char, isLoading: charLoading } = useGetCharacter(characterId);
  const { data: items, isLoading: itemsLoading } = useGetCharacterInventory(characterId);
  const me = useEffectiveMe();
  // Must stay above the early returns below: hooks have to run in the same order
  // on every render. On a fresh load the loading guard returns before the body,
  // so calling this hook later (only once data arrives) changes the hook count
  // between renders and crashes with React error #310.
  const { data: cyberSlotCatalog } = useListCyberware();

  if (charLoading || itemsLoading) {
    return <div className="text-nc-cyan font-mono animate-pulse">Scanning chrome subnet...</div>;
  }
  if (!char) return null;

  // The owner of this character (or an admin) can request custom cyberware
  // for it — this reuses the unified request pipeline, preselecting this PC.
  const canRequestCyberware = !!me.data?.isAdmin || (!!char.ownerId && char.ownerId === me.data?.id);
  // Staff (admins + fixers) get a direct cyberware editor — add/edit/remove
  // chrome straight from the tab, applied immediately (no review queue).
  const isStaff = !!me.data?.isAdmin || !!me.data?.isFixer;

  // Pull cyberware items out of the per-character inventory. We match on
  // category case-insensitively so legacy "Cyberware" / "cyberware" both
  // surface. Items with no category but a name that obviously reads as
  // chrome (e.g. "Mantis Blades") aren't auto-tagged here — set their
  // category in the inventory tab if you want them to appear.
  const chromeItems = (items ?? []).filter(
    (it) => (it.category ?? "").toLowerCase() === "cyberware",
  );

  // Parse each chrome item's stored notes once, using the cyberware catalog's
  // slot names to recognise the bulk importer's bare-slot format and to strip
  // its [cyberware-import:v1] sentinel. Reused for both slot grouping and the
  // clean per-item note shown in the list below. The catalog hook is called at
  // the top of the component (above the loading guard) to keep hook order stable.
  const cyberSlotNames = (cyberSlotCatalog ?? []).map((c) => c.slot);
  const parsedNotesByItem = new Map<number, { slot: string; notes: string }>();
  for (const it of chromeItems) {
    const parsed = parseCyberNotes(it.notes, cyberSlotNames);
    parsedNotesByItem.set(it.id, { slot: parsed.slot, notes: parsed.notes });
  }

  // Try to find the cyberware section in the imported character sheet.
  const sections = (char.sheetData as { sections?: Record<string, string> } | null | undefined)?.sections ?? {};
  const cyberwareSheet = Object.entries(sections).find(([heading]) => isCyberwareHeading(heading));

  // Risk band is derived from the character's REAL installed chrome — the same
  // source the weekly meds-billing cron charges off (sum of "CWP n" across the
  // cyberware inventory items) — so this badge always matches what the player
  // is actually billed and updates the moment staff edit their chrome. A staff
  // override on the legacy cyberwareLevel column still wins (mirrors the archive
  // list's resolveBand); organic is handled separately below.
  const chromeCwp = chromeItems.reduce(
    (sum, it) => sum + cwpFromNotes(it.notes) * Math.max(1, it.quantity ?? 1),
    0,
  );
  const override = (char.cyberwareLevel ?? "none").toLowerCase();
  const level =
    override === "medium" || override === "high" || override === "extreme"
      ? override
      : deriveCwpBand(chromeCwp);
  const levelStyle =
    level === "extreme" ? "border-destructive text-destructive"
    : level === "high" ? "border-nc-magenta text-nc-magenta"
    : level === "medium" ? "border-nc-yellow text-nc-yellow"
    : "border-border text-muted-foreground";
  const isOrganic = !!char.isOrganic;

  // Group chrome items by slot if the inventory notes embed a "slot: X"
  // hint; otherwise lump under "OTHER". This is intentionally cheap —
  // the canonical slot data lives in the bot's player_inventory mirror,
  // and the sheet section above is the pretty version. This grid is the
  // "what the portal actually has on this character" view.
  const grouped = new Map<string, typeof chromeItems>();
  for (const it of chromeItems) {
    const slot = (parsedNotesByItem.get(it.id)?.slot || "Other").trim().toUpperCase();
    const list = grouped.get(slot) ?? [];
    list.push(it);
    grouped.set(slot, list);
  }
  const slotOrder = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "OTHER") return 1;
    if (b === "OTHER") return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
          <CardTitle className="font-display tracking-widest flex items-center gap-2">
            <Cpu className="w-4 h-4 text-nc-cyan" /> CHROME STATUS
          </CardTitle>
          <div className="flex items-center gap-2">
            {isOrganic ? (
              <Badge variant="outline" className="rounded-none border-nc-cyan/60 text-nc-cyan font-display tracking-widest">
                ORGANIC
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className={`rounded-none font-display tracking-widest ${levelStyle}`}
                data-testid="badge-cyberware-level"
              >
                RISK: {level.toUpperCase()}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="font-mono text-xs text-muted-foreground space-y-1">
          <div>
            Risk band drives the weekly meds cap: <span className="text-foreground">none</span> →
            no charge, <span className="text-foreground">medium</span> → 2k cap,
            {" "}<span className="text-foreground">high</span> → 5k cap,
            {" "}<span className="text-foreground">extreme</span> → 10k cap. Set by a ripperdoc on
            checkup.
          </div>
          <div>
            Checkup streak is per-household, not per-character — any of your characters visiting
            a ripperdoc resets it.
          </div>
        </CardContent>
      </Card>

      <CheckupStreakCard characterId={characterId} />

      {isStaff && <StaffCyberwareCard characterId={characterId} characterName={char.name} />}

      {canRequestCyberware && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest flex items-center gap-2">
              <Cpu className="w-4 h-4 text-nc-magenta" /> REQUEST CUSTOM CYBERWARE
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CatalogRequestSection
              type="cyberware"
              presetCharacterId={characterId}
              buttonLabel="REQUEST CUSTOM CYBERWARE"
              dialogTitle="Request Custom Cyberware"
              dialogDescription={`Ask staff to spec out new chrome for ${char.name}.`}
              titleLabel="Cyberware"
              titlePlaceholder="e.g. Militech Berserk MK.4"
            />
          </CardContent>
        </Card>
      )}

      {cyberwareSheet ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest">SHEET: {cyberwareSheet[0].toUpperCase()}</CardTitle>
          </CardHeader>
          <CardContent>
            <CyberwareSection body={cyberwareSheet[1]} />
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">
            INSTALLED CHROME ({chromeItems.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {chromeItems.length === 0 ? (
            <div className="text-muted-foreground font-mono italic" data-testid="empty-cyberware">
              {isOrganic
                ? "Marked organic — no chrome on record."
                : "No cyberware items recorded in inventory. Add items in the Inventory tab with category \"cyberware\" to see them here."}
            </div>
          ) : (
            <div className="space-y-4 font-mono text-sm" data-testid="list-cyberware">
              {slotOrder.map((slot) => {
                const list = grouped.get(slot) ?? [];
                return (
                  <div key={slot} className="border border-border/60 bg-background/30">
                    <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-3 py-1.5">
                      <span className="font-display text-xs tracking-widest text-nc-cyan">{slot}</span>
                      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {list.length} ITEM{list.length === 1 ? "" : "S"}
                      </span>
                    </div>
                    <ul className="divide-y divide-border/40">
                      {list.map((it) => (
                        <li
                          key={it.id}
                          className="flex items-start gap-3 px-3 py-2"
                          data-testid={`row-cyberware-${it.id}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-foreground">
                              {it.name}
                              {it.quantity > 1 ? (
                                <span className="text-muted-foreground"> ×{it.quantity}</span>
                              ) : null}
                              {/* Installed-ness is DERIVED from the CWP install tag in
                                  notes (same source the meds cron and risk band bill
                                  off) — the `equipped` flag drifted historically (offer
                                  installs didn't set it), so it's only a fallback. */}
                              {hasCwpTag(it.notes) || it.equipped ? (
                                <Badge variant="outline" className="ml-2 rounded-none border-nc-cyan/60 text-nc-cyan text-[10px] py-0">
                                  INSTALLED
                                </Badge>
                              ) : null}
                            </div>
                            {parsedNotesByItem.get(it.id)?.notes ? (
                              <div className="mt-0.5 text-xs text-muted-foreground truncate">{parsedNotesByItem.get(it.id)?.notes}</div>
                            ) : null}
                          </div>
                          <Link href={`/items/${it.instanceUuid}`}>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-nc-cyan h-8 px-2"
                              title="View chain of custody"
                              data-testid={`button-cyberware-history-${it.id}`}
                            >
                              <History className="w-3 h-3" />
                            </Button>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <CategoryPaymentHistory
        characterId={characterId}
        category="cyberware"
        title="CYBERWARE PAYMENTS"
        emptyLabel="No cyberware payments on record for this character."
      />
    </div>
  );
}

type InventoryCategory = "Misc" | "Weapon" | "Cyberware";
const CUSTOM_CYBER_SLOT = "__custom__";
// Sentinel for the "Custom" entry in the weapon Category / Weapon type
// dropdowns. Picking it reveals a free-text input so off-catalog weapons can
// still be logged.
const CUSTOM_GUN_OPTION = "__custom__";
const KEEP_CATEGORY = "__keep__";

function InventoryTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: items, isLoading } = useGetCharacterInventory(characterId);
  const { data: char } = useGetCharacter(characterId);
  const me = useEffectiveMe();
  // The owner of this character (or an admin) can request a custom item for it —
  // this reuses the unified request pipeline (routed to fixers), preselecting
  // this PC and materializing into inventory on approval.
  const canRequestItem = !!me.data?.isAdmin || (!!char?.ownerId && char.ownerId === me.data?.id);
  // Direct add (no review) is staff-only — players request items via the
  // REQUEST CUSTOM ITEM card below, which routes to fixers for approval.
  const isStaff = !!me.data?.isAdmin || !!me.data?.isFixer;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
    qc.invalidateQueries({ queryKey: getGetWalletTransactionsQueryKey(characterId) });
  };
  const addItem = useAddInventoryItem({ mutation: { onSuccess: invalidate } });
  const updateItem = useUpdateInventoryItem({ mutation: { onSuccess: invalidate } });
  const deleteItem = useRemoveInventoryItem({ mutation: { onSuccess: invalidate } });
  const { data: cyberCatalog } = useListCyberware();
  const cyberSlots = useMemo(() => {
    const set = new Set<string>();
    (cyberCatalog ?? []).forEach((c) => {
      if (c.slot) set.add(c.slot);
    });
    return Array.from(set).sort();
  }, [cyberCatalog]);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<InventoryCategory>("Misc");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  // Weapon-only fields (mirror the gun catalog; packed into notes on save).
  const [gun, setGun] = useState({ manufacturer: "", category: "", weaponType: "", fireMode: "", powerLevel: "" });
  // Required cyberware to operate a weapon — its own column, not packed in notes.
  const [gunCyberReq, setGunCyberReq] = useState("");
  // Free-text overrides for the weapon Category / Weapon type dropdowns. When
  // on, the matching <Select> swaps to a text input so off-catalog values can
  // be entered.
  const [customGunCategory, setCustomGunCategory] = useState(false);
  const [customWeaponType, setCustomWeaponType] = useState(false);
  // Cyberware-only fields (packed into the shared "CWP n · … · slot: x" note).
  const [cyber, setCyber] = useState({ slot: "", cwp: "" });
  const [transferItemId, setTransferItemId] = useState<number | null>(null);
  const [editItemId, setEditItemId] = useState<number | null>(null);

  const resetForm = () => {
    setName("");
    setCategory("Misc");
    setQuantity(1);
    setNotes("");
    setGun({ manufacturer: "", category: "", weaponType: "", fireMode: "", powerLevel: "" });
    setGunCyberReq("");
    setCustomGunCategory(false);
    setCustomWeaponType(false);
    setCyber({ slot: "", cwp: "" });
  };

  const gunComplete =
    !!gun.manufacturer.trim() &&
    !!gun.category.trim() &&
    !!gun.weaponType.trim() &&
    !!gun.fireMode.trim() &&
    !!gun.powerLevel.trim();
  const cyberComplete = !!cyber.slot.trim() && cyber.cwp.trim() !== "" && Number(cyber.cwp) >= 0;
  const canSubmitAdd =
    !!name.trim() &&
    (category === "Misc" || (category === "Weapon" && gunComplete) || (category === "Cyberware" && cyberComplete));

  const addErr =
    (addItem.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (addItem.error ? "Could not add item" : null);

  const submitAdd = () => {
    if (!canSubmitAdd) return;
    let finalCategory: string = category;
    let finalNotes = notes.trim() || undefined;
    let equipped = false;
    if (category === "Weapon") {
      const parts = [
        `Manufacturer: ${gun.manufacturer.trim()}`,
        `Category: ${gun.category.trim()}`,
        `Type: ${gun.weaponType.trim()}`,
        `Fire: ${gun.fireMode.trim()}`,
        `Power: ${gun.powerLevel.trim()}`,
      ];
      if (notes.trim()) parts.push(notes.trim());
      finalNotes = parts.join(" · ");
    } else if (category === "Cyberware") {
      finalCategory = "cyberware";
      equipped = true;
      finalNotes = buildCyberNotes({ points: Number(cyber.cwp) || 0, notes: notes.trim(), slot: cyber.slot.trim() });
    }
    addItem.mutate(
      {
        id: characterId,
        data: {
          name: name.trim(),
          category: finalCategory,
          quantity: Math.max(1, quantity),
          notes: finalNotes,
          equipped,
          ...(category === "Weapon" && gunCyberReq.trim() ? { cyberwareReq: gunCyberReq.trim() } : {}),
        },
      },
      { onSuccess: resetForm },
    );
  };

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Scanning personal stash...</div>;

  return (
    <div className="space-y-6">
      {isStaff && (
      <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-yellow flex items-center gap-2">
            <Lock className="w-4 h-4" /> ADD ITEM
            <span className="text-[10px] tracking-widest border border-nc-yellow/50 text-nc-yellow px-1.5 py-0.5 font-mono">
              FIXER-ONLY
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submitAdd();
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-5">
                <Label className="text-xs font-mono">NAME</Label>
                <Input value={name} maxLength={500} onChange={(e) => setName(e.target.value)} data-testid="input-item-name" />
              </div>
              <div className="sm:col-span-4">
                <Label className="text-xs font-mono">CATEGORY</Label>
                <Select value={category} onValueChange={(v) => setCategory(v as InventoryCategory)}>
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-item-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Misc">Misc</SelectItem>
                    <SelectItem value="Weapon">Weapon</SelectItem>
                    <SelectItem value="Cyberware">Cyberware</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="sm:col-span-3">
                <Label className="text-xs font-mono">QTY</Label>
                <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} data-testid="input-item-qty" />
              </div>
            </div>

            {category === "Weapon" && (
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end border border-nc-yellow/30 p-3">
                <div className="sm:col-span-4">
                  <Label className="text-xs font-mono">MANUFACTURER</Label>
                  <Input value={gun.manufacturer} onChange={(e) => setGun({ ...gun, manufacturer: e.target.value })} data-testid="input-gun-manufacturer" />
                </div>
                <div className="sm:col-span-4">
                  <Label className="text-xs font-mono">CATEGORY</Label>
                  <Select
                    value={customGunCategory ? CUSTOM_GUN_OPTION : gun.category}
                    onValueChange={(v) => {
                      if (v === CUSTOM_GUN_OPTION) {
                        setCustomGunCategory(true);
                        setGun({ ...gun, category: "" });
                      } else {
                        setCustomGunCategory(false);
                        setGun({ ...gun, category: v });
                      }
                    }}
                  >
                    <SelectTrigger className="rounded-none font-mono" data-testid="select-gun-category">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUN_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_GUN_OPTION}>Custom…</SelectItem>
                    </SelectContent>
                  </Select>
                  {customGunCategory && (
                    <Input
                      className="mt-2"
                      placeholder="Custom category"
                      value={gun.category}
                      onChange={(e) => setGun({ ...gun, category: e.target.value })}
                      data-testid="input-gun-custom-category"
                    />
                  )}
                </div>
                <div className="sm:col-span-4">
                  <Label className="text-xs font-mono">WEAPON TYPE</Label>
                  <Select
                    value={customWeaponType ? CUSTOM_GUN_OPTION : gun.weaponType}
                    onValueChange={(v) => {
                      if (v === CUSTOM_GUN_OPTION) {
                        setCustomWeaponType(true);
                        setGun({ ...gun, weaponType: "" });
                      } else {
                        setCustomWeaponType(false);
                        setGun({ ...gun, weaponType: v });
                      }
                    }}
                  >
                    <SelectTrigger className="rounded-none font-mono" data-testid="select-gun-type">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUN_WEAPON_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_GUN_OPTION}>Custom…</SelectItem>
                    </SelectContent>
                  </Select>
                  {customWeaponType && (
                    <Input
                      className="mt-2"
                      placeholder="Custom weapon type"
                      value={gun.weaponType}
                      onChange={(e) => setGun({ ...gun, weaponType: e.target.value })}
                      data-testid="input-gun-custom-type"
                    />
                  )}
                </div>
                <div className="sm:col-span-4">
                  <Label className="text-xs font-mono">FIRE MODE</Label>
                  <Select value={gun.fireMode} onValueChange={(v) => setGun({ ...gun, fireMode: v })}>
                    <SelectTrigger className="rounded-none font-mono" data-testid="select-gun-firemode">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {FIRE_MODES.map((m) => (
                        <SelectItem key={m} value={m}>{m}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-4">
                  <Label className="text-xs font-mono">POWER LEVEL</Label>
                  <Select value={gun.powerLevel} onValueChange={(v) => setGun({ ...gun, powerLevel: v })}>
                    <SelectTrigger className="rounded-none font-mono" data-testid="select-gun-power">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {GUN_POWER_LEVELS.map((p) => (
                        <SelectItem key={p} value={p}>{p}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="sm:col-span-12">
                  <Label className="text-xs font-mono">REQUIRED CYBERWARE TO OPERATE</Label>
                  <CyberwareReqInput
                    value={gunCyberReq}
                    onChange={setGunCyberReq}
                    suggestions={(cyberCatalog ?? []).map((c) => c.name)}
                    placeholder="e.g. Smart Link (optional)"
                    testId="input-gun-cyberreq"
                  />
                </div>
              </div>
            )}

            {category === "Cyberware" && (
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end border border-nc-cyan/30 p-3">
                <div className="sm:col-span-6">
                  <Label className="text-xs font-mono">SLOT</Label>
                  <Select
                    value={cyberSlots.includes(cyber.slot) || cyber.slot === "" ? cyber.slot : CUSTOM_CYBER_SLOT}
                    onValueChange={(v) => setCyber({ ...cyber, slot: v === CUSTOM_CYBER_SLOT ? "" : v })}
                  >
                    <SelectTrigger className="rounded-none font-mono" data-testid="select-cyber-slot">
                      <SelectValue placeholder="Select slot" />
                    </SelectTrigger>
                    <SelectContent>
                      {cyberSlots.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_CYBER_SLOT}>Custom / one-off</SelectItem>
                    </SelectContent>
                  </Select>
                  {!cyberSlots.includes(cyber.slot) && (
                    <Input
                      className="mt-2"
                      placeholder="Custom slot name (leave blank for unlimited)"
                      value={cyber.slot}
                      onChange={(e) => setCyber({ ...cyber, slot: e.target.value })}
                      data-testid="input-cyber-custom-slot"
                    />
                  )}
                </div>
                <div className="sm:col-span-3">
                  <Label className="text-xs font-mono">CWP</Label>
                  <Input type="number" min={0} value={cyber.cwp} onChange={(e) => setCyber({ ...cyber, cwp: e.target.value })} data-testid="input-cyber-cwp" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
              <div className="sm:col-span-11">
                <Label className="text-xs font-mono">NOTES</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-item-notes" />
              </div>
              <div className="sm:col-span-1">
                <Button type="submit" disabled={addItem.isPending || !canSubmitAdd} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-item">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
            </div>
            {category === "Weapon" && !gunComplete && (
              <p className="text-xs font-mono text-muted-foreground">Fill in all weapon stats before adding.</p>
            )}
            {category === "Cyberware" && !cyberComplete && (
              <p className="text-xs font-mono text-muted-foreground">Pick a slot and set CWP before adding.</p>
            )}
            {addErr && (
              <p className="text-sm font-mono text-destructive" data-testid="text-add-item-error">{addErr}</p>
            )}
          </form>
        </CardContent>
      </Card>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">STASH ({items?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!items || items.length === 0 ? (
            <div className="text-muted-foreground font-mono italic">Empty.</div>
          ) : (
            <div className="space-y-2 font-mono text-sm" data-testid="list-inventory">
              {items.map((it) => (
                <div key={it.id} className="grid grid-cols-12 gap-2 border border-border/40 p-2 items-center" data-testid={`row-item-${it.id}`}>
                  <span className="col-span-3 text-foreground break-words">
                    {it.name}
                    {it.cyberwareReq && (
                      <span className="ml-2 text-nc-magenta uppercase text-[10px]" data-testid={`text-item-cyberreq-${it.id}`}>REQ: {it.cyberwareReq}</span>
                    )}
                  </span>
                  <span className="col-span-2 text-nc-cyan uppercase truncate">{it.category ?? "—"}</span>
                  <span className="col-span-1 text-right">x{it.quantity}</span>
                  <span className="col-span-2 truncate text-muted-foreground">{stripImportSentinel(it.notes)}</span>
                  {isCyberwareCategory(it.category) ? (
                    <span
                      className="col-span-1 text-[10px] leading-tight text-muted-foreground"
                      title="Cyberware is installed or removed by a ripperdoc."
                      data-testid={`text-cyber-ripperdoc-${it.id}`}
                    >
                      via ripperdoc
                    </span>
                  ) : (
                    <label className="col-span-1 flex items-center gap-1 text-xs">
                      <UiSwitch
                        checked={!!it.equipped}
                        onCheckedChange={(v) => updateItem.mutate({ id: characterId, itemId: it.id, data: { equipped: v } })}
                        data-testid={`switch-equip-${it.id}`}
                      />
                      EQ
                    </label>
                  )}
                  <div className="col-span-3 flex justify-end gap-1">
                    <Link href={`/items/${it.instanceUuid}`}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-nc-cyan h-8 px-2"
                        title="View chain of custody"
                        data-testid={`button-history-item-${it.id}`}
                      >
                        <History className="w-3 h-3" />
                      </Button>
                    </Link>
                    {/* Cyberware edits/removals must go through review — only
                        staff get the direct edit/delete controls. Players use
                        the cyberware request flow instead. */}
                    {(it.category ?? "").trim().toLowerCase() !== "cyberware" || isStaff ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-nc-cyan h-8 px-2"
                          onClick={() => setEditItemId(it.id)}
                          title="Edit item details"
                          data-testid={`button-edit-item-${it.id}`}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-nc-cyan h-8 px-2"
                          onClick={() => setTransferItemId(it.id)}
                          data-testid={`button-transfer-item-${it.id}`}
                        >
                          <Send className="w-3 h-3 mr-1" /> MOVE
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="text-destructive h-8 w-8"
                          onClick={() => deleteItem.mutate({ id: characterId, itemId: it.id })}
                          data-testid={`button-delete-item-${it.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {transferItemId !== null && (
        <TransferItemDialog
          characterId={characterId}
          item={items?.find((i) => i.id === transferItemId) ?? null}
          onClose={() => setTransferItemId(null)}
          onDone={() => {
            setTransferItemId(null);
            invalidate();
          }}
        />
      )}

      {editItemId !== null && (
        <EditItemDialog
          characterId={characterId}
          item={items?.find((i) => i.id === editItemId) ?? null}
          onClose={() => setEditItemId(null)}
          onDone={() => {
            setEditItemId(null);
            invalidate();
          }}
        />
      )}

      {canRequestItem && (
        <Card className="rounded-none border-border bg-card/50">
          <CardHeader>
            <CardTitle className="font-display tracking-widest flex items-center gap-2">
              <Package className="w-4 h-4 text-nc-magenta" /> REQUEST CUSTOM ITEM
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CatalogRequestSection
              type="item"
              typeChoices={["item", "gun", "cyberware"]}
              presetCharacterId={characterId}
              buttonLabel="REQUEST CUSTOM ITEM"
              dialogTitle="Request Custom Item"
              dialogDescription={`Ask staff to add a gun, cyberware, or general item to ${char?.name ?? "this character"}.`}
              titleLabel="Item"
              titlePlaceholder="e.g. Encrypted Agent, Med Kit, Vehicle Keys"
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function EditItemDialog({
  characterId,
  item,
  onClose,
  onDone,
}: {
  characterId: number;
  item: { id: number; name: string; category?: string | null; quantity: number; notes?: string | null; cyberwareReq?: string | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [notes, setNotes] = useState(stripImportSentinel(item?.notes));
  const [cyberwareReq, setCyberwareReq] = useState(item?.cyberwareReq ?? "");
  const { data: cyberCatalog } = useListCyberware();
  const update = useUpdateInventoryItem({ mutation: { onSuccess: onDone } });
  if (!item) return null;
  const isCyberware = (category ?? "").trim().toLowerCase() === "cyberware";
  const STD_CATEGORIES = ["Misc", "Weapon", "Cyberware"];
  // A stored category may be lowercase ("cyberware") or some arbitrary legacy
  // value. Map known ones onto the standard options; preserve anything else.
  const normalizedCategory =
    category.toLowerCase() === "cyberware"
      ? "Cyberware"
      : category.toLowerCase() === "weapon"
        ? "Weapon"
        : category.toLowerCase() === "misc" || category === ""
          ? "Misc"
          : category;
  const isOtherCategory = !STD_CATEGORIES.includes(normalizedCategory);
  const editCategoryValue = isOtherCategory ? KEEP_CATEGORY : normalizedCategory;
  const errMsg =
    (update.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (update.error ? "Update failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-edit-item">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">EDIT: {item.name}</CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-edit-item">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || quantity < 1) return;
              update.mutate({
                id: characterId,
                itemId: item.id,
                data: {
                  name: name.trim(),
                  category: category.toLowerCase() === "cyberware" ? "cyberware" : category.trim() || undefined,
                  quantity: Math.max(1, quantity),
                  notes: notes.trim() || undefined,
                  ...(isCyberware ? {} : { cyberwareReq: cyberwareReq.trim() }),
                },
              });
            }}
          >
            <div>
              <Label className="text-xs">NAME</Label>
              <Input value={name} maxLength={500} onChange={(e) => setName(e.target.value)} data-testid="input-edit-item-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">CATEGORY</Label>
                <Select value={editCategoryValue} onValueChange={(v) => setCategory(v === KEEP_CATEGORY ? (item.category ?? "") : v)}>
                  <SelectTrigger className="rounded-none font-mono" data-testid="select-edit-item-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Misc">Misc</SelectItem>
                    <SelectItem value="Weapon">Weapon</SelectItem>
                    <SelectItem value="Cyberware">Cyberware</SelectItem>
                    {isOtherCategory && (
                      <SelectItem value={KEEP_CATEGORY}>Keep: {item.category}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">QUANTITY</Label>
                <Input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  data-testid="input-edit-item-qty"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">NOTES</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-edit-item-notes" />
            </div>
            {!isCyberware && (
              <div>
                <Label className="text-xs">REQUIRED CYBERWARE TO OPERATE</Label>
                <CyberwareReqInput
                  value={cyberwareReq}
                  onChange={setCyberwareReq}
                  suggestions={(cyberCatalog ?? []).map((c) => c.name)}
                  placeholder="e.g. Smart Link (optional)"
                  testId="input-edit-item-cyberreq"
                />
              </div>
            )}
            {errMsg && (
              <div className="text-destructive text-sm" data-testid="text-edit-item-error">
                {errMsg}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose} className="rounded-none">
                CANCEL
              </Button>
              <Button
                type="submit"
                disabled={update.isPending || !name.trim() || quantity < 1}
                className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
                data-testid="button-save-edit-item"
              >
                {update.isPending ? "SAVING..." : "SAVE"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function TransferItemDialog({
  characterId,
  item,
  onClose,
  onDone,
}: {
  characterId: number;
  item: { id: number; name: string; quantity: number } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"give" | "sell">("give");
  const [toChar, setToChar] = useState<CharacterPickerValue>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(0);
  const [memo, setMemo] = useState("");
  const transfer = useTransferInventoryItem({ mutation: { onSuccess: onDone } });
  if (!item) return null;
  const errMsg =
    (transfer.error as { response?: { data?: { error?: string } } } | null)?.response?.data?.error ??
    (transfer.error ? "Transfer failed" : null);
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="dialog-transfer-item">
      <Card className="rounded-none border-nc-cyan bg-card w-full max-w-lg">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-nc-cyan">
            MOVE: {item.name}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="button-close-transfer">
            <X className="w-4 h-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4 font-mono text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              const toCharacterId = toChar?.id;
              if (!toCharacterId) return;
              if (mode === "sell" && price <= 0) return;
              transfer.mutate({
                id: characterId,
                itemId: item.id,
                data: {
                  toCharacterId,
                  mode,
                  quantity: qty,
                  ...(mode === "sell" ? { price } : {}),
                  ...(memo ? { memo } : {}),
                },
              });
            }}
          >
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setMode("give")}
                className={`flex-1 rounded-none font-display ${mode === "give" ? "bg-nc-cyan text-background" : "bg-transparent border border-border text-muted-foreground"}`}
                data-testid="button-mode-give"
              >
                <Send className="w-4 h-4 mr-2" /> GIVE
              </Button>
              <Button
                type="button"
                onClick={() => setMode("sell")}
                className={`flex-1 rounded-none font-display ${mode === "sell" ? "bg-nc-magenta text-background" : "bg-transparent border border-border text-muted-foreground"}`}
                data-testid="button-mode-sell"
              >
                <DollarSign className="w-4 h-4 mr-2" /> SELL
              </Button>
            </div>
            <div>
              <Label className="text-xs">RECIPIENT</Label>
              <CharacterPicker value={toChar} onChange={setToChar} testId="input-transfer-target" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">QUANTITY (max {item.quantity})</Label>
                <Input
                  type="number"
                  min={1}
                  max={item.quantity}
                  value={qty}
                  onChange={(e) => setQty(Math.max(1, Math.min(item.quantity, Number(e.target.value))))}
                  data-testid="input-transfer-qty"
                />
              </div>
              {mode === "sell" && (
                <div>
                  <Label className="text-xs">TOTAL PRICE (€$)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={price || ""}
                    onChange={(e) => setPrice(Number(e.target.value))}
                    data-testid="input-transfer-price"
                  />
                </div>
              )}
            </div>
            <div>
              <Label className="text-xs">MEMO (optional)</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-transfer-memo" />
            </div>
            {errMsg && (
              <div className="text-destructive text-xs" data-testid="text-transfer-error">{errMsg}</div>
            )}
            <Button
              type="submit"
              disabled={transfer.isPending || !toChar?.id || (mode === "sell" && price <= 0)}
              className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-confirm-transfer"
            >
              {transfer.isPending ? "MOVING..." : mode === "give" ? "CONFIRM GIVE" : "CONFIRM SALE"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function HousingCard({ characterId, characterName }: { characterId: number; characterName: string }) {
  const qc = useQueryClient();
  const me = useEffectiveMe();
  const isStaff = !!me.data?.isAdmin || !!me.data?.isFixer;
  const { data: leases, isLoading } = useGetCharacterHousing(characterId);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetCharacterHousingQueryKey(characterId) });
  const vacate = useVacateHousing({ mutation: { onSuccess: invalidate } });
  return (
    <div className="space-y-6">
    <Card className="rounded-none border-border bg-card/50" data-testid="card-housing">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Home className="w-4 h-4" /> PROPERTY
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="font-mono text-muted-foreground animate-pulse">Loading leases...</div>
        ) : !leases || leases.length === 0 ? (
          <p className="font-mono text-muted-foreground italic">
            No active leases. Browse the <a href="/catalog/rent" className="text-nc-cyan underline">property catalog</a> to sign one.
          </p>
        ) : (
          <ul className="space-y-2 font-mono text-sm">
            {leases.map((l) => {
              const paid = l.paidThrough ? new Date(l.paidThrough) : null;
              const inEviction = l.delinquentSince != null;
              return (
                <li
                  key={l.id}
                  className={`flex items-center justify-between gap-3 border p-3 ${inEviction ? "border-destructive bg-destructive/10" : l.delinquent ? "border-nc-yellow/60 bg-nc-yellow/5" : "border-border/40"}`}
                  data-testid={`row-lease-${l.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-foreground flex items-center gap-2 break-words [overflow-wrap:anywhere]">
                      {l.address}
                      <Badge
                        variant="outline"
                        className={`rounded-none text-[10px] px-1 py-0 ${l.kind === "business" ? "border-nc-magenta text-nc-magenta" : "border-nc-cyan/40 text-nc-cyan"}`}
                        data-testid={`badge-lease-kind-${l.id}`}
                      >
                        {(l.kind ?? "residential").toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {l.tier ? <span className="text-nc-magenta uppercase mr-2">{l.tier}</span> : null}
                      {l.district ? <span className="text-nc-cyan mr-2">{l.district}</span> : null}
                      <span className="text-nc-yellow">€${l.monthlyRent.toLocaleString()}/mo</span>
                      {paid ? (
                        <span className={`ml-3 ${l.delinquent ? "text-destructive" : ""}`}>
                          {l.delinquent ? "DELINQUENT — last paid through " : "Paid through "}
                          {paid.toLocaleDateString()}
                        </span>
                      ) : null}
                    </div>
                    {inEviction && (
                      <div
                        className="mt-2 text-xs font-bold uppercase tracking-widest text-destructive"
                        data-testid={`text-eviction-${l.id}`}
                      >
                        {(l.daysUntilEviction ?? 0) > 0
                          ? `EVICTION IN ${l.daysUntilEviction} DAY${l.daysUntilEviction === 1 ? "" : "S"} — RENT FAILED ${new Date(l.delinquentSince!).toLocaleDateString()}`
                          : "EVICTION PENDING ON NEXT SWEEP — RENT UNPAID"}
                      </div>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive font-display"
                    onClick={() => {
                      if (confirm(`Vacate ${l.address}? Rent billing will stop.`)) vacate.mutate({ id: l.id });
                    }}
                    data-testid={`button-vacate-${l.id}`}
                  >
                    <Trash2 className="w-3 h-3 mr-1" /> VACATE
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>

      {isStaff && <StaffLeaseCard characterId={characterId} characterName={characterName} />}

      <CategoryPaymentHistory
        characterId={characterId}
        category="rent"
        title="RENT HISTORY"
        emptyLabel="No rent payments on record for this character."
      />
    </div>
  );
}

function DossierTextCard({ title, body, testId }: { title: string; body: string; testId?: string }) {
  if (!body || !body.trim()) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid={testId}>
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{body}</Markdown>
      </CardContent>
    </Card>
  );
}

// Renders the character profile from the stored sheet data. Legacy imported
// characters keep everything in a free-form `sections` map (rendered by
// SheetSections). Characters created through the new-character form instead
// store discrete top-level fields (physical description, psych profile, etc.)
// — those used to be silently dropped on the profile page, so surface them all.
function ProfileDossier({ sheetData, background }: { sheetData: unknown; background?: string | null }) {
  const data = (sheetData ?? {}) as Record<string, unknown>;
  const sections = data.sections as Record<string, string> | undefined;
  // Legacy characters keep their bio in the free-form `sections` map, but they
  // can ALSO have discrete story fields (added via the edit form's STORY tab).
  // We must render BOTH — early-returning on sections silently hid every
  // discrete field a player edited on a legacy character. Mirror SheetSections'
  // own non-empty filter so an all-blank `sections` map doesn't render an empty
  // "No background data recorded" card next to the discrete cards.
  const hasSections =
    !!sections && Object.values(sections).some((v) => typeof v === "string" && v.trim().length > 0);

  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : "");
  const nickname = str("nickname");
  const pronouns = str("pronouns");
  const gender = str("gender");
  const age = data.age != null && data.age !== "" ? String(data.age) : "";
  const occupation = str("occupation");
  const physicalDescription = str("physicalDescription");
  const appearance = str("appearance");
  const psychProfile = str("psychProfile");
  const hooks = str("hooks");
  const knownAffiliation = str("knownAffiliation");
  const notes = str("notes");
  const skills =
    typeof data.skills === "string"
      ? data.skills
      : data.skills && typeof data.skills === "object"
        ? Object.entries(data.skills as Record<string, unknown>)
            .map(([k, v]) => (v != null && v !== "" ? `${k} ${v}` : k))
            .join("\n")
        : "";
  const gear = Array.isArray(data.gear)
    ? (data.gear as unknown[]).map(String).filter((g) => g.trim().length > 0)
    : [];
  const guns = Array.isArray(data.guns)
    ? (data.guns as unknown[]).map(String).filter((g) => g.trim().length > 0)
    : [];
  const bgRaw = background && background.trim().length > 0 ? background : str("background");
  const cleanBg = bgRaw.replace(/\[legacy:[^\]]+\]/g, "").trim();

  const vitals = ([
    ["NICKNAME", nickname],
    ["PRONOUNS", pronouns],
    ["GENDER", gender],
    ["AGE", age],
  ] as Array<[string, string]>).filter(([, v]) => v && v.trim().length > 0);

  const hasDiscrete =
    vitals.length > 0 ||
    !!occupation.trim() ||
    !!physicalDescription.trim() ||
    !!appearance.trim() ||
    !!psychProfile.trim() ||
    !!hooks.trim() ||
    !!knownAffiliation.trim() ||
    !!notes.trim() ||
    !!skills.trim() ||
    gear.length > 0 ||
    guns.length > 0;

  // The character's bio can live in two places at once: the top-level
  // `background` column (what the edit form's BACKGROUND tab writes) AND a
  // free-form `sections` entry literally titled "Background" (legacy imports).
  // SheetSections renders the section entries but NOT the column value, so we
  // surface the column `background` as its own card whenever it has content.
  // To avoid printing the bio twice we suppress the discrete card ONLY when a
  // "Background" section already shows the exact same text — if they differ
  // (e.g. an edited column bio next to a stale legacy section) we render both so
  // newer column content is never hidden.
  const sectionBackgroundRaw =
    sections &&
    Object.entries(sections).find(
      ([heading]) => heading.trim().toLowerCase() === "background",
    )?.[1];
  const sectionBackgroundClean =
    typeof sectionBackgroundRaw === "string"
      ? sectionBackgroundRaw.replace(/\[legacy:[^\]]+\]/g, "").trim()
      : "";
  const showDiscreteBackground = !!cleanBg && sectionBackgroundClean !== cleanBg;

  if (!hasSections && !hasDiscrete && !cleanBg) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground font-mono italic">No background data recorded.</div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {hasSections && sections && (
        <SheetSections sections={sections} background={background} />
      )}
      {vitals.length > 0 && (
        <Card className="rounded-none border-border bg-card/50" data-testid="dossier-vitals">
          <CardHeader>
            <CardTitle className="font-display text-nc-cyan tracking-widest text-base">VITALS</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm font-mono">
            {vitals.map(([k, v]) => (
              <div key={k} className="break-words [overflow-wrap:anywhere]">
                <span className="text-muted-foreground uppercase tracking-widest text-xs">{k}: </span>
                <span className="text-foreground">{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <DossierTextCard title="OCCUPATION / ROLE" body={occupation} testId="dossier-occupation" />
      <DossierTextCard title="PHYSICAL DESCRIPTION" body={physicalDescription} testId="dossier-physical" />
      <DossierTextCard title="STYLE" body={appearance} testId="dossier-style" />
      <DossierTextCard title="PSYCHOLOGICAL PROFILE" body={psychProfile} testId="dossier-psych" />
      {showDiscreteBackground && (
        <DossierTextCard title="BACKGROUND" body={cleanBg} testId="dossier-background" />
      )}
      <DossierTextCard title="HOOKS" body={hooks} testId="dossier-hooks" />
      <DossierTextCard title="KNOWN AFFILIATION" body={knownAffiliation} testId="dossier-affiliation" />
      <DossierTextCard title="SKILLS" body={skills} testId="dossier-skills" />
      {gear.length > 0 && (
        <Card className="rounded-none border-border bg-card/50" data-testid="dossier-gear">
          <CardHeader>
            <CardTitle className="font-display text-nc-cyan tracking-widest text-base">GEAR</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm">
            <ul className="list-disc list-inside space-y-1">
              {gear.map((g, i) => (
                <li key={i} className="break-words [overflow-wrap:anywhere]">{g}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {guns.length > 0 && (
        <Card className="rounded-none border-border bg-card/50" data-testid="dossier-guns">
          <CardHeader>
            <CardTitle className="font-display text-nc-cyan tracking-widest text-base">FIREARMS</CardTitle>
          </CardHeader>
          <CardContent className="font-mono text-sm">
            <ul className="list-disc list-inside space-y-1">
              {guns.map((g, i) => (
                <li key={i} className="break-words [overflow-wrap:anywhere]">{g}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <DossierTextCard title="NOTES" body={notes} testId="dossier-notes" />
    </div>
  );
}

function SheetSections({
  sections,
  background,
}: {
  sections?: Record<string, string>;
  background?: string | null;
}) {
  const entries = sections ? Object.entries(sections).filter(([, v]) => v && v.trim().length > 0) : [];
  // Strip internal [legacy:<uuid>] anchors stamped by the prod importer —
  // they are mapping IDs, not story content, and must never reach the UI.
  const cleanBg = (background ?? "").replace(/\[legacy:[^\]]+\]/g, "").trim() || null;
  if (entries.length === 0 && !cleanBg) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground font-mono italic">No background data recorded.</div>
        </CardContent>
      </Card>
    );
  }
  if (entries.length === 0) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display text-nc-cyan">DOSSIER</CardTitle>
        </CardHeader>
        <CardContent>
          <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{cleanBg}</Markdown>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {entries.map(([heading, body]) => (
        <Card key={heading} className="rounded-none border-border bg-card/50" data-testid={`section-${heading}`}>
          <CardHeader>
            <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{heading.toUpperCase()}</CardTitle>
          </CardHeader>
          <CardContent>
            {isCyberwareHeading(heading) ? (
              <CyberwareSection body={body} />
            ) : (
              <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{body}</Markdown>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ImageGallery({ title, urls }: { title: string; urls: string[] }) {
  if (!urls || urls.length === 0) return null;
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid={`gallery-${title}`}>
      <CardHeader>
        <CardTitle className="font-display text-nc-cyan tracking-widest text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {urls.map((u, i) => (
            <a
              key={`${u}-${i}`}
              href={u}
              target="_blank"
              rel="noreferrer"
              className="block border border-border bg-background p-1 hover:border-nc-cyan transition"
            >
              <img src={u} alt={`${title} ${i + 1}`} loading="lazy" className="max-h-56 object-contain" />
            </a>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

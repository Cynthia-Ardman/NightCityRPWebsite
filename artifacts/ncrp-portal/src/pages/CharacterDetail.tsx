import {
  useGetCharacter,
  useListCharacterUpdates,
  useGetWalletTransactions,
  useGetMyWallet,
  useTransferEddies,
  useGetCharacterInventory,
  useAddInventoryItem,
  useUpdateInventoryItem,
  useRemoveInventoryItem,
  useTransferInventoryItem,
  useGetCharacterHousing,
  useVacateHousing,
  getGetCharacterHousingQueryKey,
  useGetCharacterStatus,
  useUpdateCharacterStatus,
  getGetWalletTransactionsQueryKey,
  getGetMyWalletQueryKey,
  getGetCharacterInventoryQueryKey,
  getGetCharacterStatusQueryKey,
  useGetCharacterPendingEdit,
  getGetCharacterQueryKey,
  useListMyMissions,
} from "@workspace/api-client-react";
import { useParams, Link } from "wouter";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, ShieldAlert, Wallet, Package, Activity, Terminal, Plus, Trash2, Send, DollarSign, X, Home, Pencil, Briefcase, History, Cpu } from "lucide-react";
import EditCharacterDialog from "@/components/EditCharacterDialog";
import DeleteCharacterDialog from "@/components/DeleteCharacterDialog";
import LifeStatusPill from "@/components/LifeStatusPill";
import CyberwareSection, { isCyberwareHeading } from "@/components/CyberwareSection";
import Markdown from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch as UiSwitch } from "@/components/ui/switch";
import CharacterPicker, { type CharacterPickerValue } from "@/components/CharacterPicker";
import { useAuthMe } from "@/hooks/useAuthMe";
import { missionStatusClass, missionStatusLabel } from "@/lib/missionStatus";

export default function CharacterDetail() {
  const { id } = useParams();
  const charId = Number(id);

  const { data: char, isLoading: charLoading } = useGetCharacter(charId);
  const me = useAuthMe();
  const isAdmin = !!me.data?.isAdmin;
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // 204 means no pending edit; the generated hook returns undefined data in
  // that case so we just check truthiness to decide whether to render the
  // "review pending" banner that links to the queued edit.
  const { data: pendingEdit } = useGetCharacterPendingEdit(charId);

  if (charLoading) return <div className="p-8 text-nc-cyan font-display text-xl animate-pulse">DECRYPTING_IDENTITY...</div>;
  if (!char) return <div className="p-8 text-destructive font-display text-xl">ERROR: IDENTITY_NOT_FOUND</div>;

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <div className="flex flex-col md:flex-row gap-6 items-start md:items-end border-b border-border pb-6">
        <Avatar className="h-32 w-32 border-2 border-nc-cyan rounded-none shadow-[0_0_20px_rgba(0,255,255,0.2)] bg-card p-1">
          <AvatarImage src={char.portraitUrl || char.portraitUrls?.[0] || ""} className="object-cover rounded-none" />
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
            disabled={!!pendingEdit}
            className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display tracking-widest disabled:opacity-50"
            data-testid="button-edit-character"
          >
            <Pencil className="w-4 h-4 mr-2" /> EDIT
          </Button>
          {isAdmin && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteOpen(true)}
              className="rounded-none border-destructive text-destructive hover:bg-destructive/10 font-display tracking-widest"
              data-testid="button-delete-character"
            >
              <Trash2 className="w-4 h-4 mr-2" /> DELETE
            </Button>
          )}
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

      <EditCharacterDialog character={char} open={editOpen} onOpenChange={setEditOpen} />
      {isAdmin && (
        <DeleteCharacterDialog character={char} open={deleteOpen} onOpenChange={setDeleteOpen} />
      )}

      <Tabs defaultValue="profile" className="w-full">
        <TabsList className="bg-card border border-border rounded-none p-0 h-auto flex overflow-x-auto w-full max-w-full no-scrollbar">
          <TabsTrigger value="profile" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-profile">
            <Terminal className="w-4 h-4 mr-2 hidden sm:inline" /> Profile
          </TabsTrigger>
          <TabsTrigger value="wallet" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-wallet">
            <Wallet className="w-4 h-4 mr-2 hidden sm:inline" /> Ledger
          </TabsTrigger>
          <TabsTrigger value="inventory" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-inv">
            <Package className="w-4 h-4 mr-2 hidden sm:inline" /> Inventory
          </TabsTrigger>
          <TabsTrigger value="cyberware" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-cyberware">
            <Cpu className="w-4 h-4 mr-2 hidden sm:inline" /> Cyberware
          </TabsTrigger>
          <TabsTrigger value="status" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-status">
            <Activity className="w-4 h-4 mr-2 hidden sm:inline" /> Status
          </TabsTrigger>
          <TabsTrigger value="missions" className="flex-1 rounded-none font-display uppercase tracking-widest data-[state=active]:bg-nc-cyan/10 data-[state=active]:text-nc-cyan data-[state=active]:border-b-2 data-[state=active]:border-nc-cyan py-3 min-w-[100px]" data-testid="tab-missions">
            <Briefcase className="w-4 h-4 mr-2 hidden sm:inline" /> Missions
          </TabsTrigger>
        </TabsList>

        <div className="mt-8">
          <TabsContent value="profile" className="space-y-6 outline-none focus:ring-0">
            <SheetSections sections={(char.sheetData as { sections?: Record<string, string> } | null | undefined)?.sections} background={char.background} />
            <HousingCard characterId={char.id} />
            <ImageGallery title="PORTRAITS" urls={char.portraitUrls ?? []} />
            <ImageGallery title="STATS / SHEET IMAGES" urls={char.statsImageUrls ?? []} />
            <UpdatesLog characterId={char.id} />
          </TabsContent>

          <TabsContent value="wallet" className="outline-none focus:ring-0">
            <WalletTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="inventory" className="outline-none focus:ring-0">
            <InventoryTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="cyberware" className="outline-none focus:ring-0">
            <CyberwareTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="status" className="outline-none focus:ring-0">
            <StatusTab characterId={char.id} />
          </TabsContent>

          <TabsContent value="missions" className="outline-none focus:ring-0">
            <MissionsTab characterId={char.id} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

function MissionsTab({ characterId }: { characterId: number }) {
  // Reuse the player-scope mission feed; the detail page is owner-only so any
  // mission this character was assigned to is in /missions/mine. We filter
  // down to missions whose assigned players include this specific character.
  const { data, isLoading } = useListMyMissions();
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
  // Weeks since this character's last checkup. Note: the household
  // streak (used for billing) takes the MAX(lastCheckupAt) across all
  // the owner's characters, so this number is only a hint — see the
  // dashboard for the actual billable streak.
  const weeksSince = last
    ? Math.max(1, Math.floor((Date.now() - last.getTime()) / (7 * 86400000)) + 1)
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
            <>No checkup recorded yet — household will bill at the max streak.</>
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

function CyberwareTab({ characterId }: { characterId: number }) {
  const { data: char, isLoading: charLoading } = useGetCharacter(characterId);
  const { data: items, isLoading: itemsLoading } = useGetCharacterInventory(characterId);

  if (charLoading || itemsLoading) {
    return <div className="text-nc-cyan font-mono animate-pulse">Scanning chrome subnet...</div>;
  }
  if (!char) return null;

  // Pull cyberware items out of the per-character inventory. We match on
  // category case-insensitively so legacy "Cyberware" / "cyberware" both
  // surface. Items with no category but a name that obviously reads as
  // chrome (e.g. "Mantis Blades") aren't auto-tagged here — set their
  // category in the inventory tab if you want them to appear.
  const chromeItems = (items ?? []).filter(
    (it) => (it.category ?? "").toLowerCase() === "cyberware",
  );

  // Try to find the cyberware section in the imported character sheet.
  const sections = (char.sheetData as { sections?: Record<string, string> } | null | undefined)?.sections ?? {};
  const cyberwareSheet = Object.entries(sections).find(([heading]) => isCyberwareHeading(heading));

  const level = (char.cyberwareLevel ?? "none").toLowerCase();
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
    const slotMatch = (it.notes ?? "").match(/slot\s*[:=]\s*([^,;\n]+)/i);
    const slot = (slotMatch?.[1] ?? "Other").trim().toUpperCase();
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
                              {it.equipped ? (
                                <Badge variant="outline" className="ml-2 rounded-none border-nc-cyan/60 text-nc-cyan text-[10px] py-0">
                                  EQUIPPED
                                </Badge>
                              ) : null}
                            </div>
                            {it.notes ? (
                              <div className="mt-0.5 text-xs text-muted-foreground truncate">{it.notes}</div>
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
    </div>
  );
}

function WalletTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: txs } = useGetWalletTransactions(characterId);
  const { data: wallet, isLoading: walletLoading } = useGetMyWallet();
  const transfer = useTransferEddies({
    mutation: {
      onSuccess: () => {
        // Balance lives on the user (Unbelievaboat); invalidate the per-user
        // pill in the TopBar and this character's ledger.
        qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
        qc.invalidateQueries({ queryKey: getGetWalletTransactionsQueryKey(characterId) });
        setTo(null);
        setAmount(0);
        setMemo("");
      },
    },
  });
  const [to, setTo] = useState<CharacterPickerValue>(null);
  const [amount, setAmount] = useState(0);
  const [memo, setMemo] = useState("");

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50" data-testid="card-wallet-account-notice">
        <CardContent className="py-4 flex items-start gap-3 font-mono text-sm text-muted-foreground">
          <Wallet className="w-4 h-4 mt-0.5 text-nc-cyan shrink-0" />
          <div>
            <span className="text-nc-cyan">EDDIES ARE ACCOUNT-LEVEL.</span> Your balance lives on your Discord profile via UnbelievaBoat
            and is shown in the top bar. All buys, sells, transfers, payouts, rent, and meds settle there in real time. The ledger
            below shows transactions tied to <span className="text-foreground">this character</span>.
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-none border-nc-cyan/40 bg-card/50" data-testid="card-wallet-balance">
        <CardHeader className="pb-2">
          <CardTitle className="font-display tracking-widest text-xs text-muted-foreground">LIVE BALANCE</CardTitle>
        </CardHeader>
        <CardContent className="font-mono">
          {walletLoading ? (
            <div className="text-nc-cyan animate-pulse">SYNCING…</div>
          ) : wallet ? (
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">CASH</div>
                <div className="text-2xl text-nc-green" data-testid="text-balance-cash">€${(wallet.cash ?? 0).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">BANK</div>
                <div className="text-2xl text-nc-cyan" data-testid="text-balance-bank">€${(wallet.bank ?? 0).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">TOTAL</div>
                <div className="text-2xl text-foreground" data-testid="text-balance-total">€${((wallet.cash ?? 0) + (wallet.bank ?? 0)).toLocaleString()}</div>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground italic">No wallet data.</div>
          )}
        </CardContent>
      </Card>

      <CheckupStreakCard characterId={characterId} />

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">TRANSFER EDDIES</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const toCharacterId = to?.id;
              if (!toCharacterId || amount <= 0) return;
              transfer.mutate({ id: characterId, data: { toCharacterId, amount, memo: memo || undefined } });
            }}
          >
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">TO</Label>
              <CharacterPicker value={to} onChange={setTo} testId="input-transfer-to" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">AMOUNT (€$)</Label>
              <Input type="number" min={1} value={amount || ""} onChange={(e) => setAmount(Number(e.target.value))} data-testid="input-transfer-amount" />
            </div>
            <div className="sm:col-span-4">
              <Label className="text-xs font-mono">MEMO</Label>
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} data-testid="input-transfer-memo" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={transfer.isPending || !to?.id || amount <= 0} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-transfer">
                {transfer.isPending ? "SENDING..." : "SEND"}
              </Button>
            </div>
          </form>
          {transfer.error && (
            <div className="mt-3 text-destructive font-mono text-sm" data-testid="text-transfer-error">
              Transfer failed. Check funds or try again.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader>
          <CardTitle className="font-display tracking-widest">LEDGER</CardTitle>
        </CardHeader>
        <CardContent>
          {!txs || txs.length === 0 ? (
            <div className="text-muted-foreground font-mono italic">No transactions yet.</div>
          ) : (
            <div className="space-y-1 font-mono text-sm" data-testid="list-wallet-txs">
              {txs.map((t) => (
                <div key={t.id} className="grid grid-cols-12 gap-2 border-b border-border/30 py-2 items-center">
                  <span className="col-span-3 text-muted-foreground">{new Date(t.createdAt).toLocaleString()}</span>
                  <span className="col-span-2 uppercase text-nc-cyan">{t.kind}</span>
                  <span className={`col-span-2 text-right ${t.amount < 0 ? "text-destructive" : "text-nc-green"}`}>
                    {t.amount < 0 ? "-" : "+"}€${Math.abs(t.amount)}
                  </span>
                  <span className="col-span-5 truncate text-muted-foreground">{t.counterpartyName ? `${t.counterpartyName} · ` : ""}{t.memo ?? ""}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InventoryTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: items, isLoading } = useGetCharacterInventory(characterId);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetCharacterInventoryQueryKey(characterId) });
    qc.invalidateQueries({ queryKey: getGetMyWalletQueryKey() });
    qc.invalidateQueries({ queryKey: getGetWalletTransactionsQueryKey(characterId) });
  };
  const addItem = useAddInventoryItem({ mutation: { onSuccess: invalidate } });
  const updateItem = useUpdateInventoryItem({ mutation: { onSuccess: invalidate } });
  const deleteItem = useRemoveInventoryItem({ mutation: { onSuccess: invalidate } });
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");
  const [transferItemId, setTransferItemId] = useState<number | null>(null);
  const [editItemId, setEditItemId] = useState<number | null>(null);

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Scanning personal stash...</div>;

  return (
    <div className="space-y-6">
      <Card className="rounded-none border-border bg-card/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest">ADD ITEM</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              addItem.mutate({
                id: characterId,
                data: { name: name.trim(), category: category || undefined, quantity: Math.max(1, quantity), notes: notes || undefined },
              });
              setName("");
              setCategory("");
              setQuantity(1);
              setNotes("");
            }}
          >
            <div className="sm:col-span-4">
              <Label className="text-xs font-mono">NAME</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-item-name" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">CATEGORY</Label>
              <Input value={category} onChange={(e) => setCategory(e.target.value)} data-testid="input-item-category" />
            </div>
            <div className="sm:col-span-1">
              <Label className="text-xs font-mono">QTY</Label>
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} data-testid="input-item-qty" />
            </div>
            <div className="sm:col-span-3">
              <Label className="text-xs font-mono">NOTES</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="input-item-notes" />
            </div>
            <div className="sm:col-span-1">
              <Button type="submit" disabled={addItem.isPending || !name.trim()} className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display" data-testid="button-add-item">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

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
                  <span className="col-span-3 text-foreground">{it.name}</span>
                  <span className="col-span-2 text-nc-cyan uppercase truncate">{it.category ?? "—"}</span>
                  <span className="col-span-1 text-right">x{it.quantity}</span>
                  <span className="col-span-2 truncate text-muted-foreground">{it.notes ?? ""}</span>
                  <label className="col-span-1 flex items-center gap-1 text-xs">
                    <UiSwitch
                      checked={!!it.equipped}
                      onCheckedChange={(v) => updateItem.mutate({ id: characterId, itemId: it.id, data: { equipped: v } })}
                      data-testid={`switch-equip-${it.id}`}
                    />
                    EQ
                  </label>
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
  item: { id: number; name: string; category?: string | null; quantity: number; notes?: string | null } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [notes, setNotes] = useState(item?.notes ?? "");
  const update = useUpdateInventoryItem({ mutation: { onSuccess: onDone } });
  if (!item) return null;
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
                  category: category.trim() || undefined,
                  quantity: Math.max(1, quantity),
                  notes: notes.trim() || undefined,
                },
              });
            }}
          >
            <div>
              <Label className="text-xs">NAME</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-edit-item-name" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">CATEGORY</Label>
                <Input value={category} onChange={(e) => setCategory(e.target.value)} data-testid="input-edit-item-category" />
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

function HousingCard({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: leases, isLoading } = useGetCharacterHousing(characterId);
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetCharacterHousingQueryKey(characterId) });
  const vacate = useVacateHousing({ mutation: { onSuccess: invalidate } });
  return (
    <Card className="rounded-none border-border bg-card/50" data-testid="card-housing">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="font-display tracking-widest text-nc-cyan flex items-center gap-2">
          <Home className="w-4 h-4" /> HOUSING
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="font-mono text-muted-foreground animate-pulse">Loading leases...</div>
        ) : !leases || leases.length === 0 ? (
          <p className="font-mono text-muted-foreground italic">
            No active leases. Browse the <a href="/catalog/rent" className="text-nc-cyan underline">housing catalog</a> to sign one.
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
                  <div className="flex-1">
                    <div className="text-foreground flex items-center gap-2">
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
  );
}

function StatusTab({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: status, isLoading } = useGetCharacterStatus(characterId);
  const update = useUpdateCharacterStatus({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getGetCharacterStatusQueryKey(characterId) }),
    },
  });
  const [message, setMessage] = useState("");
  const [loaReturnsAt, setLoaReturnsAt] = useState("");

  if (isLoading) return <div className="text-nc-cyan font-mono animate-pulse">Pinging biometric sensors...</div>;
  if (!status) return <div className="text-muted-foreground font-mono">No status data.</div>;

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader>
        <CardTitle className="font-display tracking-widest text-nc-cyan">STATUS</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 font-mono text-sm">
        <ToggleRow
          label="LOA (Leave of Absence)"
          checked={status.loa}
          onChange={(v) => update.mutate({ id: characterId, data: { loa: v } })}
          testid="switch-loa"
        />
        <ToggleRow
          label="ATTENDING (events/scenes)"
          checked={status.attending}
          onChange={(v) => update.mutate({ id: characterId, data: { attending: v } })}
          testid="switch-attending"
        />
        <ToggleRow
          label="OPEN SHOP (vendor)"
          checked={status.openShop}
          onChange={(v) => update.mutate({ id: characterId, data: { openShop: v } })}
          testid="switch-openshop"
        />

        {/* Daily "press to open shop" button — separate from the visible
            OPEN SHOP toggle above. The toggle is just a status flag; this
            button is what actually drives passive income on the next
            monthly_rent run. The endpoint enforces "owner of an active
            business lease" + "one click per UTC day" so a character with
            no lease never sees the action enabled. */}
        <ShopOpenSection characterId={characterId} />

        {status.loa && (
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-8">
              <Label className="text-xs">LOA RETURNS AT (ISO date/time)</Label>
              <Input
                value={loaReturnsAt || status.loaReturnsAt?.slice(0, 16) || ""}
                onChange={(e) => setLoaReturnsAt(e.target.value)}
                placeholder="2026-06-15T09:00"
                data-testid="input-loa-returns"
              />
            </div>
            <div className="col-span-4">
              <Button
                type="button"
                disabled={!loaReturnsAt}
                onClick={() => update.mutate({ id: characterId, data: { loaReturnsAt } })}
                className="w-full rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
                data-testid="button-save-loa-date"
              >
                SAVE DATE
              </Button>
            </div>
          </div>
        )}

        <div>
          <Label className="text-xs">STATUS MESSAGE</Label>
          <Textarea
            value={message || status.statusMessage || ""}
            onChange={(e) => setMessage(e.target.value)}
            data-testid="textarea-status-message"
          />
          <Button
            type="button"
            className="mt-2 rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
            onClick={() => update.mutate({ id: characterId, data: { statusMessage: message } })}
            data-testid="button-save-status-message"
          >
            UPDATE MESSAGE
          </Button>
        </div>

        <div className="text-xs text-muted-foreground">
          Last updated: {new Date(status.updatedAt).toLocaleString()}
        </div>
      </CardContent>
    </Card>
  );
}

interface ShopOpenInfo {
  characterId: number;
  canOpen: boolean;
  openedToday: boolean;
  opensThisMonth: number;
  opensCountedForIncome: number;
  businessLeases: Array<{ id: number; address: string; monthlyRent: number }>;
  history: Array<{ openedOn: string; openedAt: string }>;
}

// Card slot inside StatusTab for the OPEN SHOP TODAY action. Hidden
// entirely when the character has no active business lease — there's no
// useful UI for "you can't open a shop you don't own."
function ShopOpenSection({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const queryKey = ["character-shop", characterId] as const;
  const { data, isLoading } = useQuery<ShopOpenInfo>({
    queryKey,
    queryFn: async () => {
      const r = await fetch(`/api/characters/${characterId}/shop`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load shop status");
      return r.json();
    },
  });
  const open = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/characters/${characterId}/open-shop`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok && r.status !== 409) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  if (isLoading || !data) return null;
  if (!data.canOpen) return null;

  const lease = data.businessLeases[0];
  // The cron caps paying opens at 4/month — anything past that is still
  // recorded for history but doesn't add to income. Surface both numbers
  // so a 6-open month doesn't read as a bug.
  const capped = data.opensThisMonth > data.opensCountedForIncome;
  const disabled = data.openedToday || open.isPending;

  return (
    <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-display tracking-widest text-nc-magenta text-sm">SHOP STATUS</div>
          <div className="text-xs text-muted-foreground mt-1">
            {lease ? `${lease.address} · €$${lease.monthlyRent.toLocaleString()}/mo` : "Business lease"}
          </div>
        </div>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => open.mutate()}
          className="rounded-none bg-nc-magenta text-background hover:bg-nc-magenta/80 font-display tracking-widest disabled:opacity-50"
          data-testid="button-open-shop-today"
        >
          {data.openedToday ? "OPENED TODAY ✓" : open.isPending ? "OPENING..." : "OPEN SHOP TODAY"}
        </Button>
      </div>
      <div className="text-xs font-mono text-muted-foreground">
        OPENS_THIS_MONTH: <span className="text-nc-cyan">{data.opensCountedForIncome}/4</span>
        {capped && <span className="text-nc-yellow"> (+{data.opensThisMonth - data.opensCountedForIncome} past cap)</span>}
        {" · "}NEXT_CHARGE: monthly rent cycle
      </div>
      {open.error instanceof Error && (
        <div className="text-xs font-mono text-destructive">ERR: {open.error.message}</div>
      )}
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

function ToggleRow({ label, checked, onChange, testid }: { label: string; checked: boolean; onChange: (v: boolean) => void; testid: string }) {
  return (
    <div className="flex items-center justify-between border border-border/40 p-3">
      <span className="text-foreground">{label}</span>
      <UiSwitch checked={checked} onCheckedChange={onChange} data-testid={testid} />
    </div>
  );
}

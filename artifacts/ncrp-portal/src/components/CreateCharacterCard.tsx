import { useState } from "react";
import { apiErrorMessage } from "@/lib/apiError";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminCreateCharacter,
  getAdminListCharactersQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ImageEditor from "@/components/ImageEditor";
import CyberwareEditor, { type CyberRow } from "@/components/CyberwareEditor";
import OwnerPicker from "@/components/OwnerPicker";

// Admin/fixer form to hand-create a character that skips the player sheet
// pipeline: type the details, optionally attach an owner + portraits, and it
// lands APPROVED immediately. Collapsed by default to keep the page tidy.
export default function CreateCharacterCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"pc" | "npc">("pc");
  const [ownerId, setOwnerId] = useState("");
  const [archetype, setArchetype] = useState("");
  const [background, setBackground] = useState("");
  const [lifeStatus, setLifeStatus] = useState<"active" | "dead" | "missing" | "loa" | "retired">("active");
  const [portraitUrls, setPortraitUrls] = useState<string[]>([]);
  const [profileUrl, setProfileUrl] = useState<string | null>(null);
  const [statsImageUrls, setStatsImageUrls] = useState<string[]>([]);
  const [traumaTeamTier, setTraumaTeamTier] = useState<string>("");
  const [xanaduGold, setXanaduGold] = useState<boolean>(false);
  const [preamble, setPreamble] = useState("");
  const [sectionRows, setSectionRows] = useState<Array<{ key: string; value: string }>>([]);
  const [cyberRows, setCyberRows] = useState<CyberRow[]>([]);

  const reset = () => {
    setName("");
    setKind("pc");
    setOwnerId("");
    setArchetype("");
    setBackground("");
    setLifeStatus("active");
    setPortraitUrls([]);
    setProfileUrl(null);
    setStatsImageUrls([]);
    setTraumaTeamTier("");
    setXanaduGold(false);
    setPreamble("");
    setSectionRows([]);
    setCyberRows([]);
  };

  const create = useAdminCreateCharacter({
    mutation: {
      onSuccess: (c) => {
        qc.invalidateQueries({ queryKey: getAdminListCharactersQueryKey() });
        toast({ title: "Character created", description: `${c.name} is live and approved.` });
        reset();
        setOpen(false);
      },
      onError: (err) =>
        toast({ title: "Create failed", description: apiErrorMessage(err, "Create failed"), variant: "destructive" }),
    },
  });

  const submit = () => {
    if (!name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    const sections: Record<string, string> = {};
    for (const r of sectionRows) {
      const k = r.key.trim();
      if (k) sections[k] = r.value;
    }
    const hasSheet = preamble.trim() !== "" || Object.keys(sections).length > 0;
    // profileUrl is the chosen primary portrait; surface it first so the legacy
    // single-portrait column picks it up on the server.
    const orderedPortraits =
      profileUrl && portraitUrls.includes(profileUrl)
        ? [profileUrl, ...portraitUrls.filter((u) => u !== profileUrl)]
        : portraitUrls;
    create.mutate({
      data: {
        name: name.trim(),
        kind,
        ownerId: ownerId || null,
        archetype: archetype.trim() || null,
        background: background.trim() || null,
        lifeStatus,
        portraitUrls: orderedPortraits,
        statsImageUrls,
        traumaTeamTier: (traumaTeamTier || null) as
          | "silver"
          | "gold"
          | "platinum"
          | "diamond"
          | "corporate"
          | null,
        xanaduGold,
        sheetData: hasSheet ? { preamble, sections } : undefined,
        cyberware: cyberRows
          .filter((r) => (r.name.trim() || r.slot.trim()) !== "")
          .map((r) => ({
            slot: r.slot.trim(),
            name: r.name.trim() || r.slot.trim(),
            points: Number(r.points) || 0,
            notes: r.notes.trim(),
          })),
      },
    });
  };

  const inputCls = "h-9 px-2 text-sm bg-background border border-border w-full";

  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle className="font-display text-nc-cyan">Create Character</CardTitle>
          <CardDescription className="font-mono">
            Manually add a character (skips the sheet review queue). Lands approved &amp; active.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-none font-display text-xs"
          onClick={() => setOpen((o) => !o)}
          data-testid="button-toggle-create-character"
        >
          {open ? "CANCEL" : "NEW CHARACTER"}
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">NAME *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="V"
                className={inputCls}
                data-testid="input-create-char-name"
              />
            </div>
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">TYPE</Label>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as "pc" | "npc")}
                className={inputCls}
                data-testid="select-create-char-kind"
              >
                <option value="pc">PC</option>
                <option value="npc">NPC</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">OWNER (optional)</Label>
              <OwnerPicker
                value={ownerId}
                onChange={(id) => setOwnerId(id)}
                testIdPrefix="create-char-owner"
              />
            </div>
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">LIFE STATUS</Label>
              <select
                value={lifeStatus}
                onChange={(e) => setLifeStatus(e.target.value as typeof lifeStatus)}
                className={inputCls}
                data-testid="select-create-char-lifestatus"
              >
                {["active", "dead", "missing", "loa", "retired"].map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">ARCHETYPE (optional)</Label>
              <Input
                value={archetype}
                onChange={(e) => setArchetype(e.target.value)}
                placeholder="Solo, Netrunner, Fixer…"
                className={inputCls}
                data-testid="input-create-char-archetype"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="font-display text-xs text-muted-foreground">BACKGROUND (optional)</Label>
            <textarea
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              rows={4}
              placeholder="A short bio…"
              className="px-2 py-2 text-sm bg-background border border-border w-full font-mono"
              data-testid="textarea-create-char-background"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">TRAUMA TEAM SUBSCRIPTION</Label>
              <select
                value={traumaTeamTier}
                onChange={(e) => setTraumaTeamTier(e.target.value)}
                className={inputCls}
                data-testid="select-create-char-trauma-tier"
              >
                <option value="">None</option>
                <option value="silver">Silver</option>
                <option value="gold">Gold</option>
                <option value="platinum">Platinum</option>
                <option value="diamond">Diamond</option>
                <option value="corporate">Corporate (Comp)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">XANADU GOLD</Label>
              <label className="flex h-9 items-center gap-3 border border-border bg-background px-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={xanaduGold}
                  onChange={(e) => setXanaduGold(e.target.checked)}
                  className="accent-nc-cyan"
                  data-testid="checkbox-create-char-xanadu-gold"
                />
                <span className="text-xs font-mono uppercase tracking-widest text-nc-cyan">
                  {xanaduGold ? "Active" : "Inactive"}
                </span>
              </label>
            </div>
          </div>

          {/* Sheet sections + preamble (parity with player sheet / edit dialog) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <Label className="font-display text-xs text-muted-foreground">SHEET SECTIONS (optional)</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none font-display text-xs"
                onClick={() => setSectionRows((r) => [...r, { key: "", value: "" }])}
                data-testid="button-create-char-add-section"
              >
                + ADD SECTION
              </Button>
            </div>
            {sectionRows.map((row, idx) => (
              <div
                key={idx}
                className="border border-border/40 p-3 space-y-2 bg-card/30"
                data-testid={`create-char-section-row-${idx}`}
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setSectionRows((rs) => rs.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
                    }
                    placeholder="Section name (e.g. Backstory)"
                    className="flex-1"
                    data-testid={`input-create-char-section-key-${idx}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive h-8 w-8 shrink-0"
                    onClick={() => setSectionRows((rs) => rs.filter((_, i) => i !== idx))}
                    data-testid={`button-create-char-remove-section-${idx}`}
                  >
                    ×
                  </Button>
                </div>
                <textarea
                  value={row.value}
                  onChange={(e) =>
                    setSectionRows((rs) => rs.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
                  }
                  rows={3}
                  placeholder="Section content…"
                  className="px-2 py-2 text-sm bg-background border border-border w-full font-mono"
                  data-testid={`input-create-char-section-value-${idx}`}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="font-display text-xs text-muted-foreground">PREAMBLE (text above the sections)</Label>
              <textarea
                value={preamble}
                onChange={(e) => setPreamble(e.target.value)}
                rows={3}
                placeholder="Optional intro text…"
                className="px-2 py-2 text-sm bg-background border border-border w-full font-mono"
                data-testid="input-create-char-preamble"
              />
            </div>
          </div>

          {/* Portraits */}
          <ImageEditor
            title="PORTRAITS"
            urls={portraitUrls}
            onChange={setPortraitUrls}
            profileUrl={profileUrl}
            onSetProfile={setProfileUrl}
            allowProfile
            testIdPrefix="create-char-portrait"
          />

          {/* Stats / sheet images */}
          <ImageEditor
            title="STATS / SHEET IMAGES"
            urls={statsImageUrls}
            onChange={setStatsImageUrls}
            testIdPrefix="create-char-stats"
          />

          {/* Cyberware */}
          <CyberwareEditor rows={cyberRows} onChange={setCyberRows} testIdPrefix="create-char" />

          <div className="flex justify-end gap-2 pt-2">
            <Button
              size="sm"
              disabled={create.isPending || !name.trim()}
              onClick={submit}
              className="rounded-none font-display text-xs bg-nc-cyan text-background"
              data-testid="button-submit-create-character"
            >
              {create.isPending ? "CREATING…" : "CREATE CHARACTER"}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

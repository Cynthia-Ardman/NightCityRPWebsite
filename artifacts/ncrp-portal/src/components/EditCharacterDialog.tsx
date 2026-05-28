import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  useUpdateCharacter,
  getGetCharacterPendingEditQueryKey,
  getListPendingEditsQueryKey,
  type Character,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Upload, Star, X, ImagePlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { uploadImage } from "@/lib/uploadImage";

type SectionRow = { key: string; value: string };

function sectionsToRows(sections: Record<string, string> | undefined): SectionRow[] {
  if (!sections) return [];
  return Object.entries(sections).map(([key, value]) => ({ key, value: value ?? "" }));
}

function rowsToSections(rows: SectionRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
}

export default function EditCharacterDialog({
  character,
  open,
  onOpenChange,
}: {
  character: Character;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const [name, setName] = useState(character.name);
  const [archetype, setArchetype] = useState(character.archetype ?? "");
  const [background, setBackground] = useState(character.background ?? "");
  const [preamble, setPreamble] = useState(character.sheetData?.preamble ?? "");
  const [rows, setRows] = useState<SectionRow[]>(
    sectionsToRows(character.sheetData?.sections),
  );
  const [portraitUrl, setPortraitUrl] = useState<string | null>(character.portraitUrl ?? null);
  const [portraitUrls, setPortraitUrls] = useState<string[]>(character.portraitUrls ?? []);
  const [statsImageUrls, setStatsImageUrls] = useState<string[]>(character.statsImageUrls ?? []);
  const [lifeStatus, setLifeStatus] = useState<string>(character.lifeStatus ?? "active");
  const [updateNote, setUpdateNote] = useState<string>("");

  // Reset form state every time we re-open with a different character or after
  // server-side changes (avoids leaking stale form state across opens).
  useEffect(() => {
    if (!open) return;
    setName(character.name);
    setArchetype(character.archetype ?? "");
    setBackground(character.background ?? "");
    setPreamble(character.sheetData?.preamble ?? "");
    setRows(sectionsToRows(character.sheetData?.sections));
    setPortraitUrl(character.portraitUrl ?? null);
    setPortraitUrls(character.portraitUrls ?? []);
    setStatsImageUrls(character.statsImageUrls ?? []);
    setLifeStatus(character.lifeStatus ?? "active");
    setUpdateNote("");
  }, [open, character]);

  // Saving no longer applies the change directly — the API now queues the
  // edit as a pending_character_edit awaiting a fixer-majority approval.
  // The 202 response carries the queued edit id; on 409 we point the
  // user at the existing pending edit so they can amend it instead.
  const update = useUpdateCharacter({
    mutation: {
      onSuccess: (resp) => {
        const editId = (resp as { pendingEditId?: number } | undefined)?.pendingEditId;
        toast({
          title: "Submitted for review",
          description: `${character.name}'s edit is awaiting fixer approval.`,
        });
        qc.invalidateQueries({ queryKey: getGetCharacterPendingEditQueryKey(character.id) });
        qc.invalidateQueries({ queryKey: getListPendingEditsQueryKey() });
        onOpenChange(false);
        if (editId) navigate(`/pending-edits/${editId}`);
      },
      onError: (err) => {
        const data = (err as { response?: { data?: { error?: string; pendingEditId?: number } } } | null)?.response?.data;
        if (data?.pendingEditId) {
          toast({
            title: "Edit already pending",
            description: "There's already a pending edit for this character. Opening it now.",
          });
          onOpenChange(false);
          navigate(`/pending-edits/${data.pendingEditId}`);
          return;
        }
        toast({ title: "Save failed", description: data?.error ?? "Save failed", variant: "destructive" });
      },
    },
  });

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    update.mutate({
      id: character.id,
      data: {
        name: name.trim(),
        archetype: archetype.trim() || undefined,
        background: background,
        portraitUrl: portraitUrl,
        portraitUrls,
        statsImageUrls,
        sheetData: { preamble, sections: rowsToSections(rows) },
        lifeStatus: lifeStatus as "active" | "dead" | "missing" | "loa" | "retired",
        updateNote: updateNote.trim() || undefined,
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl max-h-[90vh] overflow-y-auto rounded-none border-nc-cyan bg-background"
        data-testid="dialog-edit-character"
      >
        <DialogHeader>
          <DialogTitle className="font-display tracking-widest text-nc-cyan text-2xl">
            EDIT: {character.name}
          </DialogTitle>
        </DialogHeader>

        <form className="space-y-6 font-mono text-sm" onSubmit={save}>
          {/* Identity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">NAME</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                data-testid="input-edit-name"
              />
            </div>
            <div>
              <Label className="text-xs">ARCHETYPE</Label>
              <Input
                value={archetype}
                onChange={(e) => setArchetype(e.target.value)}
                data-testid="input-edit-archetype"
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">STATUS</Label>
            <select
              value={lifeStatus}
              onChange={(e) => setLifeStatus(e.target.value)}
              className="flex h-10 w-full rounded-none border border-input bg-background px-3 py-2 text-sm font-mono uppercase tracking-widest text-nc-cyan focus:outline-none focus:ring-1 focus:ring-nc-cyan"
              data-testid="select-edit-life-status"
            >
              <option value="active">Active</option>
              <option value="dead">Dead</option>
              <option value="missing">Missing</option>
              <option value="loa">LOA</option>
              <option value="retired">Retired</option>
            </select>
          </div>

          {/* Background */}
          <div>
            <Label className="text-xs">BACKGROUND / DOSSIER SUMMARY</Label>
            <Textarea
              value={background}
              onChange={(e) => setBackground(e.target.value)}
              rows={6}
              data-testid="input-edit-background"
            />
          </div>

          {/* Sheet sections */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <Label className="text-xs tracking-widest text-nc-cyan">SHEET SECTIONS</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-none font-display"
                onClick={() => setRows((r) => [...r, { key: "", value: "" }])}
                data-testid="button-add-section"
              >
                <Plus className="w-3 h-3 mr-1" /> ADD SECTION
              </Button>
            </div>
            {rows.length === 0 && (
              <div className="text-muted-foreground italic">No sections. Add one above.</div>
            )}
            {rows.map((row, idx) => (
              <div
                key={idx}
                className="border border-border/40 p-3 space-y-2 bg-card/30"
                data-testid={`section-row-${idx}`}
              >
                <div className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))
                    }
                    placeholder="Section name (e.g. Backstory)"
                    className="flex-1"
                    data-testid={`input-section-key-${idx}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-destructive h-8 w-8 shrink-0"
                    onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                    data-testid={`button-remove-section-${idx}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
                <Textarea
                  value={row.value}
                  onChange={(e) =>
                    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))
                  }
                  rows={4}
                  data-testid={`input-section-value-${idx}`}
                />
              </div>
            ))}
            <div>
              <Label className="text-xs">PREAMBLE (text above the labeled sections)</Label>
              <Textarea
                value={preamble}
                onChange={(e) => setPreamble(e.target.value)}
                rows={3}
                data-testid="input-edit-preamble"
              />
            </div>
          </div>

          {/* Portraits */}
          <ImageEditor
            title="PORTRAITS"
            urls={portraitUrls}
            onChange={setPortraitUrls}
            profileUrl={portraitUrl}
            onSetProfile={setPortraitUrl}
            allowProfile
            testIdPrefix="portrait"
          />

          {/* Stats */}
          <ImageEditor
            title="STATS / SHEET IMAGES"
            urls={statsImageUrls}
            onChange={setStatsImageUrls}
            testIdPrefix="stats"
          />

          {/* Update note (commit-message style) */}
          <div className="border-t border-border pt-4">
            <Label className="text-xs">UPDATE NOTE (OPTIONAL)</Label>
            <Textarea
              value={updateNote}
              onChange={(e) => setUpdateNote(e.target.value)}
              placeholder="What changed? e.g. Installed Sandevistan MK.3, retconned backstory, etc."
              rows={3}
              maxLength={2000}
              data-testid="input-edit-update-note"
            />
            <p className="text-xs font-mono text-muted-foreground mt-1">
              If filled in, this note is appended to the character's update log (visible at the bottom of the profile).
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              className="rounded-none font-display"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-edit"
            >
              CANCEL
            </Button>
            <Button
              type="submit"
              disabled={update.isPending}
              className="rounded-none bg-nc-cyan text-background hover:bg-nc-cyan/80 font-display"
              data-testid="button-save-edit"
            >
              {update.isPending ? "SUBMITTING..." : "SUBMIT FOR REVIEW"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImageEditor({
  title,
  urls,
  onChange,
  profileUrl,
  onSetProfile,
  allowProfile,
  testIdPrefix,
}: {
  title: string;
  urls: string[];
  onChange: (next: string[]) => void;
  profileUrl?: string | null;
  onSetProfile?: (url: string) => void;
  allowProfile?: boolean;
  testIdPrefix: string;
}) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-uploading the same file
    if (files.length === 0) return;
    setUploading(true);
    const added: string[] = [];
    try {
      for (const f of files) {
        const url = await uploadImage(f);
        added.push(url);
      }
      onChange([...urls, ...added]);
      // If this is the portraits list and no profile is set yet, default the
      // first newly-uploaded portrait as the profile image — saves a click.
      if (allowProfile && onSetProfile && !profileUrl && added.length > 0) {
        onSetProfile(added[0]);
      }
      toast({ title: "Upload complete", description: `${added.length} image(s) added.` });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Upload failed";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <Label className="text-xs tracking-widest text-nc-cyan">{title}</Label>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPick}
            data-testid={`input-upload-${testIdPrefix}`}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-none font-display"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
            data-testid={`button-upload-${testIdPrefix}`}
          >
            {uploading ? (
              <>
                <Upload className="w-3 h-3 mr-1 animate-pulse" /> UPLOADING...
              </>
            ) : (
              <>
                <ImagePlus className="w-3 h-3 mr-1" /> UPLOAD IMAGE
              </>
            )}
          </Button>
        </div>
      </div>
      {urls.length === 0 ? (
        <div className="text-muted-foreground italic">No images yet.</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {urls.map((u, i) => {
            const isProfile = allowProfile && profileUrl === u;
            return (
              <div
                key={`${u}-${i}`}
                className={`relative border ${isProfile ? "border-nc-cyan shadow-[0_0_10px_rgba(0,255,255,0.3)]" : "border-border"} bg-background p-1`}
                data-testid={`img-card-${testIdPrefix}-${i}`}
              >
                <img src={u} alt={`${title} ${i + 1}`} className="w-full h-32 object-contain" loading="lazy" />
                <div className="flex justify-between items-center mt-1 gap-1">
                  {allowProfile && onSetProfile ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className={`h-7 px-2 text-xs ${isProfile ? "text-nc-cyan" : "text-muted-foreground hover:text-nc-cyan"}`}
                      onClick={() => onSetProfile(u)}
                      disabled={isProfile}
                      data-testid={`button-set-profile-${i}`}
                    >
                      <Star className={`w-3 h-3 mr-1 ${isProfile ? "fill-nc-cyan" : ""}`} />
                      {isProfile ? "PROFILE" : "SET PROFILE"}
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-destructive h-7 w-7"
                    onClick={() => {
                      onChange(urls.filter((_, idx) => idx !== i));
                      if (allowProfile && onSetProfile && profileUrl === u) onSetProfile("");
                    }}
                    data-testid={`button-remove-img-${testIdPrefix}-${i}`}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

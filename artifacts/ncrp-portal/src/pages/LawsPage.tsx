import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNcpdLaws,
  getListNcpdLawsQueryKey,
  useCreateNcpdLaw,
  useUpdateNcpdLaw,
  useDeleteNcpdLaw,
  type NcpdLaw,
} from "@workspace/api-client-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Markdown from "@/components/Markdown";
import { Scale, Plus, Pencil, Trash2, X, Lock } from "lucide-react";

function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  const msg = (data as { error?: unknown } | null)?.error;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

function severityBadge(severity?: string | null) {
  if (!severity) return null;
  const cls =
    severity === "felony"
      ? "border-destructive text-destructive"
      : severity === "misdemeanor"
        ? "border-nc-yellow text-nc-yellow"
        : "border-nc-cyan text-nc-cyan";
  return (
    <Badge variant="outline" className={`rounded-none uppercase font-display text-[10px] ${cls}`}>
      {severity}
    </Badge>
  );
}

// Public Book of Laws. Everyone can read title + statute text; severity,
// punishment and internal notes are RESTRICTED — the server strips them for
// non-NCPD viewers, so their mere presence here means the viewer is cleared.
// Editing is Commissioner / fixer / admin only (server-enforced too).
export default function LawsPage() {
  const me = useEffectiveMe();
  const canEdit = !!(me.data?.isNcpdCommissioner || me.data?.isFixer || me.data?.isAdmin);
  // The server already strips restricted fields for non-privileged viewers;
  // this extra gate keeps "View as player" honest for admins, whose API
  // responses still contain the restricted fields.
  const canSeeRestricted = !!(
    me.data?.isNcpd ||
    me.data?.isNcpdCommissioner ||
    me.data?.isFixer ||
    me.data?.isAdmin
  );
  const qc = useQueryClient();
  const { data, isLoading } = useListNcpdLaws();
  const laws = data ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<NcpdLaw | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: getListNcpdLawsQueryKey() });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (law: NcpdLaw) => {
    setEditing(law);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-4xl font-display text-foreground flex items-center gap-3" data-testid="text-laws-title">
            <Scale className="w-8 h-8 text-nc-cyan" /> BOOK OF LAWS
          </h1>
          <p className="font-mono text-muted-foreground mt-2">The official statutes of Night City.</p>
        </div>
        {canEdit && (
          <Button variant="outline" className="rounded-none font-display" onClick={() => (formOpen && !editing ? closeForm() : openCreate())} data-testid="button-law-add">
            {formOpen && !editing ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />}
            {formOpen && !editing ? "CANCEL" : "ADD LAW"}
          </Button>
        )}
      </div>

      {err && (
        <div className="border border-destructive/50 bg-destructive/10 text-destructive font-mono text-sm px-4 py-2" data-testid="text-laws-error">
          {err}
        </div>
      )}

      {formOpen && canEdit && (
        <LawForm
          key={editing?.id ?? "new"}
          law={editing}
          onDone={() => {
            closeForm();
            invalidate();
          }}
          onError={setErr}
        />
      )}

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">LOADING STATUTES...</div>
      ) : !laws.length ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-8 font-mono text-muted-foreground text-center">No laws on the books yet.</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {laws.map((law, i) => (
            <Card key={law.id} className="rounded-none border-border bg-card/50" data-testid={`card-law-${law.id}`}>
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <CardTitle className="font-display tracking-wider text-lg flex items-center gap-3 flex-wrap">
                  <span className="text-muted-foreground font-mono text-sm">§{i + 1}</span> {law.title}
                  {canSeeRestricted && severityBadge(law.severity)}
                </CardTitle>
                {canEdit && (
                  <div className="flex gap-1 shrink-0">
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(law)} data-testid={`button-law-edit-${law.id}`}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <DeleteLawButton law={law} onError={setErr} onDone={invalidate} />
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{law.body}</Markdown>
                {canSeeRestricted && (law.punishment || law.restrictedNotes) && (
                  <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-3 space-y-2" data-testid={`section-law-restricted-${law.id}`}>
                    <p className="font-display text-[10px] uppercase tracking-widest text-nc-magenta flex items-center gap-1">
                      <Lock className="w-3 h-3" /> NCPD Restricted
                    </p>
                    {law.punishment && (
                      <p className="font-mono text-sm">
                        <span className="text-muted-foreground uppercase text-xs">Punishment:</span> {law.punishment}
                      </p>
                    )}
                    {law.restrictedNotes && (
                      <p className="font-mono text-sm text-foreground/80 whitespace-pre-wrap">{law.restrictedNotes}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteLawButton({ law, onError, onDone }: { law: NcpdLaw; onError: (m: string | null) => void; onDone: () => void }) {
  const del = useDeleteNcpdLaw();
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7 text-destructive"
      disabled={del.isPending}
      onClick={() => {
        onError(null);
        del.mutate(
          { id: law.id },
          { onSuccess: onDone, onError: (e) => onError(apiErrorMessage(e, "Failed to delete law")) },
        );
      }}
      data-testid={`button-law-delete-${law.id}`}
    >
      <Trash2 className="w-3.5 h-3.5" />
    </Button>
  );
}

const NO_SEVERITY = "none";

function LawForm({ law, onDone, onError }: { law: NcpdLaw | null; onDone: () => void; onError: (m: string | null) => void }) {
  const [title, setTitle] = useState(law?.title ?? "");
  const [body, setBody] = useState(law?.body ?? "");
  const [severity, setSeverity] = useState<string>(law?.severity ?? NO_SEVERITY);
  const [punishment, setPunishment] = useState(law?.punishment ?? "");
  const [restrictedNotes, setRestrictedNotes] = useState(law?.restrictedNotes ?? "");
  const [sortOrder, setSortOrder] = useState<string>(law?.sortOrder != null ? String(law.sortOrder) : "");
  const create = useCreateNcpdLaw();
  const update = useUpdateNcpdLaw();

  const submit = () => {
    onError(null);
    const payload = {
      title,
      body,
      severity: severity === NO_SEVERITY ? null : (severity as "infraction" | "misdemeanor" | "felony"),
      punishment: punishment.trim() ? punishment : null,
      restrictedNotes: restrictedNotes.trim() ? restrictedNotes : null,
      ...(sortOrder.trim() !== "" && Number.isFinite(Number(sortOrder)) ? { sortOrder: Number(sortOrder) } : {}),
    };
    if (law) {
      update.mutate(
        { id: law.id, data: payload },
        { onSuccess: onDone, onError: (e) => onError(apiErrorMessage(e, "Failed to update law")) },
      );
    } else {
      create.mutate(
        { data: payload },
        { onSuccess: onDone, onError: (e) => onError(apiErrorMessage(e, "Failed to create law")) },
      );
    }
  };

  return (
    <Card className="rounded-none border-nc-cyan/40 bg-card/70">
      <CardHeader className="pb-3">
        <CardTitle className="font-display tracking-widest text-sm">{law ? "EDIT LAW" : "NEW LAW"}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-none" data-testid="input-law-title" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Sort order (optional)</Label>
            <Input value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} type="number" className="rounded-none" data-testid="input-law-sort" />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="font-mono text-xs uppercase">Statute text (public)</Label>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="rounded-none" data-testid="input-law-body" />
        </div>
        <div className="border border-nc-magenta/40 bg-nc-magenta/5 p-3 space-y-3">
          <p className="font-display text-[10px] uppercase tracking-widest text-nc-magenta flex items-center gap-1">
            <Lock className="w-3 h-3" /> Restricted — visible to NCPD / fixers / admins only
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="font-mono text-xs uppercase">Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="rounded-none font-mono" data-testid="select-law-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SEVERITY}>Unclassified</SelectItem>
                  <SelectItem value="infraction">Infraction</SelectItem>
                  <SelectItem value="misdemeanor">Misdemeanor</SelectItem>
                  <SelectItem value="felony">Felony</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="font-mono text-xs uppercase">Punishment</Label>
              <Input value={punishment} onChange={(e) => setPunishment(e.target.value)} className="rounded-none" data-testid="input-law-punishment" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Internal notes</Label>
            <Textarea value={restrictedNotes} onChange={(e) => setRestrictedNotes(e.target.value)} rows={3} className="rounded-none" data-testid="input-law-notes" />
          </div>
        </div>
        <Button
          className="rounded-none font-display"
          disabled={!title.trim() || !body.trim() || create.isPending || update.isPending}
          onClick={submit}
          data-testid="button-law-submit"
        >
          {law ? "SAVE CHANGES" : "CREATE LAW"}
        </Button>
      </CardContent>
    </Card>
  );
}

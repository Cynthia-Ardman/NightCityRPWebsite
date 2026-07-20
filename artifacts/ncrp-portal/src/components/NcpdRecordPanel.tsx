import { formatDate } from "@/lib/format";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetNcpdRecord,
  getGetNcpdRecordQueryKey,
  getListNcpdReportsQueryKey,
  getListNcpdWarrantsQueryKey,
  useCreateNcpdReport,
  useUpdateNcpdReport,
  useDeleteNcpdReport,
  useCreateNcpdWarrant,
  useUpdateNcpdWarrant,
  useDeleteNcpdWarrant,
  useCreateNcpdNote,
  useDeleteNcpdNote,
  useCreateNcpdFine,
  useVoidNcpdFine,
  type NcpdReport,
  type NcpdWarrant,
  type NcpdRecord,
  type NcpdFine,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import Markdown from "@/components/Markdown";
import { FileText, AlertTriangle, StickyNote, Plus, Trash2, Pencil, X, UserSearch, Banknote } from "lucide-react";

function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  const msg = (data as { error?: unknown } | null)?.error;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return formatDate(d);
}

export function warrantStatusClass(status: string): string {
  switch (status) {
    case "open":
      return "border-destructive text-destructive";
    case "served":
      return "border-nc-green text-nc-green";
    default:
      return "border-muted-foreground text-muted-foreground";
  }
}

// Full NCPD record for one character: arrest reports, warrants and internal
// notes, with inline create/edit/delete. Rendered ONLY behind the NCPD/fixer/
// admin gate (parent components must not mount this for other viewers — the
// API enforces the same gate server-side regardless).
export default function NcpdRecordPanel({ characterId }: { characterId: number }) {
  const qc = useQueryClient();
  const { data: record, isLoading, error } = useGetNcpdRecord(characterId);
  const [err, setErr] = useState<string | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetNcpdRecordQueryKey(characterId) });
    qc.invalidateQueries({ queryKey: getListNcpdReportsQueryKey() });
    qc.invalidateQueries({ queryKey: getListNcpdWarrantsQueryKey() });
  };

  if (isLoading) {
    return <div className="text-nc-cyan font-display animate-pulse py-8 text-center">ACCESSING NCPD DATABASE...</div>;
  }
  if (error || !record) {
    return (
      <Card className="rounded-none border-border bg-card/50">
        <CardContent className="py-8 font-mono text-muted-foreground text-center">
          {apiErrorMessage(error, "Record unavailable.")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {err && (
        <div className="border border-destructive/50 bg-destructive/10 text-destructive font-mono text-sm px-4 py-2" data-testid="text-ncpd-error">
          {err}
        </div>
      )}
      <DossierSection record={record} />
      <WarrantsSection characterId={characterId} warrants={record.warrants} onError={setErr} onChanged={invalidate} />
      <FinesSection characterId={characterId} fines={record.fines ?? []} onError={setErr} onChanged={invalidate} />
      <ReportsSection characterId={characterId} reports={record.reports} onError={setErr} onChanged={invalidate} />
      <NotesSection characterId={characterId} notes={record.notes} onError={setErr} onChanged={invalidate} />
    </div>
  );
}

function DossierField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <div className="font-mono text-sm text-foreground/90">{children}</div>
    </div>
  );
}

// Intel summary the department pulls from the rest of the portal: identity,
// known affiliations (tags), where the subject works, what they own, where
// they live, and how flush their account is. All read-only — the source of
// truth for each field lives on its own admin surface.
function DossierSection({ record }: { record: NcpdRecord }) {
  const c = record.character;
  const venueLine = (v: { venueName: string; location?: string | null; venueType: string; role?: string }) =>
    `${v.venueName}${v.role ? ` — ${v.role}` : ""} (${v.venueType === "ripperdoc" ? "ripperdoc clinic" : "store"}${v.location ? `, ${v.location}` : ""})`;
  return (
    <SectionCard icon={UserSearch} title="SUBJECT DOSSIER">
      <div className="flex gap-4">
        {c.portraitUrl ? (
          <img
            src={c.portraitUrl}
            alt={c.name}
            className="w-24 h-24 object-cover border border-nc-cyan/40 shrink-0"
            data-testid="img-ncpd-dossier-portrait"
          />
        ) : (
          <div className="w-24 h-24 border border-border bg-black/30 flex items-center justify-center shrink-0">
            <UserSearch className="w-8 h-8 text-muted-foreground/50" />
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-display tracking-wider text-lg text-foreground" data-testid="text-ncpd-dossier-name">{c.name}</p>
            <Badge variant="outline" className="rounded-none uppercase font-display text-[10px]">{c.kind}</Badge>
            {c.lifeStatus !== "active" && (
              <Badge
                variant="outline"
                className={`rounded-none uppercase font-display text-[10px] ${
                  c.lifeStatus === "dead" ? "border-destructive text-destructive" : "border-nc-yellow text-nc-yellow"
                }`}
              >
                {c.lifeStatus}
              </Badge>
            )}
            {c.archived && (
              <Badge variant="outline" className="rounded-none uppercase font-display text-[10px] border-muted-foreground text-muted-foreground">
                archived
              </Badge>
            )}
          </div>
          {c.archetype && <p className="font-mono text-xs text-muted-foreground">{c.archetype}</p>}
          <div className="flex flex-wrap gap-1" data-testid="list-ncpd-dossier-tags">
            {c.tags.length ? (
              c.tags.map((t) => (
                <Badge key={t} variant="outline" className="rounded-none font-mono text-[10px] border-nc-cyan/40 text-nc-cyan">
                  {t}
                </Badge>
              ))
            ) : (
              <span className="font-mono text-xs text-muted-foreground">No known affiliations.</span>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 pt-2 border-t border-border/50">
        <DossierField label="Employment">
          {record.employment.length ? (
            <ul className="space-y-0.5" data-testid="list-ncpd-dossier-employment">
              {record.employment.map((v, i) => (
                <li key={`${v.venueType}-${v.venueId}-${i}`}>{venueLine(v)}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No known employment.</span>
          )}
        </DossierField>
        <DossierField label="Owned businesses">
          {record.businesses.length ? (
            <ul className="space-y-0.5" data-testid="list-ncpd-dossier-businesses">
              {record.businesses.map((v, i) => (
                <li key={`${v.venueType}-${v.venueId}-${i}`}>{venueLine(v)}</li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No registered businesses.</span>
          )}
        </DossierField>
        <DossierField label="Housing">
          {record.housing.length ? (
            <ul className="space-y-0.5" data-testid="list-ncpd-dossier-housing">
              {record.housing.map((l) => (
                <li key={l.id}>
                  {l.address}
                  {l.district ? `, ${l.district}` : ""}
                  {l.kind === "business" ? " (business)" : ""}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">No leases on record.</span>
          )}
        </DossierField>
        <DossierField label="Account balance">
          <span data-testid="text-ncpd-dossier-balance">
            {record.balance != null ? `${record.balance.toLocaleString()} €$` : <span className="text-muted-foreground">UNKNOWN</span>}
          </span>
        </DossierField>
      </div>
    </SectionCard>
  );
}

function SectionCard({ icon: Icon, title, action, children }: { icon: any; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="rounded-none border-border bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
          <Icon className="w-4 h-4 text-nc-cyan" /> {title}
        </CardTitle>
        {action}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

function fineStatusClass(status: string): string {
  switch (status) {
    case "unpaid":
      return "border-nc-yellow text-nc-yellow";
    case "paid":
      return "border-nc-green text-nc-green";
    default:
      return "border-muted-foreground text-muted-foreground";
  }
}

// Officers levy fines here; the character's owner pays them from the portal's
// Inbox page. A PAID badge (with the paid date) is the officer's
// notification that a fine was settled.
function FinesSection({
  characterId,
  fines,
  onError,
  onChanged,
}: {
  characterId: number;
  fines: NcpdFine[];
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const create = useCreateNcpdFine();
  const del = useVoidNcpdFine();

  const resetForm = () => {
    setAdding(false);
    setAmount("");
    setReason("");
  };

  const amt = Number(amount);
  const amtValid = Number.isSafeInteger(amt) && amt > 0;

  return (
    <SectionCard
      icon={Banknote}
      title="FINES"
      action={
        <Button size="sm" variant="outline" className="rounded-none font-display" onClick={() => (adding ? resetForm() : setAdding(true))} data-testid="button-ncpd-add-fine">
          {adding ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />} {adding ? "CANCEL" : "ISSUE FINE"}
        </Button>
      }
    >
      {adding && (
        <div className="border border-border p-4 space-y-3 bg-black/20">
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Amount (€$)</Label>
            <Input
              type="number"
              min={1}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="rounded-none"
              data-testid="input-ncpd-fine-amount"
            />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Illegal weapon possession" className="rounded-none" data-testid="input-ncpd-fine-reason" />
          </div>
          <Button
            size="sm"
            className="rounded-none font-display"
            disabled={!amtValid || !reason.trim() || create.isPending}
            onClick={() => {
              onError(null);
              create.mutate(
                { data: { characterId, amount: amt, reason } },
                {
                  onSuccess: () => {
                    resetForm();
                    onChanged();
                  },
                  onError: (e) => onError(apiErrorMessage(e, "Failed to issue fine")),
                },
              );
            }}
            data-testid="button-ncpd-fine-submit"
          >
            ISSUE FINE
          </Button>
        </div>
      )}
      {!fines.length ? (
        <p className="font-mono text-sm text-muted-foreground">No fines on file.</p>
      ) : (
        fines.map((f) => (
          <div key={f.id} className="border border-border p-4 flex items-start justify-between gap-2" data-testid={`card-ncpd-fine-${f.id}`}>
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={`rounded-none uppercase font-display text-[10px] ${fineStatusClass(f.status)}`}>
                  {f.status}
                </Badge>
                <span className="font-mono text-nc-yellow text-sm">€${f.amount.toLocaleString()}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  Issued {fmtDate(f.createdAt)}
                  {f.officerName ? ` by ${f.officerName}` : ""}
                  {f.status === "paid" && f.paidAt ? ` · paid ${fmtDate(f.paidAt)}` : ""}
                </span>
              </div>
              <p className="font-mono text-sm text-foreground/90 break-words">{f.reason}</p>
            </div>
            {f.status === "unpaid" && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive shrink-0"
                disabled={del.isPending}
                onClick={() => {
                  onError(null);
                  del.mutate(
                    { id: f.id },
                    { onSuccess: onChanged, onError: (e) => onError(apiErrorMessage(e, "Failed to void fine")) },
                  );
                }}
                data-testid={`button-ncpd-fine-void-${f.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        ))
      )}
    </SectionCard>
  );
}

function ReportsSection({
  characterId,
  reports,
  onError,
  onChanged,
}: {
  characterId: number;
  reports: NcpdReport[];
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [charges, setCharges] = useState("");
  const create = useCreateNcpdReport();
  const update = useUpdateNcpdReport();
  const del = useDeleteNcpdReport();

  const resetForm = () => {
    setAdding(false);
    setEditingId(null);
    setTitle("");
    setBody("");
    setCharges("");
  };

  const submit = () => {
    onError(null);
    if (editingId != null) {
      update.mutate(
        { id: editingId, data: { title, body, charges: charges || null } },
        {
          onSuccess: () => {
            resetForm();
            onChanged();
          },
          onError: (e) => onError(apiErrorMessage(e, "Failed to update report")),
        },
      );
    } else {
      create.mutate(
        { data: { characterId, title, body, charges: charges || null } },
        {
          onSuccess: () => {
            resetForm();
            onChanged();
          },
          onError: (e) => onError(apiErrorMessage(e, "Failed to file report")),
        },
      );
    }
  };

  const startEdit = (r: NcpdReport) => {
    setEditingId(r.id);
    setAdding(true);
    setTitle(r.title);
    setBody(r.body);
    setCharges(r.charges ?? "");
  };

  return (
    <SectionCard
      icon={FileText}
      title="ARREST REPORTS"
      action={
        <Button size="sm" variant="outline" className="rounded-none font-display" onClick={() => (adding ? resetForm() : setAdding(true))} data-testid="button-ncpd-add-report">
          {adding ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />} {adding ? "CANCEL" : "FILE REPORT"}
        </Button>
      }
    >
      {adding && (
        <div className="border border-border p-4 space-y-3 bg-black/20">
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-none" data-testid="input-ncpd-report-title" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Charges</Label>
            <Input value={charges} onChange={(e) => setCharges(e.target.value)} placeholder="e.g. Assault, Grand theft" className="rounded-none" data-testid="input-ncpd-report-charges" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Report</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="rounded-none" data-testid="input-ncpd-report-body" />
          </div>
          <Button
            size="sm"
            className="rounded-none font-display"
            disabled={!title.trim() || !body.trim() || create.isPending || update.isPending}
            onClick={submit}
            data-testid="button-ncpd-report-submit"
          >
            {editingId != null ? "SAVE CHANGES" : "FILE REPORT"}
          </Button>
        </div>
      )}
      {!reports.length ? (
        <p className="font-mono text-sm text-muted-foreground">No arrest reports on file.</p>
      ) : (
        reports.map((r) => (
          <div key={r.id} className="border border-border p-4 space-y-2" data-testid={`card-ncpd-report-${r.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display tracking-wider text-foreground">{r.title}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  Filed {fmtDate(r.createdAt)}
                  {r.officerName ? ` by ${r.officerName}` : ""}
                  {r.arrestedAt ? ` · arrested ${fmtDate(r.arrestedAt)}` : ""}
                </p>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(r)} data-testid={`button-ncpd-report-edit-${r.id}`}>
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  disabled={del.isPending}
                  onClick={() => {
                    onError(null);
                    del.mutate(
                      { id: r.id },
                      { onSuccess: onChanged, onError: (e) => onError(apiErrorMessage(e, "Failed to delete report")) },
                    );
                  }}
                  data-testid={`button-ncpd-report-delete-${r.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
            {r.charges && (
              <p className="font-mono text-xs">
                <span className="text-muted-foreground uppercase">Charges:</span> <span className="text-nc-yellow">{r.charges}</span>
              </p>
            )}
            <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{r.body}</Markdown>
          </div>
        ))
      )}
    </SectionCard>
  );
}

function WarrantsSection({
  characterId,
  warrants,
  onError,
  onChanged,
}: {
  characterId: number;
  warrants: NcpdWarrant[];
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const create = useCreateNcpdWarrant();
  const update = useUpdateNcpdWarrant();
  const del = useDeleteNcpdWarrant();

  const resetForm = () => {
    setAdding(false);
    setReason("");
    setNotes("");
  };

  return (
    <SectionCard
      icon={AlertTriangle}
      title="WARRANTS"
      action={
        <Button size="sm" variant="outline" className="rounded-none font-display" onClick={() => (adding ? resetForm() : setAdding(true))} data-testid="button-ncpd-add-warrant">
          {adding ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />} {adding ? "CANCEL" : "ISSUE WARRANT"}
        </Button>
      }
    >
      {adding && (
        <div className="border border-border p-4 space-y-3 bg-black/20">
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Reason</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} className="rounded-none" data-testid="input-ncpd-warrant-reason" />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Internal notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="rounded-none" data-testid="input-ncpd-warrant-notes" />
          </div>
          <Button
            size="sm"
            className="rounded-none font-display"
            disabled={!reason.trim() || create.isPending}
            onClick={() => {
              onError(null);
              create.mutate(
                { data: { characterId, reason, notes: notes || null } },
                {
                  onSuccess: () => {
                    resetForm();
                    onChanged();
                  },
                  onError: (e) => onError(apiErrorMessage(e, "Failed to issue warrant")),
                },
              );
            }}
            data-testid="button-ncpd-warrant-submit"
          >
            ISSUE WARRANT
          </Button>
        </div>
      )}
      {!warrants.length ? (
        <p className="font-mono text-sm text-muted-foreground">No warrants on file.</p>
      ) : (
        warrants.map((w) => (
          <div key={w.id} className="border border-border p-4 space-y-2" data-testid={`card-ncpd-warrant-${w.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className={`rounded-none uppercase font-display text-[10px] ${warrantStatusClass(w.status)}`}>
                    {w.status}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    Issued {fmtDate(w.createdAt)}
                    {w.issuedByName ? ` by ${w.issuedByName}` : ""}
                  </span>
                </div>
                <p className="font-mono text-sm text-foreground/90">{w.reason}</p>
                {w.notes && <p className="font-mono text-xs text-muted-foreground">{w.notes}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Select
                  value={w.status}
                  onValueChange={(status) => {
                    onError(null);
                    update.mutate(
                      { id: w.id, data: { status: status as "open" | "served" | "revoked" } },
                      { onSuccess: onChanged, onError: (e) => onError(apiErrorMessage(e, "Failed to update warrant")) },
                    );
                  }}
                >
                  <SelectTrigger className="h-7 w-[110px] rounded-none font-mono text-xs" data-testid={`select-ncpd-warrant-status-${w.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="served">Served</SelectItem>
                    <SelectItem value="revoked">Revoked</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive"
                  disabled={del.isPending}
                  onClick={() => {
                    onError(null);
                    del.mutate(
                      { id: w.id },
                      { onSuccess: onChanged, onError: (e) => onError(apiErrorMessage(e, "Failed to delete warrant")) },
                    );
                  }}
                  data-testid={`button-ncpd-warrant-delete-${w.id}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ))
      )}
    </SectionCard>
  );
}

function NotesSection({
  characterId,
  notes,
  onError,
  onChanged,
}: {
  characterId: number;
  notes: Array<{ id: number; note: string; authorName?: string | null; createdAt: string }>;
  onError: (m: string | null) => void;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const create = useCreateNcpdNote();
  const del = useDeleteNcpdNote();

  return (
    <SectionCard icon={StickyNote} title="NCPD NOTES">
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add an internal note…"
          className="rounded-none"
          data-testid="input-ncpd-note"
        />
        <Button
          size="sm"
          className="rounded-none font-display shrink-0"
          disabled={!text.trim() || create.isPending}
          onClick={() => {
            onError(null);
            create.mutate(
              { id: characterId, data: { note: text } },
              {
                onSuccess: () => {
                  setText("");
                  onChanged();
                },
                onError: (e) => onError(apiErrorMessage(e, "Failed to add note")),
              },
            );
          }}
          data-testid="button-ncpd-note-submit"
        >
          ADD NOTE
        </Button>
      </div>
      {!notes.length ? (
        <p className="font-mono text-sm text-muted-foreground">No notes on file.</p>
      ) : (
        notes.map((n) => (
          <div key={n.id} className="border border-border p-3 flex items-start justify-between gap-2" data-testid={`card-ncpd-note-${n.id}`}>
            <div>
              <p className="font-mono text-sm text-foreground/90 whitespace-pre-wrap">{n.note}</p>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                {fmtDate(n.createdAt)}
                {n.authorName ? ` · ${n.authorName}` : ""}
              </p>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive shrink-0"
              disabled={del.isPending}
              onClick={() => {
                onError(null);
                del.mutate(
                  { id: n.id },
                  { onSuccess: onChanged, onError: (e) => onError(apiErrorMessage(e, "Failed to delete note")) },
                );
              }}
              data-testid={`button-ncpd-note-delete-${n.id}`}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ))
      )}
    </SectionCard>
  );
}

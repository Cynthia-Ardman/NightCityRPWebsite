import { formatDate } from "@/lib/format";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNcpdCases,
  getListNcpdCasesQueryKey,
  useCreateNcpdCase,
  useUpdateNcpdCase,
  useDeleteNcpdCase,
  type NcpdCaseFile,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import Markdown from "@/components/Markdown";
import { FolderOpen, Plus, Trash2, Pencil, X, ChevronDown, ChevronUp } from "lucide-react";

function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null)?.data;
  const msg = (data as { error?: unknown } | null)?.error;
  return typeof msg === "string" && msg.trim() ? msg : fallback;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  return formatDate(new Date(iso));
}

function caseStatusClass(status: string): string {
  return status === "open" ? "border-nc-cyan text-nc-cyan" : "border-muted-foreground text-muted-foreground";
}

const CASE_FILTERS = ["open", "closed", "all"] as const;
type CaseFilter = (typeof CASE_FILTERS)[number];

// NCPD case files board — free-form investigations. Officers open a case with
// just a title (the body starts blank) and write whatever they need; markdown
// renders in the expanded view. Gated behind the NCPD/fixer/admin check in
// NcpdPage; the API enforces the same gate server-side regardless.
export default function NcpdCaseBoard() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<CaseFilter>("open");
  const params = filter === "all" ? undefined : { status: filter };
  const { data, isLoading } = useListNcpdCases(params, {
    query: { queryKey: getListNcpdCasesQueryKey(params) },
  });
  const rows = data ?? [];

  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const create = useCreateNcpdCase();
  const update = useUpdateNcpdCase();
  const del = useDeleteNcpdCase();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["/api/ncpd/cases"] });
  };

  const resetForm = () => {
    setAdding(false);
    setEditingId(null);
    setTitle("");
    setBody("");
  };

  const submit = () => {
    setErr(null);
    if (editingId != null) {
      update.mutate(
        { id: editingId, data: { title, body } },
        {
          onSuccess: () => {
            resetForm();
            invalidate();
          },
          onError: (e) => setErr(apiErrorMessage(e, "Failed to update case file")),
        },
      );
    } else {
      create.mutate(
        { data: { title, body } },
        {
          onSuccess: (row) => {
            resetForm();
            invalidate();
            setExpandedId(row.id);
          },
          onError: (e) => setErr(apiErrorMessage(e, "Failed to open case file")),
        },
      );
    }
  };

  const startEdit = (c: NcpdCaseFile) => {
    setEditingId(c.id);
    setAdding(true);
    setTitle(c.title);
    setBody(c.body);
  };

  const setStatus = (c: NcpdCaseFile, status: "open" | "closed") => {
    setErr(null);
    update.mutate(
      { id: c.id, data: { status } },
      {
        onSuccess: invalidate,
        onError: (e) => setErr(apiErrorMessage(e, "Failed to update case status")),
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1 flex-wrap" data-testid="filter-case-status">
          {CASE_FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              className="rounded-none font-display uppercase text-xs"
              onClick={() => setFilter(f)}
              data-testid={`button-case-filter-${f}`}
            >
              {f}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-none font-display"
          onClick={() => (adding ? resetForm() : setAdding(true))}
          data-testid="button-ncpd-add-case"
        >
          {adding ? <X className="w-4 h-4 mr-1" /> : <Plus className="w-4 h-4 mr-1" />} {adding ? "CANCEL" : "OPEN CASE FILE"}
        </Button>
      </div>

      {err && <p className="font-mono text-sm text-destructive">{err}</p>}

      {adding && (
        <div className="border border-border p-4 space-y-3 bg-black/20">
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Case title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Watson warehouse arson"
              className="rounded-none"
              data-testid="input-ncpd-case-title"
            />
          </div>
          <div className="space-y-1">
            <Label className="font-mono text-xs uppercase">Case file</Label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder="Blank page. Write whatever the investigation needs — suspects, evidence, leads, timeline. Markdown supported."
              className="rounded-none font-mono text-sm"
              data-testid="input-ncpd-case-body"
            />
          </div>
          <Button
            size="sm"
            className="rounded-none font-display"
            disabled={!title.trim() || create.isPending || update.isPending}
            onClick={submit}
            data-testid="button-ncpd-case-submit"
          >
            {editingId != null ? "SAVE CHANGES" : "OPEN CASE"}
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="text-nc-cyan font-display animate-pulse">SCANNING...</div>
      ) : !rows.length ? (
        <Card className="rounded-none border-border bg-card/50">
          <CardContent className="py-8 font-mono text-muted-foreground text-center">
            {filter === "all" ? "No case files." : `No ${filter} case files.`}
          </CardContent>
        </Card>
      ) : (
        rows.map((c) => {
          const expanded = expandedId === c.id;
          return (
            <Card key={c.id} className="rounded-none border-border bg-card/50" data-testid={`card-ncpd-case-${c.id}`}>
              <CardContent className="py-4 space-y-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <button
                    type="button"
                    className="text-left space-y-1 min-w-0 flex-1"
                    onClick={() => setExpandedId(expanded ? null : c.id)}
                    data-testid={`button-ncpd-case-toggle-${c.id}`}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`rounded-none uppercase font-display text-[10px] ${caseStatusClass(c.status)}`}>
                        {c.status}
                      </Badge>
                      <span className="font-display tracking-wider text-foreground flex items-center gap-2">
                        <FolderOpen className="w-4 h-4 text-nc-cyan shrink-0" />
                        {c.title}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-muted-foreground">
                      Case #{c.id} · Opened {fmtDate(c.createdAt)}
                      {c.openedByName ? ` by ${c.openedByName}` : ""}
                      {c.updatedAt !== c.createdAt ? ` · Updated ${fmtDate(c.updatedAt)}` : ""}
                    </p>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-none"
                      onClick={() => setExpandedId(expanded ? null : c.id)}
                      data-testid={`button-ncpd-case-expand-${c.id}`}
                    >
                      {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-none"
                      onClick={() => startEdit(c)}
                      data-testid={`button-ncpd-case-edit-${c.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="rounded-none text-destructive hover:text-destructive"
                      onClick={() => {
                        if (!window.confirm(`Delete case file "${c.title}"? This cannot be undone.`)) return;
                        setErr(null);
                        del.mutate(
                          { id: c.id },
                          {
                            onSuccess: invalidate,
                            onError: (e) => setErr(apiErrorMessage(e, "Failed to delete case file")),
                          },
                        );
                      }}
                      data-testid={`button-ncpd-case-delete-${c.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
                {expanded && (
                  <div className="border-t border-border pt-3 space-y-3">
                    {c.body.trim() ? (
                      <Markdown className="font-mono text-sm text-foreground/90 leading-relaxed">{c.body}</Markdown>
                    ) : (
                      <p className="font-mono text-sm text-muted-foreground italic">Blank case file — nothing on record yet.</p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-none font-display uppercase text-xs"
                      disabled={update.isPending}
                      onClick={() => setStatus(c, c.status === "open" ? "closed" : "open")}
                      data-testid={`button-ncpd-case-status-${c.id}`}
                    >
                      {c.status === "open" ? "CLOSE CASE" : "REOPEN CASE"}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

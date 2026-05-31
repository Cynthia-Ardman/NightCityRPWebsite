import { useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetLore,
  useCreateLore,
  useUpdateLore,
  useSubmitLoreEdit,
  getListLoreQueryKey,
  getGetLoreQueryKey,
  getListLoreEditsQueryKey,
  type LoreSource,
  type LoreEntryUpdate,
  LoreEntryInputCategory,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MarkdownEditor from "@/components/MarkdownEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useToast } from "@/hooks/use-toast";

type Category = (typeof LoreEntryInputCategory)[keyof typeof LoreEntryInputCategory];

function sourcesToText(sources: LoreSource[]): string {
  return sources.map((s) => `${s.label} | ${s.url}`).join("\n");
}
function textToSources(text: string): LoreSource[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.lastIndexOf("|");
      if (idx === -1) return { label: line, url: line };
      return { label: line.slice(0, idx).trim() || line.slice(idx + 1).trim(), url: line.slice(idx + 1).trim() };
    })
    .filter((s) => s.url);
}

export default function LoreEditor() {
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number(params.id) : null;
  const isEdit = editingId !== null;
  const { data: me } = useAuthMe();
  const isAdmin = !!me?.isAdmin;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const { data: existing, isLoading } = useGetLore(editingId ?? 0, {
    query: { queryKey: getGetLoreQueryKey(editingId ?? 0), enabled: isEdit },
  });

  const [seeded, setSeeded] = useState(false);
  const [category, setCategory] = useState<Category>("misc");
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [responsibleFixer, setResponsibleFixer] = useState("");
  const [summary, setSummary] = useState("");
  const [publicBody, setPublicBody] = useState("");
  const [fixerBody, setFixerBody] = useState("");
  const [sourcesText, setSourcesText] = useState("");
  const [note, setNote] = useState("");

  if (isEdit && existing && !seeded) {
    setCategory(existing.category);
    setName(existing.name);
    setAliases((existing.aliases ?? []).join(", "));
    setResponsibleFixer(existing.responsibleFixer ?? "");
    setSummary(existing.summary ?? "");
    setPublicBody(existing.publicBody ?? "");
    setFixerBody(existing.fixerBody ?? "");
    setSourcesText(sourcesToText(existing.sources ?? []));
    setSeeded(true);
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListLoreQueryKey() });
    if (isEdit) qc.invalidateQueries({ queryKey: getGetLoreQueryKey(editingId!) });
    qc.invalidateQueries({ queryKey: getListLoreEditsQueryKey() });
  };

  const createLore = useCreateLore({
    mutation: {
      onSuccess: (entry) => {
        invalidate();
        toast({ title: "Lore entry created" });
        navigate(`/directory/lore/${entry.id}`);
      },
      onError: (err) => toast({ title: "Could not create", description: msg(err), variant: "destructive" }),
    },
  });
  const updateLore = useUpdateLore({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Lore entry updated" });
        navigate(`/directory/lore/${editingId}`);
      },
      onError: (err) => toast({ title: "Could not update", description: msg(err), variant: "destructive" }),
    },
  });
  const submitEdit = useSubmitLoreEdit({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Submitted for approval", description: "An admin will review your proposal." });
        navigate(isEdit ? `/directory/lore/${editingId}` : "/directory/lore");
      },
      onError: (err) => toast({ title: "Could not submit", description: msg(err), variant: "destructive" }),
    },
  });

  if (isEdit && isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;

  const buildDiff = (): LoreEntryUpdate => ({
    category,
    name: name.trim(),
    aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
    responsibleFixer: responsibleFixer.trim() || null,
    summary: summary.trim() || null,
    publicBody,
    fixerBody: fixerBody.trim() || null,
    sources: textToSources(sourcesText),
  });

  const pending = createLore.isPending || updateLore.isPending || submitEdit.isPending;
  const valid = name.trim().length > 0;

  const onSave = () => {
    if (!valid) return;
    const diff = buildDiff();
    if (isAdmin) {
      if (isEdit) updateLore.mutate({ id: editingId!, data: diff });
      else createLore.mutate({ data: { ...diff, category, name: name.trim() } });
    } else {
      submitEdit.mutate({
        data: {
          kind: isEdit ? "edit" : "create",
          loreEntryId: isEdit ? editingId : null,
          diff,
          updateNote: note.trim() || null,
        },
      });
    }
  };

  const title = isEdit ? (isAdmin ? "EDIT LORE" : "PROPOSE EDIT") : isAdmin ? "NEW LORE ENTRY" : "PROPOSE NEW ENTRY";

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-12">
      <Link href={isEdit ? `/directory/lore/${editingId}` : "/directory/lore"}>
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-lore-editor-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> BACK
        </Button>
      </Link>
      <h1 className="text-4xl font-display" data-testid="text-lore-editor-title">{title}</h1>
      {!isAdmin && (
        <p className="font-mono text-xs text-nc-yellow border border-nc-yellow/40 bg-nc-yellow/5 p-3">
          As a fixer, your changes are submitted to an admin for approval before they go live.
        </p>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">DETAILS</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="rounded-none font-mono" data-testid="input-lore-name" />
            </Field>
            <Field label="Category">
              <Select value={category} onValueChange={(v) => setCategory(v as Category)}>
                <SelectTrigger className="rounded-none font-mono" data-testid="select-lore-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="corporation">Corporation</SelectItem>
                  <SelectItem value="gang">Gang</SelectItem>
                  <SelectItem value="faction">Faction</SelectItem>
                  <SelectItem value="misc">Miscellaneous</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Responsible Story Lead (fixer)">
            <Input value={responsibleFixer} onChange={(e) => setResponsibleFixer(e.target.value)} placeholder="Handle of the fixer who owns this lore" className="rounded-none font-mono" data-testid="input-lore-fixer" />
          </Field>
          <Field label="Aliases (comma-separated)">
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Abbreviations, alternate names" className="rounded-none font-mono" data-testid="input-lore-aliases" />
          </Field>
          <Field label="Summary (one line)">
            <Input value={summary} onChange={(e) => setSummary(e.target.value)} className="rounded-none font-mono" data-testid="input-lore-summary" />
          </Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">PUBLIC BODY</CardTitle></CardHeader>
        <CardContent>
          <MarkdownEditor value={publicBody} onChange={setPublicBody} rows={10} placeholder="Visible to everyone." testId="input-lore-public-body" />
        </CardContent>
      </Card>

      <Card className="rounded-none border-nc-yellow/40 bg-nc-yellow/5">
        <CardHeader><CardTitle className="font-display tracking-widest text-nc-yellow">FIXER-ONLY BODY</CardTitle></CardHeader>
        <CardContent>
          <MarkdownEditor value={fixerBody} onChange={setFixerBody} rows={8} placeholder="Restricted to staff. Leave blank if none." testId="input-lore-fixer-body" />
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">SOURCES (staff-only)</CardTitle></CardHeader>
        <CardContent>
          <Textarea
            value={sourcesText}
            onChange={(e) => setSourcesText(e.target.value)}
            rows={4}
            placeholder={"One per line, format: Label | https://url"}
            className="rounded-none font-mono text-xs"
            data-testid="input-lore-sources"
          />
        </CardContent>
      </Card>

      {!isAdmin && (
        <Field label="Note to reviewer (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} className="rounded-none font-mono" data-testid="input-lore-note" />
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Link href={isEdit ? `/directory/lore/${editingId}` : "/directory/lore"}>
          <Button variant="ghost" className="rounded-none font-display">CANCEL</Button>
        </Link>
        <Button
          className="rounded-none bg-nc-cyan text-background font-display tracking-widest"
          disabled={!valid || pending}
          onClick={onSave}
          data-testid="button-lore-save"
        >
          {pending ? "SAVING..." : isAdmin ? "PUBLISH" : "SUBMIT FOR APPROVAL"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-widest font-display text-nc-cyan">{label}</Label>
      {children}
    </div>
  );
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Please try again.";
}

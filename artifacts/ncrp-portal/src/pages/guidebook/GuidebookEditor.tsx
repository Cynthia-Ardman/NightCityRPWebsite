import { useState, useEffect } from "react";
import { useParams, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetGuidebookPage,
  useListGuidebookSections,
  useCreateGuidebookPage,
  useUpdateGuidebookPage,
  useSubmitGuidebookEdit,
  getListGuidebookQueryKey,
  getGetGuidebookPageQueryKey,
  getListGuidebookEditsQueryKey,
  getListMyGuidebookEditsQueryKey,
  type GuidebookSource,
  type GuidebookPageUpdate,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import MarkdownEditor from "@/components/MarkdownEditor";
import SingleImageUpload from "@/components/SingleImageUpload";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft } from "lucide-react";
import { useEffectiveMe } from "@/contexts/ViewAsContext";
import { useToast } from "@/hooks/use-toast";

function sourcesToText(sources: GuidebookSource[]): string {
  return sources.map((s) => `${s.label} | ${s.url}`).join("\n");
}
function textToSources(text: string): GuidebookSource[] {
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

export default function GuidebookEditor() {
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number(params.id) : null;
  const isEdit = editingId !== null;
  const { data: me } = useEffectiveMe();
  const isAdmin = !!me?.isAdmin;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const { data: sections } = useListGuidebookSections();
  const { data: existing, isLoading } = useGetGuidebookPage(editingId ?? 0, {
    query: { queryKey: getGetGuidebookPageQueryKey(editingId ?? 0), enabled: isEdit },
  });

  const [section, setSection] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [extraImages, setExtraImages] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [sourcesText, setSourcesText] = useState("");
  const [note, setNote] = useState("");

  // Seed the form from the loaded page. Keyed on the page id so navigating
  // between two /guidebook/:id/edit routes (which reuses this component) re-seeds.
  useEffect(() => {
    if (!isEdit || !existing) return;
    setSection(existing.section);
    setTitle(existing.title);
    setDescription(existing.description ?? "");
    setImageUrl(existing.images?.[0] ?? "");
    setExtraImages((existing.images ?? []).slice(1));
    setBody(existing.body ?? "");
    setSourcesText(sourcesToText(existing.sources ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, existing?.id]);

  // Default the section picker for new pages once the section list loads.
  useEffect(() => {
    if (!isEdit && !section && sections?.length) setSection(sections[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, sections]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListGuidebookQueryKey() });
    if (isEdit) qc.invalidateQueries({ queryKey: getGetGuidebookPageQueryKey(editingId!) });
    qc.invalidateQueries({ queryKey: getListGuidebookEditsQueryKey() });
    qc.invalidateQueries({ queryKey: getListMyGuidebookEditsQueryKey() });
  };

  const createPage = useCreateGuidebookPage({
    mutation: {
      onSuccess: (page) => {
        invalidate();
        toast({ title: "Guidebook page created" });
        navigate(`/guidebook/${page.id}`);
      },
      onError: (err) => toast({ title: "Could not create", description: msg(err), variant: "destructive" }),
    },
  });
  const updatePage = useUpdateGuidebookPage({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Guidebook page updated" });
        navigate(`/guidebook/${editingId}`);
      },
      onError: (err) => toast({ title: "Could not update", description: msg(err), variant: "destructive" }),
    },
  });
  const submitEdit = useSubmitGuidebookEdit({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Submitted for approval", description: "An admin will review your proposal." });
        navigate(isEdit ? `/guidebook/${editingId}` : "/guidebook");
      },
      onError: (err) => toast({ title: "Could not submit", description: msg(err), variant: "destructive" }),
    },
  });

  if (isEdit && isLoading) return <div className="font-display text-nc-cyan animate-pulse">LOADING...</div>;

  const buildDiff = (): GuidebookPageUpdate => ({
    section,
    title: title.trim(),
    description: description.trim() || null,
    body,
    images: [imageUrl.trim(), ...extraImages].filter(Boolean),
    sources: textToSources(sourcesText),
  });

  const pending = createPage.isPending || updatePage.isPending || submitEdit.isPending;
  const valid = title.trim().length > 0 && section.length > 0;

  const onSave = () => {
    if (!valid) return;
    const diff = buildDiff();
    if (isAdmin) {
      if (isEdit) updatePage.mutate({ id: editingId!, data: diff });
      else createPage.mutate({ data: { ...diff, section, title: title.trim() } });
    } else {
      submitEdit.mutate({
        data: {
          kind: isEdit ? "edit" : "create",
          pageId: isEdit ? editingId : null,
          diff,
          updateNote: note.trim() || null,
        },
      });
    }
  };

  const pageTitle = isEdit ? (isAdmin ? "EDIT PAGE" : "PROPOSE EDIT") : isAdmin ? "NEW GUIDEBOOK PAGE" : "PROPOSE NEW PAGE";

  return (
    <div className="max-w-7xl mx-auto space-y-6 pb-12">
      <Link href={isEdit ? `/guidebook/${editingId}` : "/guidebook"}>
        <Button variant="ghost" className="rounded-none font-mono text-xs text-muted-foreground -ml-2" data-testid="link-guidebook-editor-back">
          <ArrowLeft className="w-4 h-4 mr-1" /> BACK
        </Button>
      </Link>
      <h1 className="text-4xl font-display" data-testid="text-guidebook-editor-title">{pageTitle}</h1>
      {!isAdmin && (
        <p className="font-mono text-xs text-nc-yellow border border-nc-yellow/40 bg-nc-yellow/5 p-3">
          As a fixer, your changes are submitted to an admin for approval before they go live.
        </p>
      )}

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">DETAILS</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="rounded-none font-mono" data-testid="input-guidebook-title" />
            </Field>
            <Field label="Section">
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger className="rounded-none font-mono" data-testid="select-guidebook-section"><SelectValue placeholder="Choose a section" /></SelectTrigger>
                <SelectContent>
                  {(sections ?? []).map((s) => (
                    <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Short description (optional)">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-none font-mono" data-testid="input-guidebook-description" />
          </Field>
          <Field label="Header image (optional)">
            <SingleImageUpload value={imageUrl} onChange={setImageUrl} testIdPrefix="guidebook-image" alt={title || "guidebook image"} />
            {extraImages.length > 0 && (
              <p className="font-mono text-[10px] text-muted-foreground">
                {extraImages.length} additional imported image{extraImages.length === 1 ? "" : "s"} will be preserved.
              </p>
            )}
          </Field>
        </CardContent>
      </Card>

      <Card className="rounded-none border-border bg-card/50">
        <CardHeader><CardTitle className="font-display tracking-widest">BODY</CardTitle></CardHeader>
        <CardContent>
          <MarkdownEditor value={body} onChange={setBody} rows={14} placeholder="Markdown content visible to everyone." testId="input-guidebook-body" />
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
            data-testid="input-guidebook-sources"
          />
        </CardContent>
      </Card>

      {!isAdmin && (
        <Field label="Note to reviewer (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} className="rounded-none font-mono" data-testid="input-guidebook-note" />
        </Field>
      )}

      <div className="flex justify-end gap-2">
        <Link href={isEdit ? `/guidebook/${editingId}` : "/guidebook"}>
          <Button variant="ghost" className="rounded-none font-display">CANCEL</Button>
        </Link>
        <Button
          className="rounded-none bg-nc-cyan text-background font-display tracking-widest"
          disabled={!valid || pending}
          onClick={onSave}
          data-testid="button-guidebook-save"
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

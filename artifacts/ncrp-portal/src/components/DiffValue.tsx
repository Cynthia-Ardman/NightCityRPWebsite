import { useState } from "react";
import { diffWords, diffLines, collapseContext, isDiffSafe, multisetDiff, type DiffOp } from "@/lib/textDiff";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

// Shared renderer for a single field's before -> after change on the review
// screens. The default "unified" view highlights only what changed (red strike
// for removed, green for added) so reviewers don't have to compare two full
// copies; "split" falls back to the classic before/after columns.

type View = "unified" | "split";

const isUrl = (s: string) => /^https?:\/\//i.test(s) || s.startsWith("/");
const isUrlArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && isUrl(x));
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

// A single URL string is only treated as an *image* (clickable thumbnail) when
// it looks like one — an image extension or a stored upload/object path.
// Portrait URLs are extensionless storage paths (/api/storage/objects/uploads/…),
// while other URL fields (wiki / Discord prefab links) must stay plain text so
// they aren't rendered as broken images.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;
const isImageUrl = (s: string) =>
  isUrl(s) && (IMAGE_EXT.test(s) || /\/(storage\/)?objects\//i.test(s) || /\/uploads\//i.test(s));
const isImageUrlVal = (v: unknown): v is string => typeof v === "string" && isImageUrl(v);

// A thumbnail that opens a full-size, readable lightbox on click. Used for every
// image surfaced in a field diff so reviewers can actually read text-heavy stat
// sheet scans instead of squinting at a tiny thumbnail.
function ZoomImg({ src, className }: { src: string; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full cursor-zoom-in"
        aria-label="View full-size image"
      >
        <img src={src} alt="Diff image preview" className={`${className ?? ""} hover:border-nc-cyan transition`} />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl w-full rounded-none border-border bg-background p-2">
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          <img src={src} alt="Enlarged diff image" className="w-full max-h-[85vh] object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

// Treat a value as "structured" (line-diffed) when it's an object/JSON blob or a
// genuinely multi-line string; short prose gets the nicer word-level diff.
function isStructured(before: unknown, after: unknown): boolean {
  const objish = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (objish(before) || objish(after)) return true;
  return (toText(before) + toText(after)).split("\n").length > 6;
}

function Empty({ text, compact }: { text: string; compact?: boolean }) {
  return (
    <div className={`font-mono ${compact ? "text-[11px]" : "text-xs"} text-muted-foreground italic p-2 border border-border/60 bg-card/30`}>
      {text}
    </div>
  );
}

function renderPlain(v: unknown, compact?: boolean) {
  if (v === null || v === undefined || v === "") return <Empty text="(empty)" compact={compact} />;
  if (isUrlArray(v)) {
    return (
      <div className="grid grid-cols-2 gap-2 p-2 border border-border/60 bg-card/30">
        {v.map((url, i) => (
          <ZoomImg key={i} src={url} className={`w-full ${compact ? "h-20" : "h-24"} object-contain border border-border bg-background`} />
        ))}
      </div>
    );
  }
  if (isImageUrlVal(v)) {
    return (
      <div className="p-2 border border-border/60 bg-card/30">
        <ZoomImg src={v} className={`w-full ${compact ? "h-24" : "h-32"} object-contain border border-border bg-background`} />
      </div>
    );
  }
  if (isStringArray(v)) {
    if (v.length === 0) return <Empty text="(empty list)" compact={compact} />;
    return (
      <ul className={`font-mono ${compact ? "text-[11px]" : "text-xs"} p-2 border border-border/60 bg-card/30 list-disc list-inside space-y-0.5`}>
        {v.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    );
  }
  return (
    <pre className={`font-mono ${compact ? "text-[11px]" : "text-xs"} whitespace-pre-wrap p-2 border border-border/60 bg-card/30 max-h-80 overflow-y-auto`}>
      {toText(v)}
    </pre>
  );
}

function WordDiff({ ops, compact }: { ops: DiffOp[]; compact?: boolean }) {
  return (
    <pre className={`font-mono ${compact ? "text-[11px]" : "text-xs"} whitespace-pre-wrap p-2 border border-border/60 bg-card/30 max-h-96 overflow-y-auto`}>
      {ops.map((o, i) =>
        o.type === "equal" ? (
          <span key={i} className="text-foreground/80">{o.value}</span>
        ) : o.type === "add" ? (
          <span key={i} className="bg-nc-green/20 text-nc-green rounded-sm">{o.value}</span>
        ) : (
          <span key={i} className="bg-destructive/20 text-destructive line-through rounded-sm">{o.value}</span>
        ),
      )}
    </pre>
  );
}

function LineDiff({ before, after, compact }: { before: string; after: string; compact?: boolean }) {
  const rows = collapseContext(diffLines(before, after), 3);
  return (
    <div className={`font-mono ${compact ? "text-[11px]" : "text-xs"} border border-border/60 bg-card/30 max-h-96 overflow-y-auto`}>
      {rows.map((r, i) => {
        if (r.type === "gap") {
          return (
            <div key={i} className="px-2 py-0.5 text-muted-foreground/70 italic bg-background/40 border-y border-border/40 select-none">
              … {r.count} unchanged line{r.count === 1 ? "" : "s"} …
            </div>
          );
        }
        const cls =
          r.type === "add"
            ? "bg-nc-green/10 text-nc-green"
            : r.type === "remove"
              ? "bg-destructive/10 text-destructive"
              : "text-foreground/70";
        const gutter = r.type === "add" ? "+" : r.type === "remove" ? "-" : " ";
        return (
          <div key={i} className={`px-2 whitespace-pre-wrap ${cls}`}>
            <span className="select-none opacity-50 mr-2">{gutter}</span>
            {r.value === "" ? " " : r.value}
          </div>
        );
      })}
    </div>
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Diff two objects key-by-key, recursing into nested values, and only show the
// fields that actually changed. This keeps a small edit deep inside a large blob
// (e.g. one section of a sheet) from re-printing the entire object as removed +
// re-added, which is what makes the unstructured line-diff hard to read.
function ObjectDiff({ before, after, compact }: { before: Record<string, unknown>; after: Record<string, unknown>; compact?: boolean }) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  if (changed.length === 0) return <Empty text="(no change)" compact={compact} />;
  return (
    <div className="space-y-3">
      {changed.map((k) => (
        <div key={k} className="border-l-2 border-border/60 pl-3" data-testid={`obj-diff-${k}`}>
          <div className="font-mono text-[10px] uppercase tracking-widest text-nc-cyan/60 mb-1">{k}</div>
          <DiffValue before={before[k]} after={after[k]} compact />
        </div>
      ))}
    </div>
  );
}

function SplitView({ before, after, compact }: { before: unknown; after: unknown; compact?: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
      <div>
        <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-destructive mb-1`}>— BEFORE</div>
        {renderPlain(before, compact)}
      </div>
      <div>
        <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-nc-green mb-1`}>+ AFTER</div>
        {renderPlain(after, compact)}
      </div>
    </div>
  );
}

export default function DiffValue({
  before,
  after,
  view = "unified",
  compact,
}: {
  before: unknown;
  after: unknown;
  view?: View;
  compact?: boolean;
}) {
  if (view === "split") {
    return <SplitView before={before} after={after} compact={compact} />;
  }

  // Image arrays can't be word/line-diffed meaningfully — show what was removed
  // and what was added as separate galleries. Multiset-based so dropping one of
  // several identical URLs still registers as a removal.
  if (isUrlArray(before) || isUrlArray(after)) {
    const b = isUrlArray(before) ? before : [];
    const a = isUrlArray(after) ? after : [];
    const { removed, added } = multisetDiff(b, a);
    if (removed.length === 0 && added.length === 0) {
      return <Empty text="(no image changes)" compact={compact} />;
    }
    return (
      <div className="space-y-2">
        {removed.length > 0 && (
          <div>
            <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-destructive mb-1`}>— REMOVED</div>
            <div className="grid grid-cols-3 gap-2 p-2 border border-destructive/40 bg-destructive/5">
              {removed.map((url, i) => (
                <ZoomImg key={i} src={url} className={`w-full ${compact ? "h-16" : "h-20"} object-contain border border-border bg-background`} />
              ))}
            </div>
          </div>
        )}
        {added.length > 0 && (
          <div>
            <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-nc-green mb-1`}>+ ADDED</div>
            <div className="grid grid-cols-3 gap-2 p-2 border border-nc-green/40 bg-nc-green/5">
              {added.map((url, i) => (
                <ZoomImg key={i} src={url} className={`w-full ${compact ? "h-16" : "h-20"} object-contain border border-border bg-background`} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // Single image-URL string field (e.g. a singular portrait): show the old and
  // new image as clickable thumbnails instead of word-diffing the raw path.
  if (isImageUrlVal(before) || isImageUrlVal(after)) {
    const b = isImageUrlVal(before) ? before : null;
    const a = isImageUrlVal(after) ? after : null;
    if (b === a) return <Empty text="(no image changes)" compact={compact} />;
    const removedImg = b && b !== a ? b : null;
    const addedImg = a && a !== b ? a : null;
    return (
      <div className="space-y-2">
        {removedImg && (
          <div>
            <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-destructive mb-1`}>— REMOVED</div>
            <div className="p-2 border border-destructive/40 bg-destructive/5">
              <ZoomImg src={removedImg} className={`w-full ${compact ? "h-24" : "h-32"} object-contain border border-border bg-background`} />
            </div>
          </div>
        )}
        {addedImg && (
          <div>
            <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-nc-green mb-1`}>+ ADDED</div>
            <div className="p-2 border border-nc-green/40 bg-nc-green/5">
              <ZoomImg src={addedImg} className={`w-full ${compact ? "h-24" : "h-32"} object-contain border border-border bg-background`} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Plain objects (e.g. a sheet's nested data) are diffed field-by-field so only
  // the changed keys surface, recursing down to a word/line diff per value.
  // object<->empty is allowed so an added/cleared object still breaks down.
  if (
    (isPlainObject(before) || before == null) &&
    (isPlainObject(after) || after == null) &&
    (isPlainObject(before) || isPlainObject(after))
  ) {
    return <ObjectDiff before={isPlainObject(before) ? before : {}} after={isPlainObject(after) ? after : {}} compact={compact} />;
  }

  const beforeText = toText(before);
  const afterText = toText(after);

  if (beforeText === afterText) {
    return <Empty text="(no change)" compact={compact} />;
  }
  if (beforeText === "") {
    return (
      <div>
        <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-nc-green mb-1`}>+ ADDED (was empty)</div>
        {renderPlain(after, compact)}
      </div>
    );
  }
  if (afterText === "") {
    return (
      <div>
        <div className={`font-mono ${compact ? "text-[10px]" : "text-xs"} text-destructive mb-1`}>— REMOVED (now empty)</div>
        {renderPlain(before, compact)}
      </div>
    );
  }

  const mode = isStructured(before, after) ? "lines" : "words";

  // Guard against pathologically large fields stalling the page on the O(n*m)
  // LCS table — fall back to plain before/after columns.
  if (!isDiffSafe(beforeText, afterText, mode)) {
    return <SplitView before={before} after={after} compact={compact} />;
  }

  return mode === "lines" ? (
    <LineDiff before={beforeText} after={afterText} compact={compact} />
  ) : (
    <WordDiff ops={diffWords(beforeText, afterText)} compact={compact} />
  );
}

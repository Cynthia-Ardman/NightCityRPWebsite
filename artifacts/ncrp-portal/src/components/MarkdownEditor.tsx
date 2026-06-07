import { useCallback, useEffect, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import Markdown from "@/components/Markdown";
import { COLOR_PRESETS } from "@/lib/remarkColor";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  /** Forwarded to the underlying textarea so existing field selectors keep working. */
  testId?: string;
}

/**
 * Live side-by-side "write / preview" control. The left pane is a plain
 * textarea; the right pane renders the same markdown through the shared
 * <Markdown> component so what the author sees here matches the character /
 * directory views exactly. A small color toolbar wraps the current selection in
 * the [c=color]...[/c] syntax understood by the shared renderer. Markdown is
 * safe by default (react-markdown ignores raw HTML — no rehype-raw is wired in).
 */
export default function MarkdownEditor({
  value,
  onChange,
  rows = 4,
  placeholder,
  testId,
}: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasContent = value.trim().length > 0;

  // Grow the textarea to fit its content so the whole sheet is visible without
  // manual dragging. We reset to "auto" first so it can shrink as well as grow.
  const autosize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autosize();
  }, [value, autosize]);

  // Turn the selected line(s) (or the current line) into a markdown bullet
  // list. Each line gets a "- " prefix unless it already has one, and the list
  // is forced to start on its own line so it always renders as a <ul>.
  function applyBulletList() {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const before = value.slice(0, lineStart);
    const block = value.slice(lineStart, end);
    const after = value.slice(end);
    const lines = block.length ? block.split("\n") : ["item"];
    const bulleted = lines.map((l) => (/^\s*-\s/.test(l) ? l : `- ${l}`)).join("\n");
    const sep = before.length === 0 || before.endsWith("\n") ? "" : "\n";
    onChange(`${before}${sep}${bulleted}${after}`);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      const caret = before.length + sep.length + bulleted.length;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }

  // Wrap the current textarea selection (or insert a placeholder) in a color
  // tag, then restore the selection around the wrapped text.
  function applyColor(color: string) {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const selected = value.slice(start, end) || "text";
    const before = value.slice(0, start);
    const after = value.slice(end);
    const open = `[c=${color}]`;
    onChange(`${before}${open}${selected}[/c]${after}`);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      const selStart = before.length + open.length;
      node.focus();
      node.setSelectionRange(selStart, selStart + selected.length);
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          title="Bullet list"
          aria-label="Insert bullet list"
          onClick={applyBulletList}
          className="h-5 px-1.5 rounded-sm border border-border/60 text-[10px] font-mono uppercase tracking-widest text-muted-foreground hover:border-nc-cyan/60 hover:text-nc-cyan transition-colors"
          data-testid={testId ? `${testId}-bullet-list` : undefined}
        >
          • List
        </button>
        <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mr-1">
          Color
        </span>
        {COLOR_PRESETS.map((c) => (
          <button
            key={c.name}
            type="button"
            title={c.name}
            aria-label={`Color selection ${c.name}`}
            onClick={() => applyColor(c.name)}
            className="h-5 w-5 rounded-sm border border-border/60 hover:scale-110 transition-transform"
            style={{ backgroundColor: c.hex }}
            data-testid={testId ? `${testId}-color-${c.name}` : undefined}
          />
        ))}
        <input
          type="color"
          title="Custom color"
          aria-label="Custom color"
          onChange={(e) => applyColor(e.target.value)}
          className="ml-1 h-5 w-6 cursor-pointer border border-border/60 bg-transparent p-0"
          data-testid={testId ? `${testId}-color-custom` : undefined}
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Write
          </span>
          <Textarea
            ref={ref}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onInput={autosize}
            placeholder={placeholder}
            data-testid={testId}
            className="font-mono resize-none overflow-hidden"
          />
        </div>
        <div className="space-y-1">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Preview
          </span>
          <div
            className="min-h-[5rem] h-full border border-border bg-background/40 px-3 py-2 text-sm font-mono text-foreground/90 leading-relaxed overflow-auto break-words"
            data-testid={testId ? `${testId}-preview` : undefined}
            aria-live="polite"
          >
            {hasContent ? (
              <Markdown>{value}</Markdown>
            ) : (
              <span className="italic text-muted-foreground">Nothing to preview yet.</span>
            )}
          </div>
        </div>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground">
        <span className="text-nc-cyan">Markdown supported</span>
        {" — "}**bold**, *italic*, [links](url), and [c=red]colored text[/c]
        {" "}(select text, then pick a color). For a bullet list, start each line with
        {" "}<span className="text-nc-cyan">{"- "}</span>(dash + space) or use the • List button.
      </p>
    </div>
  );
}

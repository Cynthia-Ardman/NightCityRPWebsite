import { Textarea } from "@/components/ui/textarea";
import Markdown from "@/components/Markdown";

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
 * directory views exactly. Markdown is safe by default (react-markdown ignores
 * raw HTML — no rehype-raw is wired in).
 */
export default function MarkdownEditor({
  value,
  onChange,
  rows = 4,
  placeholder,
  testId,
}: MarkdownEditorProps) {
  const hasContent = value.trim().length > 0;
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <span className="block text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
            Write
          </span>
          <Textarea
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            data-testid={testId}
            className="font-mono"
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
        {" — "}**bold**, *italic*, lists, and [links](url).
      </p>
    </div>
  );
}

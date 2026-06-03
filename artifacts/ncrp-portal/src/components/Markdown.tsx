import ReactMarkdown from "react-markdown";
import { Link } from "wouter";
import remarkColor from "@/lib/remarkColor";
import remarkDiscordTime from "@/lib/remarkDiscordTime";

// Render a unix-seconds moment in the viewer's local timezone, mirroring the
// Discord <t:...> style letters (t/T/d/D/f/F/R). Used by the `time` element the
// remarkDiscordTime plugin produces from `[t=secs:fmt]` tokens.
function formatLocal(secs: number, fmt: string): string {
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return "";
  switch (fmt) {
    case "t":
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    case "T":
      return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    case "d":
      return d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
    case "D":
      return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    case "R":
      return formatRelative(d);
    case "F":
      return d.toLocaleString(undefined, {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "f":
    default:
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
  }
}

function formatRelative(d: Date): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diffSec) >= secs || unit === "second") {
      return rtf.format(Math.round(diffSec / secs), unit);
    }
  }
  return "";
}

export default function Markdown({ children, className }: { children?: string | null; className?: string }) {
  const text = (children ?? "").trim();
  if (!text) return null;
  return (
    <div className={`${className ?? ""} break-words [overflow-wrap:anywhere]`}>
      <ReactMarkdown
        remarkPlugins={[remarkDiscordTime, remarkColor]}
        components={{
          h1: ({ children }) => <h1 className="text-2xl font-display mt-4 mb-2 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="text-xl font-display mt-4 mb-2 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="text-lg font-semibold mt-3 mb-1 first:mt-0">{children}</h3>,
          h4: ({ children }) => <h4 className="text-base font-semibold mt-2 mb-1 first:mt-0">{children}</h4>,
          p: ({ children }) => (
            <p className="mb-3 last:mb-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</p>
          ),
          strong: ({ children }) => <strong className="text-nc-cyan font-semibold">{children}</strong>,
          em: ({ children }) => <em className="text-nc-yellow">{children}</em>,
          hr: () => <hr className="border-border/60 my-3" />,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 last:mb-0 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 last:mb-0 space-y-1">{children}</ol>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-nc-cyan/60 pl-3 my-3 text-muted-foreground italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1 align-top">{children}</td>,
          img: ({ src, alt }) => (
            <img src={src} alt={alt ?? ""} className="my-3 max-w-full rounded border border-border" loading="lazy" />
          ),
          a: ({ children, href }) => {
            const h = href ?? "";
            if (h.startsWith("/") || h.startsWith("#")) {
              return (
                <Link href={h} className="text-nc-cyan underline">
                  {children}
                </Link>
              );
            }
            return (
              <a href={h} target="_blank" rel="noreferrer" className="text-nc-cyan underline break-all">
                {children}
              </a>
            );
          },
          code: ({ children }) => (
            <code className="bg-background/60 px-1 py-0.5 rounded text-nc-magenta break-all">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="mb-3 last:mb-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</pre>
          ),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          time: ({ node }: any) => {
            const raw = String(node?.children?.[0]?.value ?? "");
            const [secsStr, fmt] = raw.split("|");
            const secs = Number(secsStr);
            const d = new Date(secs * 1000);
            if (!Number.isFinite(secs) || Number.isNaN(d.getTime())) return <time>{raw}</time>;
            return (
              <time dateTime={d.toISOString()} title={d.toString()} className="text-nc-yellow">
                {formatLocal(secs, fmt || "f")}
              </time>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

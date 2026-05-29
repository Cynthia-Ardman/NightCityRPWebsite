import ReactMarkdown from "react-markdown";
import remarkColor from "@/lib/remarkColor";

export default function Markdown({ children, className }: { children?: string | null; className?: string }) {
  const text = (children ?? "").trim();
  if (!text) return null;
  return (
    <div className={`${className ?? ""} break-words [overflow-wrap:anywhere]`}>
      <ReactMarkdown
        remarkPlugins={[remarkColor]}
        components={{
          p: ({ children }) => (
            <p className="mb-3 last:mb-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{children}</p>
          ),
          strong: ({ children }) => <strong className="text-nc-cyan font-semibold">{children}</strong>,
          em: ({ children }) => <em className="text-nc-yellow">{children}</em>,
          hr: () => <hr className="border-border/60 my-3" />,
          ul: ({ children }) => <ul className="list-disc pl-5 mb-3 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 mb-3 last:mb-0">{children}</ol>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-nc-cyan underline break-all">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="bg-background/60 px-1 py-0.5 rounded text-nc-magenta break-all">{children}</code>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

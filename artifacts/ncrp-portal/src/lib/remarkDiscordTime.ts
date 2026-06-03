// Lightweight remark plugin that turns the importer's timestamp tokens
//
//     [t=1691704800]      or      [t=1691704800:F]
//
// into a custom mdast node that remark-rehype renders as a <time> element. The
// shared Markdown renderer overrides `time` to format the moment in each
// viewer's local timezone (see Markdown.tsx). The unix seconds and Discord
// style letter are carried in the node's text child as "secs|fmt" so the
// renderer can read them without relying on attribute-name normalisation.
//
// The importer (api-server guidebookImport.ts) emits these tokens from Discord
// <t:...> timestamps. Anything that does not match the token shape is left
// untouched, so the plugin is a no-op on ordinary content.

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const TOKEN = /\[t=(\d+)(?::([tTdDfFR]))?\]/g;

function timeNode(secs: string, fmt: string): MdNode {
  return {
    type: "nctime",
    data: { hName: "time" },
    children: [{ type: "text", value: `${secs}|${fmt}` }],
  };
}

function splitText(value: string): MdNode[] {
  TOKEN.lastIndex = 0;
  const out: MdNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(value))) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push(timeNode(m[1], m[2] ?? "f"));
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [{ type: "text", value }];
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function process(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string" && child.value.includes("[t=")) {
      out.push(...splitText(child.value));
      continue;
    }
    if (child.children && child.children.length > 0) {
      child.children = process(child.children);
    }
    out.push(child);
  }
  return out;
}

export default function remarkDiscordTime() {
  return (tree: MdNode) => {
    if (tree.children && tree.children.length > 0) {
      tree.children = process(tree.children);
    }
  };
}

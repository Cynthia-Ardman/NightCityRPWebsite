// Lightweight remark plugin that adds inline text colors to the shared Markdown
// renderer through a safe, allow-listed syntax:
//
//     [c=VALUE]text[/c]
//
// VALUE is either a named preset (see COLOR_PRESETS) or a hex code (#rgb /
// #rrggbb). Anything that does not resolve to an allowed color is left in place
// as literal text, so the syntax can never inject arbitrary CSS. The colored
// run is emitted as a custom mdast node carrying data.hName/hProperties, which
// remark-rehype turns into a plain <span style="color:..."> element.
//
// The plugin works on each parent's child list (not on isolated text nodes), so
// a colored run can span several inline siblings — e.g. `[c=red]**bold**[/c]`
// keeps the <strong> intact instead of leaking the literal markers. Unclosed or
// unknown tags gracefully fall back to literal text.

export const COLOR_PRESETS: { name: string; hex: string }[] = [
  { name: "red", hex: "#ff4d4d" },
  { name: "orange", hex: "#ff8a3d" },
  { name: "yellow", hex: "#ffd23d" },
  { name: "green", hex: "#3dd68c" },
  { name: "cyan", hex: "#22d3ee" },
  { name: "blue", hex: "#4d9fff" },
  { name: "purple", hex: "#b07cff" },
  { name: "pink", hex: "#ff5fae" },
  { name: "white", hex: "#f5f5f5" },
  { name: "gray", hex: "#9aa0a6" },
];

const NAMED = new Map(COLOR_PRESETS.map((c) => [c.name, c.hex] as const));
NAMED.set("grey", "#9aa0a6");

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function resolveColor(value: string): string | null {
  const raw = value.trim();
  const named = NAMED.get(raw.toLowerCase());
  if (named) return named;
  if (HEX.test(raw)) return raw;
  return null;
}

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

type Token =
  | { kind: "open"; hex: string; raw: string }
  | { kind: "close" }
  | { kind: "node"; node: MdNode };

const MARKER = /\[c=([^\]\s]+)\]|\[\/c\]/g;

function textNode(value: string): MdNode {
  return { type: "text", value };
}

// Break a text value into open/close marker tokens and literal-text tokens.
// Unresolved open markers are kept as literal text (never produce a span).
function tokenizeText(value: string, tokens: Token[]): void {
  MARKER.lastIndex = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(value))) {
    if (m[1] !== undefined) {
      const hex = resolveColor(m[1]);
      if (!hex) continue; // unknown color -> leave the raw token in the text run
      if (m.index > last) tokens.push({ kind: "node", node: textNode(value.slice(last, m.index)) });
      tokens.push({ kind: "open", hex, raw: m[1] });
      last = m.index + m[0].length;
    } else {
      if (m.index > last) tokens.push({ kind: "node", node: textNode(value.slice(last, m.index)) });
      tokens.push({ kind: "close" });
      last = m.index + m[0].length;
    }
  }
  if (last < value.length) tokens.push({ kind: "node", node: textNode(value.slice(last)) });
}

function colorSpan(hex: string, children: MdNode[]): MdNode {
  return {
    type: "colorText",
    data: { hName: "span", hProperties: { style: `color:${hex}` } },
    children,
  };
}

// Assemble tokens into a node list, matching open/close markers with a stack.
// Unmatched close markers and unclosed open markers fall back to literal text.
function build(tokens: Token[]): MdNode[] {
  const root: MdNode[] = [];
  const stack: { hex: string; raw: string; nodes: MdNode[] }[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].nodes : root);

  for (const t of tokens) {
    if (t.kind === "open") {
      stack.push({ hex: t.hex, raw: t.raw, nodes: [] });
    } else if (t.kind === "close") {
      if (stack.length === 0) {
        current().push(textNode("[/c]"));
        continue;
      }
      const group = stack.pop()!;
      current().push(colorSpan(group.hex, group.nodes));
    } else {
      current().push(t.node);
    }
  }

  // Any still-open groups were never closed: emit their opening marker as
  // literal text followed by their collected children, innermost first.
  while (stack.length) {
    const group = stack.pop()!;
    const target = stack.length ? stack[stack.length - 1].nodes : root;
    target.push(textNode(`[c=${group.raw}]`), ...group.nodes);
  }

  return root;
}

function processChildren(children: MdNode[]): MdNode[] {
  const tokens: Token[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      if (child.value.includes("[c=") || child.value.includes("[/c]")) {
        tokenizeText(child.value, tokens);
        continue;
      }
      tokens.push({ kind: "node", node: child });
      continue;
    }
    if (child.children && child.children.length > 0) {
      child.children = processChildren(child.children);
    }
    tokens.push({ kind: "node", node: child });
  }
  return build(tokens);
}

export default function remarkColor() {
  return (tree: MdNode) => {
    if (tree.children && tree.children.length > 0) {
      tree.children = processChildren(tree.children);
    }
  };
}

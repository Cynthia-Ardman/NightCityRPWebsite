import { describe, it, expect } from "vitest";
import remarkColor, { COLOR_PRESETS, resolveColor } from "./remarkColor";

describe("resolveColor", () => {
  it("resolves every named preset to its hex", () => {
    for (const c of COLOR_PRESETS) {
      expect(resolveColor(c.name)).toBe(c.hex);
    }
  });

  it("is case-insensitive on preset names", () => {
    expect(resolveColor("CYAN")).toBe("#22d3ee");
    expect(resolveColor("Magenta")).toBeNull(); // 'magenta' is not in presets
    expect(resolveColor("PiNk")).toBe("#ff5fae");
  });

  it("accepts 'grey' as an alias for 'gray'", () => {
    expect(resolveColor("grey")).toBe(resolveColor("gray"));
  });

  it("accepts 3- and 6-digit hex codes", () => {
    expect(resolveColor("#f00")).toBe("#f00");
    expect(resolveColor("#FF8800")).toBe("#FF8800");
  });

  it("rejects malformed hex and unknown values", () => {
    expect(resolveColor("#zzz")).toBeNull();
    expect(resolveColor("#12345")).toBeNull();
    expect(resolveColor("javascript:alert(1)")).toBeNull();
    expect(resolveColor("rgb(1,2,3)")).toBeNull();
    expect(resolveColor("")).toBeNull();
  });

  it("trims surrounding whitespace before resolving", () => {
    expect(resolveColor("  cyan  ")).toBe("#22d3ee");
  });
});

// Helpers for working with the mdast-ish nodes the plugin returns.
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

function tree(children: MdNode[]): MdNode {
  return { type: "root", children };
}

function text(value: string): MdNode {
  return { type: "text", value };
}

// Run the plugin once on a synthetic mdast root and return the transformed
// children.
function applyOnce(children: MdNode[]): MdNode[] {
  const root = tree(children);
  remarkColor()(root);
  return root.children ?? [];
}

function collectText(nodes: MdNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text" && typeof n.value === "string") out += n.value;
    if (n.children) out += collectText(n.children);
  }
  return out;
}

describe("remarkColor: tokenization of [c=VALUE]text[/c]", () => {
  it("turns a known named token into a colored span node", () => {
    const out = applyOnce([text("Stay [c=red]away[/c] from here")]);
    // Find the colorText span.
    const span = out.find((n) => n.type === "colorText");
    expect(span).toBeDefined();
    expect(span?.data?.hName).toBe("span");
    expect(span?.data?.hProperties?.style).toBe("color:#ff4d4d");
    // Inner text survives.
    expect(collectText(span?.children ?? [])).toBe("away");
  });

  it("supports hex color values", () => {
    const out = applyOnce([text("[c=#00ff00]online[/c]")]);
    const span = out.find((n) => n.type === "colorText");
    expect(span?.data?.hProperties?.style).toBe("color:#00ff00");
  });

  it("leaves an unknown color value entirely untouched in the text run", () => {
    const out = applyOnce([text("[c=javascript:alert(1)]x[/c]")]);
    // No colored span was created.
    expect(out.find((n) => n.type === "colorText")).toBeUndefined();
    // Raw token survives verbatim somewhere in the surviving text.
    expect(collectText(out)).toContain("[c=javascript:alert(1)]x[/c]");
  });

  it("handles nested colored runs by stacking spans", () => {
    const out = applyOnce([text("[c=red]outer [c=blue]inner[/c] tail[/c]")]);
    const outer = out.find((n) => n.type === "colorText");
    expect(outer?.data?.hProperties?.style).toBe("color:#ff4d4d");
    const inner = outer?.children?.find((c) => c.type === "colorText");
    expect(inner?.data?.hProperties?.style).toBe("color:#4d9fff");
    expect(collectText(inner?.children ?? [])).toBe("inner");
  });

  it("treats an unclosed open marker as literal text", () => {
    const out = applyOnce([text("[c=red]oops with no close")]);
    // No colored span emitted for an unclosed run.
    expect(out.find((n) => n.type === "colorText")).toBeUndefined();
    expect(collectText(out)).toContain("[c=red]oops with no close");
  });

  it("treats a stray close marker as literal text", () => {
    const out = applyOnce([text("nothing open [/c] still here")]);
    expect(out.find((n) => n.type === "colorText")).toBeUndefined();
    expect(collectText(out)).toContain("[/c]");
  });

  it("recurses into nested non-text children (e.g. <strong>) without colorizing them blindly", () => {
    // Synthetic strong with a text child that contains a color marker.
    const strong: MdNode = {
      type: "strong",
      children: [text("[c=cyan]neon[/c] glow")],
    };
    const out = applyOnce([strong]);
    // The strong is still at the root level, but its children should now have
    // a colorText span carved out of the marker.
    const root = out[0];
    expect(root.type).toBe("strong");
    const span = root.children?.find((c) => c.type === "colorText");
    expect(span?.data?.hProperties?.style).toBe("color:#22d3ee");
  });
});

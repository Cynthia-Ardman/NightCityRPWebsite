import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Markdown from "@/components/Markdown";

describe("Markdown color syntax", () => {
  it("renders a named [c=...] run as a colored span", () => {
    render(<Markdown>{"Stay [c=red]away[/c] from the door"}</Markdown>);
    const span = screen.getByText("away");
    expect(span.tagName).toBe("SPAN");
    expect(span).toHaveStyle({ color: "#ff4d4d" });
  });

  it("supports raw hex colors", () => {
    render(<Markdown>{"[c=#00ff00]online[/c]"}</Markdown>);
    const span = screen.getByText("online");
    expect(span.tagName).toBe("SPAN");
    expect(span).toHaveStyle({ color: "#00ff00" });
  });

  it("leaves an unknown color value as literal text (no injection)", () => {
    render(<Markdown>{"[c=javascript:alert(1)]x[/c]"}</Markdown>);
    // Unresolved color is not turned into a span; the raw token survives.
    expect(screen.getByText(/\[c=javascript:alert\(1\)\]x\[\/c\]/)).toBeInTheDocument();
    expect(screen.queryByText("x")).not.toBeInTheDocument();
  });

  it("still renders bold/italic alongside colors", () => {
    render(<Markdown>{"**bold** and [c=cyan]neon[/c]"}</Markdown>);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    const neon = screen.getByText("neon");
    expect(neon.tagName).toBe("SPAN");
    expect(neon).toHaveStyle({ color: "#22d3ee" });
  });

  it("preserves formatting nested inside a colored run (no leaked markers)", () => {
    render(<Markdown>{"[c=red]**danger**[/c] now"}</Markdown>);
    // The bold survives as a real <strong>, not literal asterisks...
    expect(screen.getByText("danger").tagName).toBe("STRONG");
    // ...and the [c=red] / [/c] markers are consumed, not shown.
    expect(screen.queryByText(/\[c=red\]/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[\/c\]/)).not.toBeInTheDocument();
  });

  it("handles nested colored runs", () => {
    render(<Markdown>{"[c=red]a [c=blue]b[/c] c[/c]"}</Markdown>);
    const inner = screen.getByText("b");
    expect(inner.tagName).toBe("SPAN");
    expect(inner).toHaveStyle({ color: "#4d9fff" });
    // The inner span is wrapped by the outer red span.
    const outer = inner.closest("span")?.parentElement;
    expect(outer?.tagName).toBe("SPAN");
    expect(outer).toHaveStyle({ color: "#ff4d4d" });
  });

  it("leaves an unclosed color tag as literal text", () => {
    render(<Markdown>{"[c=red]oops with no close"}</Markdown>);
    expect(screen.getByText(/\[c=red\]oops with no close/)).toBeInTheDocument();
  });
});

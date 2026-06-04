import { useMemo } from "react";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import Markdown from "@/components/Markdown";

type FaqItem = { question: string; answer: string };

// Strip the markdown emphasis, leading emoji/symbols and a leading "Q:" prefix
// from a `## ` heading so the trigger shows just the clean question text.
function cleanQuestion(s: string): string {
  return s
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^[^\w("'“]+/, "") // drop leading emoji/symbols
    .replace(/^.{0,40}?\bQ:\s*/i, "") // drop a "<emoji/name>: Q:" lead-in (or a bare leading "Q:")
    .trim();
}

// Split the FAQ markdown body into an intro (anything before the first question)
// and a list of question/answer pairs. Each `## ` heading is a question; its
// answer is everything up to the next question, minus any `---` separators.
function parseFaq(body: string): { intro: string; items: FaqItem[] } {
  const lines = body.replace(/\r/g, "").split("\n");
  const introLines: string[] = [];
  const items: FaqItem[] = [];
  let current: { question: string; answerLines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const answer = current.answerLines
      .join("\n")
      .replace(/^(?:\s*-{3,}\s*\n?)+/, "")
      .replace(/(?:\n?\s*-{3,}\s*)+$/, "")
      .trim();
    items.push({ question: current.question, answer });
    current = null;
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      flush();
      current = { question: cleanQuestion(h2[1]), answerLines: [] };
      continue;
    }
    if (current) current.answerLines.push(line);
    else introLines.push(line);
  }
  flush();

  return { intro: introLines.join("\n").trim(), items };
}

export default function FaqAccordion({ body }: { body: string }) {
  const { intro, items } = useMemo(() => parseFaq(body), [body]);

  // No detectable question headings — fall back to plain rendering.
  if (items.length === 0) {
    return <Markdown className="font-mono text-sm leading-relaxed text-foreground/90">{body}</Markdown>;
  }

  return (
    <div className="space-y-4">
      {intro && (
        <Markdown className="font-mono text-sm leading-relaxed text-foreground/90">{intro}</Markdown>
      )}
      <Accordion type="multiple" className="border-t border-border/60">
        {items.map((item, i) => (
          <AccordionItem key={i} value={`faq-${i}`} className="border-border/60">
            <AccordionTrigger
              className="font-display tracking-wide text-base text-nc-cyan hover:no-underline hover:text-nc-cyan/80"
              data-testid={`faq-question-${i}`}
            >
              {item.question}
            </AccordionTrigger>
            <AccordionContent data-testid={`faq-answer-${i}`}>
              <Markdown className="font-mono text-sm leading-relaxed text-foreground/90">
                {item.answer}
              </Markdown>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

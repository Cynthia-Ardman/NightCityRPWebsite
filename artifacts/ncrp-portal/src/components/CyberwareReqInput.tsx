import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

// Multi-value editor for a "required cyberware" field. The underlying value
// stays a single comma-separated string (the DB column and API are plain
// text), so this is purely a UI upgrade: selected pieces render as removable
// chips and new ones are added from a catalog datalist or free-typed. Adding
// commits on Enter, comma, or blur.
export function splitReqs(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function CyberwareReqInput({
  value,
  onChange,
  suggestions,
  placeholder = "e.g. Smart Link (leave blank if none)",
  className = "",
  testId = "input-cyberware-req",
}: {
  value: string;
  onChange: (next: string) => void;
  suggestions?: string[];
  placeholder?: string;
  className?: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState("");
  const tags = useMemo(() => splitReqs(value), [value]);
  const listId = `${testId}-options`;

  const commit = (raw: string) => {
    const name = raw.trim().replace(/,+$/, "").trim();
    if (!name) return;
    if (tags.some((t) => t.toLowerCase() === name.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...tags, name].join(", "));
    setDraft("");
  };

  const remove = (name: string) => {
    onChange(tags.filter((t) => t !== name).join(", "));
  };

  return (
    <div className={className}>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 border border-nc-magenta/50 text-nc-magenta uppercase text-[10px] font-mono px-1.5 py-0.5"
              data-testid={`${testId}-tag-${t}`}
            >
              {t}
              <button
                type="button"
                onClick={() => remove(t)}
                className="hover:text-foreground"
                aria-label={`Remove ${t}`}
                data-testid={`${testId}-remove-${t}`}
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        list={suggestions ? listId : undefined}
        value={draft}
        onChange={(e) => {
          const v = e.target.value;
          // A trailing comma commits the piece immediately.
          if (v.includes(",")) commit(v);
          else if (suggestions?.some((s) => s.toLowerCase() === v.trim().toLowerCase())) commit(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && tags.length > 0) {
            remove(tags[tags.length - 1]);
          }
        }}
        onBlur={() => commit(draft)}
        placeholder={tags.length > 0 ? "Add another…" : placeholder}
        className="rounded-none font-mono"
        data-testid={testId}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions
            .filter((n) => !tags.some((t) => t.toLowerCase() === n.toLowerCase()))
            .map((n) => (
              <option key={n} value={n} />
            ))}
        </datalist>
      )}
    </div>
  );
}

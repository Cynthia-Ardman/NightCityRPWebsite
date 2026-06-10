import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CUSTOM = "__custom__";
const NONE = "__none__";

// Collapse a value to a comparison key so legacy/imported spellings
// ("assault_rifle", "POWER", "semi-auto") resolve to the matching preset
// instead of falling through to a false "Custom…".
function canon(s: string): string {
  return s.toLowerCase().replace(/[\s_/()-]+/g, "");
}

// Resolve a stored value to one of the preset options, honouring an optional
// alias map (keyed on the canonical form). Returns null when nothing matches —
// the caller then treats the value as custom free text.
export function matchOption(
  value: string,
  options: readonly string[],
  aliases?: Record<string, string>,
): string | null {
  if (!value) return null;
  const c = canon(value);
  for (const o of options) if (canon(o) === c) return o;
  if (aliases && aliases[c]) return aliases[c];
  return null;
}

// A dropdown of preset options plus a "Custom…" escape that reveals a free-text
// input. The stored value is never force-normalized on load (so opening a form
// doesn't create spurious diffs); legacy values just display against the
// matching preset via matchOption.
//
// onChange fires on every change (including custom keystrokes) for controlled
// use. onCommit, when provided, fires only on a settled change — a preset/None
// pick, or blur of the custom input — which suits autosave-on-change rows.
export default function SelectOrCustom({
  value,
  onChange,
  onCommit,
  options,
  aliases,
  allowEmpty = true,
  placeholder = "Select…",
  emptyLabel = "— None —",
  customPlaceholder = "Type a custom value",
  className,
  triggerClassName,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
  options: readonly string[];
  aliases?: Record<string, string>;
  allowEmpty?: boolean;
  placeholder?: string;
  emptyLabel?: string;
  customPlaceholder?: string;
  className?: string;
  triggerClassName?: string;
  testId?: string;
}) {
  const matched = matchOption(value, options, aliases);
  const [custom, setCustom] = useState(() => !!value && matched === null);
  // Tracks the custom input's focus + the value it held at focus-in, so we can
  // (a) avoid yanking the field away while the user backspaces it to empty and
  // (b) skip a redundant onCommit when blur leaves the value unchanged.
  const customFocusedRef = useRef(false);
  const customFocusStartRef = useRef("");

  // React to externally-driven value changes (e.g. an "add from catalog"
  // prefill): an unmatched non-empty value reveals the custom field; an external
  // clear collapses back to the dropdown. We deliberately do NOT collapse while
  // the custom input is focused, so clearing the text mid-edit keeps focus.
  useEffect(() => {
    if (value && matchOption(value, options, aliases) === null) setCustom(true);
    else if (!value && !customFocusedRef.current) setCustom(false);
    // options/aliases are stable module-level constants; matchOption is pure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const selectValue = custom ? CUSTOM : matched ?? (allowEmpty ? NONE : "");

  return (
    <div className={className}>
      <Select
        value={selectValue}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            setCustom(true);
          } else if (v === NONE) {
            setCustom(false);
            onChange("");
            onCommit?.("");
          } else {
            setCustom(false);
            onChange(v);
            onCommit?.(v);
          }
        }}
      >
        <SelectTrigger
          className={triggerClassName ?? "rounded-none font-mono text-sm"}
          data-testid={testId}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allowEmpty && <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {custom && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            customFocusedRef.current = true;
            customFocusStartRef.current = value;
          }}
          onBlur={() => {
            customFocusedRef.current = false;
            // Only commit when the text actually changed during this edit, so
            // merely focusing and leaving the field doesn't fire a save.
            if (value !== customFocusStartRef.current) onCommit?.(value);
            // A focus-out left empty collapses back to the dropdown.
            if (!value) setCustom(false);
          }}
          placeholder={customPlaceholder}
          className="rounded-none mt-2 font-mono text-sm"
          data-testid={testId ? `${testId}-custom` : undefined}
        />
      )}
    </div>
  );
}

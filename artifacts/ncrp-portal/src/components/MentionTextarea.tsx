import { useEffect, useMemo, useRef, useState } from "react";
import {
  useAdminSearchDiscordMembers,
  getAdminSearchDiscordMembersQueryKey,
  useAdminSearchDiscordChannels,
  getAdminSearchDiscordChannelsQueryKey,
} from "@workspace/api-client-react";
import { Textarea } from "@/components/ui/textarea";

type TriggerKind = "@" | "#";
type Trigger = { kind: TriggerKind; query: string; start: number };
type Option = { id: string; insert: string; primary: string; secondary?: string };

// Scan backwards from the caret to find an active `@word` / `#word` token. A
// token is only valid when the `@`/`#` sits at the start of the text or right
// after whitespace, and there is no whitespace between it and the caret —
// mirroring Discord's composer.
function detectTrigger(text: string, caret: number): Trigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "#") {
      const prev = i > 0 ? text[i - 1] : "";
      if (prev === "" || /\s/.test(prev)) {
        return { kind: ch as TriggerKind, query: text.slice(i + 1, caret), start: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

// A Textarea with Discord-style autocomplete: typing `@` searches guild members
// and `#` searches guild channels, inserting a friendly `@name` / `#channel`
// token. The lookups hit staff-only endpoints, so `enableMentions` should only
// be set for fixers/admins; otherwise it behaves as a plain textarea.
export default function MentionTextarea({
  value,
  onChange,
  enableMentions = false,
  placeholder,
  rows = 2,
  maxLength,
  disabled,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  enableMentions?: boolean;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // Debounce the live query so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(trigger?.query ?? ""), 250);
    return () => clearTimeout(t);
  }, [trigger?.query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setTrigger(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const isUser = trigger?.kind === "@";
  const isChannel = trigger?.kind === "#";
  // Members need ≥2 chars (live Discord search); channels are cached so an empty
  // query lists them immediately when you type `#`.
  const usersEnabled = enableMentions && isUser && debounced.length >= 2;
  const channelsEnabled = enableMentions && !!isChannel;

  const users = useAdminSearchDiscordMembers(
    { q: debounced },
    { query: { enabled: usersEnabled, queryKey: getAdminSearchDiscordMembersQueryKey({ q: debounced }) } },
  );
  const channels = useAdminSearchDiscordChannels(
    { q: debounced },
    { query: { enabled: channelsEnabled, queryKey: getAdminSearchDiscordChannelsQueryKey({ q: debounced }) } },
  );

  const options = useMemo<Option[]>(() => {
    if (isUser) {
      return (users.data ?? []).map((m) => ({
        id: m.id,
        insert: `@${m.username}`,
        primary: m.globalName ?? m.username,
        secondary: `@${m.username}`,
      }));
    }
    if (isChannel) {
      return (channels.data ?? []).map((c) => ({
        id: c.id,
        insert: `#${c.name}`,
        primary: `#${c.name}`,
      }));
    }
    return [];
  }, [isUser, isChannel, users.data, channels.data]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.kind, debounced]);

  const fetching = isUser ? users.isFetching : isChannel ? channels.isFetching : false;
  const isError = isUser ? users.isError : isChannel ? channels.isError : false;
  const needMoreChars = isUser && debounced.length < 2;
  const showDropdown = enableMentions && trigger !== null;

  function syncTrigger() {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? el.value.length;
    setTrigger(enableMentions ? detectTrigger(el.value, caret) : null);
  }

  function applyOption(opt: Option) {
    const el = ref.current;
    if (!trigger) return;
    const caret = el ? (el.selectionStart ?? value.length) : value.length;
    const before = value.slice(0, trigger.start);
    const after = value.slice(caret);
    const inserted = `${opt.insert} `;
    const next = before + inserted + after;
    onChange(next);
    setTrigger(null);
    const pos = (before + inserted).length;
    requestAnimationFrame(() => {
      const node = ref.current;
      if (node) {
        node.focus();
        node.setSelectionRange(pos, pos);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!showDropdown || options.length === 0) {
      if (e.key === "Escape" && trigger) setTrigger(null);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyOption(options[Math.min(activeIndex, options.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setTrigger(null);
    }
  }

  return (
    <div className="relative" ref={boxRef}>
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          const caret = e.target.selectionStart ?? e.target.value.length;
          setTrigger(enableMentions ? detectTrigger(e.target.value, caret) : null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          // Recompute the active token after caret moves (arrows/home/end)
          // that don't change the text.
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) syncTrigger();
        }}
        onClick={syncTrigger}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        data-testid={testId}
      />
      {showDropdown && (
        <div
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto border border-nc-cyan/60 bg-card shadow-lg"
          data-testid="mention-dropdown"
        >
          {needMoreChars ? (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">
              Type at least 2 characters to search members…
            </div>
          ) : fetching ? (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">Searching…</div>
          ) : isError ? (
            <div className="px-2 py-2 font-mono text-xs text-destructive">
              {isUser ? "Member" : "Channel"} search unavailable — try again
            </div>
          ) : options.length === 0 ? (
            <div className="px-2 py-2 font-mono text-xs text-muted-foreground">
              No {isUser ? "members" : "channels"} found
            </div>
          ) : (
            options.map((opt, i) => (
              <button
                key={`${trigger?.kind}-${opt.id}`}
                type="button"
                className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent ${
                  i === activeIndex ? "bg-accent" : ""
                }`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyOption(opt);
                }}
                data-testid={`mention-option-${opt.id}`}
              >
                <span className="flex-1 truncate font-mono">
                  {opt.primary}
                  {opt.secondary && (
                    <span className="ml-1 text-muted-foreground">{opt.secondary}</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

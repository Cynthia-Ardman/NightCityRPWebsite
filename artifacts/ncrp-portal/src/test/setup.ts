import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Node 24 ships an experimental built-in `localStorage` (Web Storage API) that
// can shadow jsdom's and surface as a broken stub (missing getItem/clear) when
// no `--localstorage-file` is set. Install a deterministic in-memory Storage on
// both window and globalThis so component tests get a consistent localStorage.
function installMemoryStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  };
  for (const target of [globalThis, globalThis.window].filter(Boolean) as object[]) {
    Object.defineProperty(target, "localStorage", {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}
installMemoryStorage();

// jsdom lacks the Pointer Capture / scrollIntoView APIs that Radix primitives
// (Tabs, Select, etc.) call during interaction. Stub them so userEvent-driven
// component tests don't throw before the interaction is processed.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// jsdom has no ResizeObserver, which MarkdownEditor uses to re-autosize when a
// hidden field is revealed. Stub it so component tests can mount those editors.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
});

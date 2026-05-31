import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Me } from "@workspace/api-client-react";

// useEffectiveMe is the security-critical seam for the "View as" preview: it must
// ONLY downgrade the role flags the frontend reads, and ONLY when the REAL user
// is an admin. A non-admin must never be able to set an override that changes
// their effective identity (the backend gates anyway, but the UI must not lie).
const h = vi.hoisted(() => ({ me: null as Me | null }));

vi.mock("@/hooks/useAuthMe", () => ({
  useAuthMe: () => ({ data: h.me, isLoading: false, isError: false }),
}));

import { ViewAsProvider, useEffectiveMe, useViewAs } from "./ViewAsContext";

function makeMe(over: Partial<Me> = {}): Me {
  return {
    id: "u1",
    discordId: "d1",
    username: "tester",
    globalName: null,
    avatarUrl: null,
    roles: [],
    isAdmin: false,
    isFixer: false,
    isArchivist: false,
    isCsApprover: false,
    isRipperdoc: false,
    isStoreOwner: false,
    activeCharacterId: null,
    ...over,
  };
}

const wrapper = ({ children }: { children: ReactNode }) => <ViewAsProvider>{children}</ViewAsProvider>;

// Render both hooks so a test can flip the override and read the effective Me.
function renderEffective() {
  return renderHook(() => ({ eff: useEffectiveMe(), ctx: useViewAs() }), { wrapper });
}

beforeEach(() => {
  h.me = null;
});

describe("useEffectiveMe — preview override is admin-gated", () => {
  it("applies a 'player' override for a real admin (strips every staff flag)", () => {
    h.me = makeMe({ isAdmin: true, isFixer: true, isRipperdoc: true });
    const { result } = renderEffective();

    act(() => result.current.ctx.setViewAs("player"));

    expect(result.current.eff.realIsAdmin).toBe(true);
    expect(result.current.eff.viewAs).toBe("player");
    expect(result.current.eff.data?.isAdmin).toBe(false);
    expect(result.current.eff.data?.isFixer).toBe(false);
    expect(result.current.eff.data?.isRipperdoc).toBe(false);
  });

  it("applies a 'fixer' override for a real admin (re-enables only fixer)", () => {
    h.me = makeMe({ isAdmin: true });
    const { result } = renderEffective();

    act(() => result.current.ctx.setViewAs("fixer"));

    expect(result.current.eff.data?.isAdmin).toBe(false);
    expect(result.current.eff.data?.isFixer).toBe(true);
    expect(result.current.eff.data?.isRipperdoc).toBe(false);
  });

  it("IGNORES the override for a non-admin (cannot grant or change privileges)", () => {
    h.me = makeMe({ isAdmin: false, isFixer: true });
    const { result } = renderEffective();

    // A non-admin sets an override; it must be a no-op.
    act(() => result.current.ctx.setViewAs("player"));

    expect(result.current.eff.realIsAdmin).toBe(false);
    // viewAs reported by useEffectiveMe is null because the real user isn't admin.
    expect(result.current.eff.viewAs).toBeNull();
    // Effective identity is unchanged — still the real fixer.
    expect(result.current.eff.data?.isFixer).toBe(true);
  });

  it("returns the real identity unchanged when no override is active", () => {
    h.me = makeMe({ isAdmin: true });
    const { result } = renderEffective();

    expect(result.current.eff.viewAs).toBeNull();
    expect(result.current.eff.data?.isAdmin).toBe(true);
  });
});

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Me } from "@workspace/api-client-react";
import { useAuthMe } from "@/hooks/useAuthMe";

// Preview-only role override. Lets a real admin see the app as a lower-privilege
// role WITHOUT changing any real permission — it only downgrades the role flags
// the frontend reads to gate navigation and staff controls. The backend still
// enforces the user's true roles, so no override can grant or perform a
// privileged action. Not persisted (resets on reload), by design.
export type ViewAsRole = "player" | "ripperdoc" | "fixer" | "new_user";

type ViewAsContextValue = {
  viewAs: ViewAsRole | null;
  setViewAs: (role: ViewAsRole | null) => void;
};

const ViewAsContext = createContext<ViewAsContextValue>({
  viewAs: null,
  setViewAs: () => {},
});

export function ViewAsProvider({ children }: { children: ReactNode }) {
  const [viewAs, setViewAs] = useState<ViewAsRole | null>(null);
  const value = useMemo(() => ({ viewAs, setViewAs }), [viewAs]);
  return <ViewAsContext.Provider value={value}>{children}</ViewAsContext.Provider>;
}

export function useViewAs() {
  return useContext(ViewAsContext);
}

// Strip every staff flag, then re-enable only the one(s) the previewed role has.
function downgrade(me: Me, role: ViewAsRole): Me {
  const base: Me = {
    ...me,
    isAdmin: false,
    isFixer: false,
    isArchivist: false,
    isCsApprover: false,
    isRipperdoc: false,
    isStoreOwner: false,
    isNcpd: false,
    isNcpdCommissioner: false,
  };
  if (role === "ripperdoc") base.isRipperdoc = true;
  if (role === "fixer") base.isFixer = true;
  // "player" and "new_user" keep every staff flag off. The "new_user" preview
  // additionally surfaces the first-run onboarding banner — that is driven by
  // the OnboardingBanner component reading the active View-as role, not here,
  // since onboarding state (loginCount / dismissed) lives on the real account.
  return base;
}

// Like useAuthMe, but applies the active "View as" override when the REAL user
// is an admin. Returns the effective Me plus context so callers can tell a
// preview apart from a real admin. Use this for UI gating (nav, staff
// controls). Use useAuthMe directly when you specifically need the real
// identity (e.g. to decide whether to show the View-as switcher itself).
export function useEffectiveMe() {
  const query = useAuthMe();
  const { viewAs } = useViewAs();
  const real = query.data;
  const realIsAdmin = !!real?.isAdmin;
  const realIsFixer = !!real?.isFixer;
  const active = realIsAdmin ? viewAs : null;
  const data = real && active ? downgrade(real, active) : real;
  return { ...query, data, realIsAdmin, realIsFixer, viewAs: active };
}

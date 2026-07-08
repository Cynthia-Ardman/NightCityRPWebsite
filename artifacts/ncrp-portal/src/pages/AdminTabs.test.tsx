import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Shared mock state — vi.hoisted lets the vi.mock factory below read these so
// individual tests can flip a tab between its loading / empty / populated
// branches without re-mocking the whole module.
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  state: {
    usersLoading: false as boolean,
    users: undefined as unknown,
    charsLoading: false as boolean,
    chars: undefined as unknown,
    economyLoading: false as boolean,
    economy: undefined as unknown,
    jobsLoading: false as boolean,
    jobs: undefined as unknown,
    botConfig: undefined as unknown,
    auditLoading: false as boolean,
    audit: undefined as unknown,
    liveMode: undefined as unknown,
  },
}));

// Render-guard regression net for the System Admin tabs. Each tab once risked
// crashing on mount from a stray form primitive or hook misuse (see WalletTab).
// Mock the whole api-client + toast layer so every tab mounts without a network
// stack; the assertions only confirm the tab rendered something, not behaviour.
vi.mock("@workspace/api-client-react", () => ({
  // Users
  useAdminListUsers: () => ({ data: h.state.users, isLoading: h.state.usersLoading }),
  useAdminHydrateUsers: () => ({ mutate: h.mutate, isPending: false }),
  useAdminSetCyberpsychoAccess: () => ({ mutate: h.mutate, isPending: false }),
  getAdminListUsersQueryKey: () => ["admin-users"],
  // Characters
  useAdminListCharacters: () => ({ data: h.state.chars, isLoading: h.state.charsLoading }),
  useAdminAssignCharacterOwner: () => ({ mutate: h.mutate, isPending: false }),
  useAdminClearCharacterOwner: () => ({ mutate: h.mutate, isPending: false }),
  useAdminCreateCharacter: () => ({
    mutate: h.mutate,
    mutateAsync: h.mutate,
    isPending: false,
    reset: vi.fn(),
  }),
  getAdminListCharactersQueryKey: () => ["admin-chars"],
  // Cyberware catalog (rendered by CreateCharacterCard's CyberwareEditor)
  useListCyberware: () => ({ data: undefined, isLoading: false }),
  // Economy
  useAdminGetEconomyOutOfSync: () => ({
    data: h.state.economy,
    isLoading: h.state.economyLoading,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useAdminRetryEconomySync: () => ({ mutate: h.mutate, isPending: false }),
  getAdminGetEconomyOutOfSyncQueryKey: () => ["admin-economy"],
  // Jobs + flags
  useAdminListJobs: () => ({ data: h.state.jobs, isLoading: h.state.jobsLoading }),
  useAdminRunJob: () => ({ mutate: h.mutate, isPending: false }),
  useAdminListBotConfig: () => ({ data: h.state.botConfig, isLoading: false }),
  useAdminSetBotConfig: () => ({ mutate: h.mutate, isPending: false }),
  useAdminDeleteBotConfig: () => ({ mutate: h.mutate, isPending: false }),
  getAdminListJobsQueryKey: () => ["admin-jobs"],
  getAdminListBotConfigQueryKey: () => ["admin-bot-config"],
  // Audit
  useAdminListAuditLog: () => ({
    data: h.state.audit,
    isLoading: h.state.auditLoading,
    refetch: vi.fn(),
  }),
  getAdminListAuditLogQueryKey: () => ["admin-audit-log"],
  // Live-mode switchboard
  useAdminGetLiveMode: () => ({ data: h.state.liveMode, isLoading: false }),
  useAdminSetLiveMode: () => ({ mutate: h.mutate, isPending: false }),
  getAdminGetLiveModeQueryKey: () => ["admin-live-mode"],
  getGetMissionConfigQueryKey: () => ["mission-config"],
  useAdminScanVrchatLinks: () => ({ mutate: h.mutate, isPending: false }),
  // Site-access / login restriction (rendered by JobsTab's LoginRestrictionCard)
  useAdminGetSiteAccess: () => ({ data: undefined, isLoading: false }),
  useAdminSetSiteAccess: () => ({ mutate: h.mutate, isPending: false }),
  // VRChat calendar sync (rendered by JobsTab's VrchatCalendarSyncCard)
  useAdminGetVrchatCalendarSync: () => ({ data: undefined, isLoading: false }),
  useAdminSetVrchatCalendarSync: () => ({ mutate: h.mutate, isPending: false }),
  getAdminGetVrchatCalendarSyncQueryKey: () => ["admin-vrchat-calendar-sync"],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import {
  UsersTab,
  CharactersTab,
  EconomyTab,
  JobsTab,
  AuditLogTab,
  FlagsTab,
  MaintenanceTab,
  LiveModeSwitchboard,
} from "./AdminDashboard";
import ErrorBoundary from "@/components/ErrorBoundary";

// Several tabs call useQueryClient().invalidateQueries, so they need a live
// QueryClientProvider even though the network hooks themselves are mocked.
function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  h.mutate.mockReset();
  h.state.usersLoading = false;
  h.state.users = undefined;
  h.state.charsLoading = false;
  h.state.chars = undefined;
  h.state.economyLoading = false;
  h.state.economy = undefined;
  h.state.jobsLoading = false;
  h.state.jobs = undefined;
  h.state.botConfig = undefined;
  h.state.auditLoading = false;
  h.state.audit = undefined;
  h.state.liveMode = undefined;
});

describe("UsersTab", () => {
  it("mounts in its loading state without crashing", () => {
    h.state.usersLoading = true;
    expect(() => renderWithClient(<UsersTab />)).not.toThrow();
  });

  it("mounts with users and renders rows without crashing", () => {
    h.state.users = [
      {
        id: "u1",
        username: "user_abc123",
        globalName: null,
        discordId: "123",
        avatarUrl: null,
        isAdmin: true,
        isFixer: false,
        isRipperdoc: false,
        isStoreOwner: false,
        isCsApprover: false,
        characterCount: 2,
      },
    ];
    renderWithClient(<UsersTab />);
    expect(screen.getByTestId("button-hydrate-users")).toBeInTheDocument();
    expect(screen.getByTestId("row-user-u1")).toBeInTheDocument();
  });
});

describe("CharactersTab", () => {
  it("mounts in its loading state without crashing", () => {
    h.state.charsLoading = true;
    expect(() => renderWithClient(<CharactersTab />)).not.toThrow();
  });

  it("mounts with characters and renders filters without crashing", () => {
    h.state.chars = [
      {
        id: 5,
        name: "Vega",
        kind: "pc",
        ownerId: null,
        legacyDiscordUsername: "vega#1",
      },
    ];
    renderWithClient(<CharactersTab />);
    expect(screen.getByTestId("button-admin-char-filter-all")).toBeInTheDocument();
    expect(screen.getByTestId("row-char-5")).toBeInTheDocument();
  });
});

describe("EconomyTab", () => {
  it("mounts in its loading state without crashing", () => {
    h.state.economyLoading = true;
    expect(() => renderWithClient(<EconomyTab />)).not.toThrow();
  });

  it("mounts with out-of-sync entries without crashing", () => {
    h.state.economy = {
      mode: "enabled",
      entries: [
        {
          userId: "u1",
          username: "nomad",
          globalName: "Nomad",
          walletBalance: 100,
          ubBalance: 90,
          diff: 10,
          lastSyncedAt: new Date().toISOString(),
          lastSyncStatus: "ok",
          lastSyncError: null,
        },
      ],
    };
    renderWithClient(<EconomyTab />);
    expect(screen.getByTestId("button-economy-refresh")).toBeInTheDocument();
    expect(screen.getByTestId("row-economy-u1")).toBeInTheDocument();
  });
});

describe("JobsTab", () => {
  it("mounts in its loading state without crashing", () => {
    h.state.jobsLoading = true;
    expect(() => renderWithClient(<JobsTab />)).not.toThrow();
  });

  it("mounts the switchboard, autobill switches and job table without crashing", () => {
    h.state.liveMode = {
      master: false,
      systems: {
        missions: { configured: false, effective: false },
        housing: { configured: true, effective: false },
        cyberware: { configured: false, effective: false },
        evictions: { configured: false, effective: false },
      },
    };
    h.state.botConfig = [{ key: "housing_autobill_enabled", value: true, updatedAt: new Date().toISOString() }];
    h.state.jobs = [
      { id: 1, job: "monthly_rent", status: "success", message: "ok", startedAt: new Date().toISOString() },
    ];
    renderWithClient(<JobsTab />);
    expect(screen.getByTestId("live-mode-switchboard")).toBeInTheDocument();
    expect(screen.getByTestId("btn-job-rent")).toBeInTheDocument();
    expect(screen.getByTestId("row-job-1")).toBeInTheDocument();
  });
});

describe("AuditLogTab", () => {
  it("mounts in its loading state without crashing", () => {
    h.state.auditLoading = true;
    expect(() => renderWithClient(<AuditLogTab />)).not.toThrow();
  });

  it("mounts with audit rows without crashing", () => {
    h.state.audit = [
      {
        id: 7,
        category: "wallet",
        action: "adjust",
        actorName: "Admin",
        actorId: "a1",
        message: "Adjusted wallet",
        createdAt: new Date().toISOString(),
      },
    ];
    renderWithClient(<AuditLogTab />);
    expect(screen.getByTestId("button-auditlog-apply")).toBeInTheDocument();
    expect(screen.getByTestId("row-auditlog-7")).toBeInTheDocument();
  });
});

describe("FlagsTab", () => {
  it("mounts with no flags without crashing", () => {
    expect(() => renderWithClient(<FlagsTab />)).not.toThrow();
    expect(screen.getByTestId("button-flag-create")).toBeInTheDocument();
  });

  it("mounts with flag rows and renders editable inputs without crashing", () => {
    h.state.botConfig = [
      { key: "trauma_team.enabled", value: true, updatedAt: new Date().toISOString() },
    ];
    renderWithClient(<FlagsTab />);
    expect(screen.getByTestId("row-flag-trauma_team.enabled")).toBeInTheDocument();
    expect(screen.getByTestId("input-flag-edit-trauma_team.enabled")).toBeInTheDocument();
  });
});

describe("LiveModeSwitchboard", () => {
  it("mounts without crashing when state is still loading", () => {
    expect(() => renderWithClient(<LiveModeSwitchboard />)).not.toThrow();
    expect(screen.getByTestId("live-mode-switchboard")).toBeInTheDocument();
  });

  it("renders the master switch and per-system rows without crashing", () => {
    h.state.liveMode = {
      master: true,
      systems: {
        missions: { configured: true, effective: true },
        housing: { configured: false, effective: false },
        cyberware: { configured: false, effective: false },
        evictions: { configured: false, effective: false },
      },
    };
    renderWithClient(<LiveModeSwitchboard />);
    expect(screen.getByTestId("button-live-mode-master")).toBeInTheDocument();
    expect(screen.getByTestId("live-mode-missions")).toBeInTheDocument();
  });
});

describe("MaintenanceTab", () => {
  it("mounts the NPC sync surfaces without crashing", () => {
    expect(() => renderWithClient(<MaintenanceTab />)).not.toThrow();
    expect(screen.getByTestId("button-npc-export")).toBeInTheDocument();
  });
});

describe("admin tab error boundary", () => {
  it("contains a crashing tab and shows a recoverable fault message", () => {
    const Boom = () => {
      throw new Error("tab exploded");
    };
    // Silence the expected React error log for the thrown render.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithClient(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ui-error-boundary")).toBeInTheDocument();
    spy.mockRestore();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Me,
  MissionSummary,
  MissionApplicationListItem,
} from "@workspace/api-client-react";

// Mutable holder so each test can stage its own auth role and per-tab mission
// lists. Mocks read from this at call time.
const state = vi.hoisted(() => ({
  me: null as Me | null,
  availableMissions: [] as MissionSummary[],
  myMissions: [] as MissionSummary[],
  myApplications: [] as MissionApplicationListItem[],
  createdMissions: [] as MissionSummary[],
  historyMissions: [] as MissionSummary[],
  ownedMissions: [] as MissionSummary[],
  submit: vi.fn(),
  approve: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/hooks/useAuthMe", () => ({
  useAuthMe: () => ({ data: state.me }),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListMissions: () => ({ data: state.availableMissions, isLoading: false }),
    useListMyMissions: () => ({ data: state.myMissions, isLoading: false }),
    useListMyApplications: () => ({ data: state.myApplications, isLoading: false }),
    useListCreatedMissions: () => ({ data: state.createdMissions, isLoading: false }),
    useListMissionHistory: () => ({ data: state.historyMissions, isLoading: false }),
    useListOwnedMissions: () => ({ data: state.ownedMissions, isLoading: false }),
    useSubmitMission: () => ({ mutate: state.submit, isPending: false }),
    useApproveMission: () => ({ mutate: state.approve, isPending: false }),
    usePostMission: () => ({ mutate: state.post, isPending: false }),
    // Banners are inert in these tests: live mode hides the test banner, and
    // there are no outcomes to surface, so neither adds noise to tab assertions.
    useGetMissionConfig: () => ({ data: { live: true } }),
    useListMyApplicationOutcomes: () => ({ data: [] }),
  };
});

import Missions from "./Missions";

function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: "user-1",
    discordId: "d1",
    username: "tester",
    avatarUrl: null,
    roles: [],
    isAdmin: false,
    isFixer: false,
    isArchivist: false,
    isCsApprover: false,
    isRipperdoc: false,
    isStoreOwner: false,
    ...overrides,
  } as Me;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Missions />
    </QueryClientProvider>,
  );
}

// Tabs that every authenticated user can always see.
const PLAYER_TABS = ["open", "accepted", "applications", "history"] as const;
// Tabs gated behind staff/approver roles.
const STAFF_TABS = ["created", "all"] as const;

beforeEach(() => {
  state.me = null;
  state.availableMissions = [];
  state.myMissions = [];
  state.myApplications = [];
  state.createdMissions = [];
  state.historyMissions = [];
  state.ownedMissions = [];
  state.submit.mockReset();
  state.approve.mockReset();
  state.post.mockReset();
});

describe("Missions tabs — plain player", () => {
  it("sees only Open / Accepted / My Applications / History tabs", () => {
    state.me = makeMe();
    renderPage();

    for (const key of PLAYER_TABS) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
  });

  it("never sees the staff-only My Created / All Missions tabs", () => {
    state.me = makeMe();
    renderPage();

    for (const key of STAFF_TABS) {
      expect(screen.queryByTestId(`tab-${key}`)).toBeNull();
    }
    // The create entrypoint is staff-only too.
    expect(screen.queryByTestId("button-create-mission")).toBeNull();
  });
});

describe("Missions tabs — fixer", () => {
  it("sees every tab including My Created and All Missions, plus Create", () => {
    state.me = makeMe({ isFixer: true });
    renderPage();

    for (const key of [...PLAYER_TABS, ...STAFF_TABS]) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("button-create-mission")).toBeInTheDocument();
  });
});

describe("Missions tabs — admin", () => {
  it("sees every tab including My Created and All Missions, plus Create", () => {
    state.me = makeMe({ isAdmin: true });
    renderPage();

    for (const key of [...PLAYER_TABS, ...STAFF_TABS]) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("button-create-mission")).toBeInTheDocument();
  });
});

describe("Missions tabs — archivist (approver, not manager)", () => {
  it("sees All Missions but NOT My Created or the Create button", () => {
    state.me = makeMe({ isArchivist: true });
    renderPage();

    for (const key of PLAYER_TABS) {
      expect(screen.getByTestId(`tab-${key}`)).toBeInTheDocument();
    }
    // Approvers need the staff-wide board to find proposals awaiting review...
    expect(screen.getByTestId("tab-all")).toBeInTheDocument();
    // ...but they don't run missions, so "My Created" and Create stay hidden.
    expect(screen.queryByTestId("tab-created")).toBeNull();
    expect(screen.queryByTestId("button-create-mission")).toBeNull();
  });
});

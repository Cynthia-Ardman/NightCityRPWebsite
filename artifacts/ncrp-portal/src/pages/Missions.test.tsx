import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Me, MissionSummary } from "@workspace/api-client-react";

// Mutable holder so each test can stage its own auth role, mission lists, and
// assert against the shared mutation spies. Mocks read from this at call time.
const state = vi.hoisted(() => ({
  me: null as Me | null,
  myMissions: [] as MissionSummary[],
  ownedMissions: [] as MissionSummary[],
  availableMissions: [] as MissionSummary[],
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
    useListMyMissions: () => ({ data: state.myMissions, isLoading: false }),
    useListOwnedMissions: () => ({ data: state.ownedMissions, isLoading: false }),
    useListMissions: () => ({ data: state.availableMissions, isLoading: false }),
    useSubmitMission: () => ({ mutate: state.submit, isPending: false }),
    useApproveMission: () => ({ mutate: state.approve, isPending: false }),
    usePostMission: () => ({ mutate: state.post, isPending: false }),
    // Banner is live (returns null) so it never adds noise to these assertions.
    useGetMissionConfig: () => ({ data: { live: true } }),
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

let nextId = 100;
function makeMission(overrides: Partial<MissionSummary> = {}): MissionSummary {
  return {
    id: nextId++,
    title: "Test Job",
    tier: 1,
    status: "open",
    workflowState: "draft",
    durationMinutes: 60,
    playerPay: 1000,
    slots: 4,
    maxPlayers: 4,
    assignedCount: 0,
    players: [],
    createdAt: new Date("2026-01-01").toISOString(),
    ...overrides,
  } as MissionSummary;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Missions />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.me = null;
  state.myMissions = [];
  state.ownedMissions = [];
  state.availableMissions = [];
  state.submit.mockReset();
  state.approve.mockReset();
  state.post.mockReset();
  nextId = 100;
});

describe("Missions list — fixer", () => {
  it("shows Create + the owned board, with Submit on drafts and Post on approved missions", () => {
    state.me = makeMe({ isFixer: true });
    const draft = makeMission({ workflowState: "draft", title: "Draft Run" });
    const approved = makeMission({ workflowState: "approved", title: "Approved Run" });
    state.ownedMissions = [draft, approved];
    renderPage();

    expect(screen.getByTestId("button-create-mission")).toBeInTheDocument();
    expect(screen.getByTestId("card-owned-missions")).toBeInTheDocument();
    expect(screen.getByTestId(`button-submit-${draft.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`button-post-${approved.id}`)).toBeInTheDocument();
  });

  it("does NOT show Approve on a proposal it does not own approval rights for", () => {
    state.me = makeMe({ isFixer: true });
    const proposal = makeMission({ workflowState: "proposal" });
    state.ownedMissions = [proposal];
    renderPage();

    // A fixer who isn't an archivist cannot approve.
    expect(screen.queryByTestId(`button-approve-${proposal.id}`)).toBeNull();
  });

  it("fires the submit mutation when Submit is clicked", () => {
    state.me = makeMe({ isFixer: true });
    const draft = makeMission({ workflowState: "draft" });
    state.ownedMissions = [draft];
    renderPage();

    fireEvent.click(screen.getByTestId(`button-submit-${draft.id}`));
    expect(state.submit).toHaveBeenCalledWith({ id: draft.id });
  });
});

describe("Missions list — archivist", () => {
  it("shows Approve on proposals but NOT Create, Submit, or Post", () => {
    state.me = makeMe({ isArchivist: true });
    const proposal = makeMission({ workflowState: "proposal", title: "Pending Approval" });
    const draft = makeMission({ workflowState: "draft" });
    const approved = makeMission({ workflowState: "approved" });
    state.ownedMissions = [proposal, draft, approved];
    renderPage();

    expect(screen.getByTestId("card-owned-missions")).toBeInTheDocument();
    expect(screen.getByTestId(`button-approve-${proposal.id}`)).toBeInTheDocument();

    // Archivists are approvers, not creators/managers.
    expect(screen.queryByTestId("button-create-mission")).toBeNull();
    expect(screen.queryByTestId(`button-submit-${draft.id}`)).toBeNull();
    expect(screen.queryByTestId(`button-post-${approved.id}`)).toBeNull();
  });

  it("fires the approve mutation when Approve is clicked", () => {
    state.me = makeMe({ isArchivist: true });
    const proposal = makeMission({ workflowState: "proposal" });
    state.ownedMissions = [proposal];
    renderPage();

    fireEvent.click(screen.getByTestId(`button-approve-${proposal.id}`));
    expect(state.approve).toHaveBeenCalledWith({ id: proposal.id });
  });
});

describe("Missions list — plain player", () => {
  it("sees the public Available list with Apply, but no owned board or workflow buttons", () => {
    state.me = makeMe();
    const posted = makeMission({ workflowState: "posted", status: "open", title: "Public Gig" });
    state.availableMissions = [posted];
    renderPage();

    expect(screen.getByTestId("card-available-missions")).toBeInTheDocument();
    expect(screen.getByTestId(`button-apply-${posted.id}`)).toBeInTheDocument();

    expect(screen.queryByTestId("card-owned-missions")).toBeNull();
    expect(screen.queryByTestId("button-create-mission")).toBeNull();
    expect(screen.queryByTestId(`button-submit-${posted.id}`)).toBeNull();
    expect(screen.queryByTestId(`button-approve-${posted.id}`)).toBeNull();
    expect(screen.queryByTestId(`button-post-${posted.id}`)).toBeNull();
  });
});

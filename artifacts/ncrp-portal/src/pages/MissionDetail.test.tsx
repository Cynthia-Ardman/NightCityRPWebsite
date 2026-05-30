import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Me,
  MissionDetail as MissionDetailModel,
  MissionApplicationView,
} from "@workspace/api-client-react";

const state = vi.hoisted(() => ({
  me: null as Me | null,
  mission: null as MissionDetailModel | null,
  myCharacters: [] as Array<{ id: number; name: string }>,
  apply: vi.fn(),
  withdraw: vi.fn(),
  review: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/hooks/useAuthMe", () => ({
  useAuthMe: () => ({ data: state.me }),
}));

vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return {
    ...actual,
    useParams: () => ({ id: String(state.mission?.id ?? 1) }),
  };
});

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMission: () => ({ data: state.mission, isLoading: false, error: null }),
    useListMyCharacters: () => ({ data: state.myCharacters }),
    useApplyToMission: () => ({ mutate: state.apply, isPending: false, error: null }),
    useWithdrawApplication: () => ({ mutate: state.withdraw, isPending: false, error: null }),
    useReviewApplication: () => ({ mutate: state.review, isPending: false, error: null }),
    useSubmitMission: () => ({ mutate: state.submit, isPending: false, error: null }),
    useApproveMission: () => ({ mutate: state.approve, isPending: false, error: null }),
    usePostMission: () => ({ mutate: state.post, isPending: false, error: null }),
    usePayMissionPlayers: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    usePayMissionActors: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useGetMissionConfig: () => ({ data: { live: true } }),
  };
});

import MissionDetail from "./MissionDetail";

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

function makeApplication(overrides: Partial<MissionApplicationView> = {}): MissionApplicationView {
  return {
    id: 500,
    userId: "player-9",
    characterId: 42,
    characterName: "Jackie",
    status: "pending",
    createdAt: new Date("2026-05-01").toISOString(),
    attendanceCount: 3,
    recencyWarning: false,
    ...overrides,
  } as MissionApplicationView;
}

function makeMission(overrides: Partial<MissionDetailModel> = {}): MissionDetailModel {
  return {
    id: 7,
    title: "Server Run",
    tier: 2,
    status: "open",
    workflowState: "posted",
    durationMinutes: 90,
    playerPay: 2500,
    slots: 4,
    maxPlayers: 4,
    canManage: false,
    canApprove: false,
    live: true,
    assignments: [],
    actorPayments: [],
    applications: [],
    createdAt: new Date("2026-04-01").toISOString(),
    ...overrides,
  } as MissionDetailModel;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MissionDetail />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.me = makeMe();
  state.mission = null;
  state.myCharacters = [];
  state.apply.mockReset();
  state.withdraw.mockReset();
  state.review.mockReset();
  state.submit.mockReset();
  state.approve.mockReset();
  state.post.mockReset();
});

describe("MissionDetail — applications recency warning", () => {
  it("renders the recency warning for a recent applicant in the manager applications panel", async () => {
    const user = userEvent.setup();
    state.me = makeMe({ isFixer: true });
    const app = makeApplication({ recencyWarning: true, daysSinceLastMission: 5 });
    state.mission = makeMission({ canManage: true, applications: [app] });
    renderPage();

    // The applications panel lives under the FIXER tab.
    await user.click(screen.getByTestId("tab-fixer"));

    const warning = await screen.findByTestId(`recency-warning-${app.id}`);
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent("Played a mission 5 days ago");
  });

  it("does not render a recency warning when the flag is false", async () => {
    const user = userEvent.setup();
    state.me = makeMe({ isFixer: true });
    const app = makeApplication({ recencyWarning: false });
    state.mission = makeMission({ canManage: true, applications: [app] });
    renderPage();

    await user.click(screen.getByTestId("tab-fixer"));
    await screen.findByTestId(`row-application-${app.id}`);
    expect(screen.queryByTestId(`recency-warning-${app.id}`)).toBeNull();
  });
});

describe("MissionDetail — worldLink visibility", () => {
  it("shows the staff-only world link for a manager", () => {
    state.me = makeMe({ isFixer: true });
    state.mission = makeMission({ canManage: true, worldLink: "https://vrchat.example/world" });
    renderPage();

    // PlayerView (default tab) holds the staff-only world link card.
    expect(screen.getByTestId("link-world")).toBeInTheDocument();
  });

  it("hides the world link from a non-staff player even if a value is present", () => {
    state.me = makeMe();
    state.mission = makeMission({ canManage: false, worldLink: "https://vrchat.example/world" });
    renderPage();

    expect(screen.queryByTestId("link-world")).toBeNull();
  });
});

describe("MissionDetail — apply flow", () => {
  it("lets a player apply with an owned character and a comment", () => {
    state.me = makeMe();
    state.myCharacters = [{ id: 11, name: "V" }];
    state.mission = makeMission({ workflowState: "posted", status: "open", myApplication: null });
    renderPage();

    expect(screen.getByTestId("block-apply")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("select-apply-character"), { target: { value: "11" } });
    fireEvent.change(screen.getByTestId("input-apply-comment"), {
      target: { value: "Solo, ready to run" },
    });
    fireEvent.click(screen.getByTestId("button-apply-submit"));

    expect(state.apply).toHaveBeenCalledTimes(1);
    const [payload] = state.apply.mock.calls[0];
    expect(payload.id).toBe(7);
    expect(payload.data.characterId).toBe(11);
    expect(payload.data.comment).toBe("Solo, ready to run");
  });

  it("keeps Apply disabled until a character is chosen", () => {
    state.me = makeMe();
    state.myCharacters = [{ id: 11, name: "V" }];
    state.mission = makeMission({ workflowState: "posted", status: "open", myApplication: null });
    renderPage();

    fireEvent.click(screen.getByTestId("button-apply-submit"));
    expect(screen.getByTestId("button-apply-submit")).toBeDisabled();
    expect(state.apply).not.toHaveBeenCalled();
  });

  it("prevents a duplicate apply by showing the existing application instead of the form", () => {
    state.me = makeMe();
    state.myCharacters = [{ id: 11, name: "V" }];
    const existing = makeApplication({ status: "pending", characterName: "V" });
    state.mission = makeMission({
      workflowState: "posted",
      status: "open",
      myApplication: existing,
    });
    renderPage();

    expect(screen.getByTestId("block-my-application")).toBeInTheDocument();
    expect(screen.queryByTestId("block-apply")).toBeNull();
    expect(screen.getByTestId("button-withdraw")).toBeInTheDocument();
  });
});

describe("MissionDetail — workflow buttons by role", () => {
  it("shows Approve (not Submit/Post) for an archivist on a proposal", () => {
    state.me = makeMe({ isArchivist: true });
    state.mission = makeMission({
      workflowState: "proposal",
      canManage: false,
      canApprove: true,
    });
    renderPage();

    expect(screen.getByTestId("button-approve")).toBeInTheDocument();
    expect(screen.queryByTestId("button-submit-proposal")).toBeNull();
    expect(screen.queryByTestId("button-post")).toBeNull();
  });

  it("shows Submit for a fixer on a draft under the fixer tab", async () => {
    const user = userEvent.setup();
    state.me = makeMe({ isFixer: true });
    state.mission = makeMission({
      workflowState: "draft",
      canManage: true,
      canApprove: false,
    });
    renderPage();

    await user.click(screen.getByTestId("tab-fixer"));
    expect(await screen.findByTestId("button-submit-proposal")).toBeInTheDocument();
    expect(screen.queryByTestId("button-approve")).toBeNull();
  });
});

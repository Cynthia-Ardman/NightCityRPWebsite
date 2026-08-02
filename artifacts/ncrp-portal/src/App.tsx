import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthMe } from "@/hooks/useAuthMe";
import { useEffect } from "react";
import { hydrateTextScaleFromServer } from "@/lib/textScale";

import { ViewAsProvider } from "@/contexts/ViewAsContext";
import AppLayout from "@/components/layout/AppLayout";
import ErrorBoundary from "@/components/ErrorBoundary";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import CharactersList from "@/pages/CharactersList";
import CharacterDetail from "@/pages/CharacterDetail";
import AdminDashboard from "@/pages/AdminDashboard";
import AdminUserDetail from "@/pages/admin/AdminUserDetail";
import DiceRoller from "@/pages/DiceRoller";
import NewSheet from "@/pages/sheets/NewSheet";
import SheetDetail from "@/pages/sheets/SheetDetail";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";
import PendingEditDetail from "@/pages/pending-edits/PendingEditDetail";
import PendingRequests from "@/pages/requests/PendingRequests";
import MySubmissions from "@/pages/MySubmissions";
import Inbox from "@/pages/Inbox";
import BreachHub from "@/pages/breach/BreachHub";
import BreachPlay from "@/pages/breach/BreachPlay";
import BreachWatch from "@/pages/breach/BreachWatch";
import BreachPractice from "@/pages/breach/BreachPractice";
import MyBreaches from "@/pages/breach/MyBreaches";
import Ledger from "@/pages/Ledger";
import { Redirect } from "wouter";
import DirectoryStores from "@/pages/directory/DirectoryStores";
import DirectoryStoreDetail from "@/pages/directory/DirectoryStoreDetail";
import DirectoryRipperdocs from "@/pages/directory/DirectoryRipperdocs";
import DirectoryRipperdocDetail from "@/pages/directory/DirectoryRipperdocDetail";
import DirectoryCharacters from "@/pages/directory/DirectoryCharacters";
import DirectoryCharacterDetail from "@/pages/directory/DirectoryCharacterDetail";
import DirectoryLore from "@/pages/directory/DirectoryLore";
import DirectoryLoreSection from "@/pages/directory/DirectoryLoreSection";
import DirectoryLoreDetail from "@/pages/directory/DirectoryLoreDetail";
import MyLoreSubmissions from "@/pages/directory/MyLoreSubmissions";
import LoreEditor from "@/pages/directory/LoreEditor";
import LoreImportReview from "@/pages/directory/LoreImportReview";
import DirectoryGuidebook from "@/pages/guidebook/DirectoryGuidebook";
import GuidebookPageDetail from "@/pages/guidebook/GuidebookPageDetail";
import MyGuidebookSubmissions from "@/pages/guidebook/MyGuidebookSubmissions";
import GuidebookEditor from "@/pages/guidebook/GuidebookEditor";
import GuidebookImportReview from "@/pages/guidebook/GuidebookImportReview";
import GuidebookWeapons from "@/pages/guidebook/GuidebookWeapons";
import RulesHub from "@/pages/guidebook/RulesHub";
import CatalogGuns from "@/pages/catalog/CatalogGuns";
import CatalogCyberware from "@/pages/catalog/CatalogCyberware";
import CatalogRent from "@/pages/catalog/CatalogRent";
import MyStores from "@/pages/stores/MyStores";
import MyStoreDetail from "@/pages/stores/MyStoreDetail";
import MyClinics from "@/pages/clinics/MyClinics";
import MyClinicDetail from "@/pages/clinics/MyClinicDetail";
import RipperdocConsole from "@/pages/RipperdocConsole";
import FixerHub from "@/pages/fixer/FixerHub";
import FixerCreateCharacter from "@/pages/fixer/FixerCreateCharacter";
import FixerMissions from "@/pages/fixer/FixerMissions";
import FixerReports from "@/pages/fixer/FixerReports";
import FixerAnalytics from "@/pages/fixer/FixerAnalytics";
import PayActors from "@/pages/fixer/PayActors";
import FixerInventorySearch from "@/pages/fixer/FixerInventorySearch";
import FixerPlayerLookup from "@/pages/fixer/FixerPlayerLookup";
import CyberwareViolations from "@/pages/fixer/CyberwareViolations";
import OffMapProperties from "@/pages/fixer/OffMapProperties";
import TagRoles from "@/pages/fixer/TagRoles";
import CyberPsycho from "@/pages/fixer/CyberPsycho";
import InventoryItemDetail from "@/pages/InventoryItemDetail";
import Missions from "@/pages/Missions";
import MissionDetail from "@/pages/MissionDetail";
import FixerProfile from "@/pages/FixerProfile";
import DirectoryCalendar from "@/pages/directory/DirectoryCalendar";
import EventDetail from "@/pages/EventDetail";
import FixerEvents from "@/pages/fixer/FixerEvents";
import LoginError from "@/pages/LoginError";
import SiteLocked from "@/pages/SiteLocked";
import LogoutError from "@/pages/LogoutError";
import Settings from "@/pages/Settings";
import NcpdPage from "@/pages/NcpdPage";
import NcpdCharacterRecord from "@/pages/NcpdCharacterRecord";
import LawsPage from "@/pages/LawsPage";
import VerificationRequired from "@/pages/VerificationRequired";
import RulesGate from "@/pages/RulesGate";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

// The Character Archive is a fixer/admin management surface. The nav link is
// already staff-gated, but a non-staff player could still reach it by typing
// the URL — so guard the routes themselves and bounce them home.
function StaffArchiveGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin)) return <Redirect to="/" />;
  return <>{children}</>;
}

// The Player Dossier is a fixer/admin lookup surface that aggregates a
// player's full activity history. The endpoints are staff-gated server-side,
// but a non-staff player could still load the page shell by typing the URL —
// so guard the route itself and bounce them home.
function FixerGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin)) return <Redirect to="/" />;
  return <>{children}</>;
}

// Analytics admits fixers (incl. coordinators) and admins like FixerGuard, plus
// archivists — the FIXER activity tab inside the page is for leadership
// (admin / coordinator / archivist) and the page self-gates per tab.
function AnalyticsGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin || user.isArchivist)) return <Redirect to="/" />;
  return <>{children}</>;
}

// CyberPsycho admits staff plus anyone holding the per-user admin grant
// (surfaced as `canCyberpsycho` on /auth/me).
function CyberpsychoGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin || user.canCyberpsycho)) return <Redirect to="/" />;
  return <>{children}</>;
}

// Like FixerGuard but also admits trial fixers, who are author-only: they reach
// the Fixer hub and the mission log (to create/shepherd their own proposals) but
// the API still gates the staff management tools (reports, pay actors, ...). Use
// this for the author-capable fixer surfaces so plain players can't load the
// shell while trial fixers keep their mission-authoring access.
function FixerOrTrialGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin || user.isTrialFixer)) return <Redirect to="/" />;
  return <>{children}</>;
}

// The lore import pipeline is admin-only on the backend (drafts review +
// publish). Fixers can propose entries but cannot run/clear the import queue,
// so guard the route to admins and bounce everyone else home.
function AdminGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !user.isAdmin) return <Redirect to="/" />;
  return <>{children}</>;
}

// The unified staff Review Queue page is staff-only. Each tab self-gates by
// role inside the page, but a plain player typing the URL should never see
// the queue — bounce them home.
function StaffRequestsGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  // Archivists approve mission proposals from the Misc tab, so they must reach
  // the unified queue even though they don't vote on custom requests/sheets.
  if (!user || !(user.isFixer || user.isCsApprover || user.isAdmin || user.isArchivist)) return <Redirect to="/" />;
  return <>{children}</>;
}

// Breach Control is the Fixer/Admin surface for generating and sending Breach
// Protocol puzzles. The create/list endpoints are staff-gated server-side, but
// guard the route too so a plain player typing the URL bounces home.
function StaffBreachGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isAdmin)) return <Redirect to="/" />;
  return <>{children}</>;
}

function AppRoutes() {
  const { data: user, isLoading } = useAuthMe();

  // Account-level text-size preference. localStorage applies pre-paint (inline
  // script in index.html), then the server value hydrates/overrides here once
  // the login state arrives — so the choice follows the account across devices.
  useEffect(() => {
    if (user) hydrateTextScaleFromServer(user.textScale);
  }, [user]);

  if (isLoading) {
    return (
      <div className="min-h-screen w-full flex items-center justify-center bg-background text-nc-cyan">
        <div className="text-center font-display">
          <div className="text-4xl animate-pulse glitch-hover">INITIALIZING...</div>
          <div className="text-sm text-muted-foreground mt-4 font-sans">Connecting to Night City subnet...</div>
        </div>
      </div>
    );
  }

  // Age-verification gate. A signed-in member who lacks the Verified 18+ Discord
  // role is locked to a single screen (the VRChat↔Discord linking guidebook page
  // + a link to the help channel) — no AppLayout, no sidebar, no other routes.
  // The backend mirrors this gate, so even direct API calls are blocked. Logged-
  // out visitors (no user) fall through to the normal shell, where Home handles
  // the login prompt.
  if (user && !user.verified18) {
    return <VerificationRequired />;
  }

  // Staff-only lockdown. When an admin has restricted login, a signed-in member
  // who is NOT staff (ADMIN / FIXER incl. coordinator / ARCHIVIST) is locked to
  // a single maintenance screen — no AppLayout, no routes. The backend mirrors
  // this (login blocked + every data route 403s), so this is purely the UX. A
  // logged-out visitor (no user) falls through; their login attempt is blocked
  // server-side and redirects to the "restricted" login-error page.
  if (user && user.loginRestricted && !(user.isAdmin || user.isFixer || user.isArchivist || user.isTrialFixer)) {
    return <SiteLocked />;
  }

  // First-run rules gate. A signed-in member who has not yet accepted the server
  // rules is locked to a single blocking splash that renders the rules inline and
  // an "I've read the rules" button (which persists the acknowledgement and grants
  // the rules Discord role). The backend sets rulesAccepted, so this only appears
  // until the member accepts. Logged-out visitors fall through to the normal shell.
  if (user && !user.rulesAccepted) {
    return <RulesGate />;
  }

  return (
    <>
      <AppLayout>
        <ErrorBoundary>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/login/error" component={LoginError} />
          <Route path="/logout/error" component={LogoutError} />
          <Route path="/characters" component={CharactersList} />
          <Route path="/characters/:id" component={CharacterDetail} />
          <Route path="/sheets"><Redirect to="/characters" /></Route>
          <Route path="/sheets/new" component={NewSheet} />
          {/* Retired: character-sheet review now lives in the unified /requests
              queue ("New Characters" tab). Redirect old links/bookmarks there. */}
          <Route path="/sheets/pending"><Redirect to="/requests?tab=sheets" /></Route>
          <Route path="/sheets/:id/edit" component={NewSheet} />
          <Route path="/sheets/:id" component={SheetDetail} />
          <Route path="/pending-edits">
            <StaffRequestsGuard><PendingEditsList /></StaffRequestsGuard>
          </Route>
          <Route path="/pending-edits/:id" component={PendingEditDetail} />
          <Route path="/submissions" component={MySubmissions} />
          <Route path="/inbox" component={Inbox} />
          {/* Old bookmarks / DM deep links redirect to the renamed pages. */}
          <Route path="/requests/mine"><Redirect to="/submissions" /></Route>
          <Route path="/offers/mine"><Redirect to="/inbox" /></Route>
          {/* Retired page: event tickets are now the EVENT TICKETS tab of the Inbox. */}
          <Route path="/tickets/mine"><Redirect to="/inbox?tab=tickets" /></Route>
          <Route path="/breach/mine" component={MyBreaches} />
          <Route path="/breach/practice" component={BreachPractice} />
          <Route path="/breach/play/:id" component={BreachPlay} />
          <Route path="/breach/watch/:id">
            {(params) => <StaffBreachGuard><BreachWatch key={params.id} /></StaffBreachGuard>}
          </Route>
          <Route path="/breach">
            <StaffBreachGuard><BreachHub /></StaffBreachGuard>
          </Route>
          <Route path="/requests">
            <StaffRequestsGuard><PendingRequests /></StaffRequestsGuard>
          </Route>
          <Route path="/ledger" component={Ledger} />
          <Route path="/directory/stores" component={DirectoryStores} />
          <Route path="/directory/stores/:id" component={DirectoryStoreDetail} />
          <Route path="/directory/ripperdocs" component={DirectoryRipperdocs} />
          <Route path="/directory/ripperdocs/:id" component={DirectoryRipperdocDetail} />
          <Route path="/directory/characters">
            <StaffArchiveGuard><DirectoryCharacters /></StaffArchiveGuard>
          </Route>
          <Route path="/directory/map">
            <Redirect to="/directory/lore" />
          </Route>
          <Route path="/directory/lore" component={DirectoryLore} />
          <Route path="/directory/lore/section/:category" component={DirectoryLoreSection} />
          <Route path="/directory/lore/mine">
            <StaffArchiveGuard><MyLoreSubmissions /></StaffArchiveGuard>
          </Route>
          <Route path="/directory/lore/new">
            <StaffArchiveGuard><LoreEditor /></StaffArchiveGuard>
          </Route>
          <Route path="/directory/lore/import">
            <AdminGuard><LoreImportReview /></AdminGuard>
          </Route>
          <Route path="/directory/lore/:id/edit">
            <StaffArchiveGuard><LoreEditor /></StaffArchiveGuard>
          </Route>
          <Route path="/directory/lore/:id" component={DirectoryLoreDetail} />
          <Route path="/guidebook" component={DirectoryGuidebook} />
          <Route path="/guidebook/mine">
            <StaffArchiveGuard><MyGuidebookSubmissions /></StaffArchiveGuard>
          </Route>
          <Route path="/guidebook/new">
            <StaffArchiveGuard><GuidebookEditor /></StaffArchiveGuard>
          </Route>
          <Route path="/guidebook/import">
            <AdminGuard><GuidebookImportReview /></AdminGuard>
          </Route>
          <Route path="/guidebook/weapons" component={GuidebookWeapons} />
          <Route path="/guidebook/rules" component={RulesHub} />
          <Route path="/guidebook/:id/edit">
            <StaffArchiveGuard><GuidebookEditor /></StaffArchiveGuard>
          </Route>
          <Route path="/guidebook/:id" component={GuidebookPageDetail} />
          <Route path="/directory/characters/:id">
            <StaffArchiveGuard><DirectoryCharacterDetail /></StaffArchiveGuard>
          </Route>
          <Route path="/catalog/guns" component={CatalogGuns} />
          <Route path="/catalog/cyberware" component={CatalogCyberware} />
          <Route path="/catalog/rent" component={CatalogRent} />
          <Route path="/stores" component={MyStores} />
          <Route path="/stores/:id" component={MyStoreDetail} />
          <Route path="/clinics" component={MyClinics} />
          <Route path="/clinics/:id" component={MyClinicDetail} />
          <Route path="/ripperdoc" component={RipperdocConsole} />
          <Route path="/fixer">
            <FixerOrTrialGuard><FixerHub /></FixerOrTrialGuard>
          </Route>
          <Route path="/fixer/characters/new">
            <FixerGuard><FixerCreateCharacter /></FixerGuard>
          </Route>
          <Route path="/fixer/missions">
            <FixerOrTrialGuard><FixerMissions /></FixerOrTrialGuard>
          </Route>
          <Route path="/fixer/analytics">
            <AnalyticsGuard><FixerAnalytics /></AnalyticsGuard>
          </Route>
          <Route path="/fixer/reports">
            <FixerGuard><FixerReports /></FixerGuard>
          </Route>
          <Route path="/fixer/pay-actors">
            <FixerGuard><PayActors /></FixerGuard>
          </Route>
          <Route path="/fixer/items">
            <FixerGuard><FixerInventorySearch /></FixerGuard>
          </Route>
          <Route path="/fixer/players">
            <FixerGuard><FixerPlayerLookup /></FixerGuard>
          </Route>
          <Route path="/fixer/cyberware-violations">
            <FixerGuard><CyberwareViolations /></FixerGuard>
          </Route>
          <Route path="/fixer/off-map-properties">
            <FixerGuard><OffMapProperties /></FixerGuard>
          </Route>
          <Route path="/fixer/tag-roles">
            <FixerGuard><TagRoles /></FixerGuard>
          </Route>
          <Route path="/fixer/cyberpsycho">
            <CyberpsychoGuard><CyberPsycho /></CyberpsychoGuard>
          </Route>
          <Route path="/ncpd" component={NcpdPage} />
          <Route path="/ncpd/characters/:id" component={NcpdCharacterRecord} />
          <Route path="/laws" component={LawsPage} />
          <Route path="/items/:uuid" component={InventoryItemDetail} />
          <Route path="/settings" component={Settings} />
          <Route path="/dice" component={DiceRoller} />
          <Route path="/missions" component={Missions} />
          <Route path="/missions/:id" component={MissionDetail} />
          <Route path="/fixers/:id" component={FixerProfile} />
          <Route path="/directory/calendar" component={DirectoryCalendar} />
          <Route path="/events/:id" component={EventDetail} />
          <Route path="/fixer/events">
            <FixerGuard><FixerEvents /></FixerGuard>
          </Route>
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/users/:userId" component={AdminUserDetail} />
          <Route component={NotFound} />
        </Switch>
        </ErrorBoundary>
      </AppLayout>
      <div className="crt-overlay pointer-events-none fixed inset-0 z-50">
        <div className="scanline" />
      </div>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ViewAsProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRoutes />
          </WouterRouter>
          <Toaster />
        </ViewAsProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

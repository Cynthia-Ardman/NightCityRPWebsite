import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthMe } from "@/hooks/useAuthMe";

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
import PendingSheets from "@/pages/sheets/PendingSheets";
import PendingEditsList from "@/pages/pending-edits/PendingEditsList";
import PendingEditDetail from "@/pages/pending-edits/PendingEditDetail";
import PendingRequests from "@/pages/requests/PendingRequests";
import MyRequests from "@/pages/MyRequests";
import MyOffers from "@/pages/MyOffers";
import BreachHub from "@/pages/breach/BreachHub";
import BreachPlay from "@/pages/breach/BreachPlay";
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
import DirectoryLoreDetail from "@/pages/directory/DirectoryLoreDetail";
import MyLoreSubmissions from "@/pages/directory/MyLoreSubmissions";
import LoreEditor from "@/pages/directory/LoreEditor";
import LoreImportReview from "@/pages/directory/LoreImportReview";
import DirectoryGuidebook from "@/pages/guidebook/DirectoryGuidebook";
import GuidebookPageDetail from "@/pages/guidebook/GuidebookPageDetail";
import MyGuidebookSubmissions from "@/pages/guidebook/MyGuidebookSubmissions";
import GuidebookEditor from "@/pages/guidebook/GuidebookEditor";
import GuidebookImportReview from "@/pages/guidebook/GuidebookImportReview";
import CatalogGuns from "@/pages/catalog/CatalogGuns";
import CatalogCyberware from "@/pages/catalog/CatalogCyberware";
import CatalogRent from "@/pages/catalog/CatalogRent";
import MyStores from "@/pages/stores/MyStores";
import MyStoreDetail from "@/pages/stores/MyStoreDetail";
import MyClinics from "@/pages/clinics/MyClinics";
import MyClinicDetail from "@/pages/clinics/MyClinicDetail";
import RipperdocConsole from "@/pages/RipperdocConsole";
import FixerHub from "@/pages/fixer/FixerHub";
import FixerMissions from "@/pages/fixer/FixerMissions";
import FixerReports from "@/pages/fixer/FixerReports";
import PayActors from "@/pages/fixer/PayActors";
import FixerInventorySearch from "@/pages/fixer/FixerInventorySearch";
import FixerPlayerLookup from "@/pages/fixer/FixerPlayerLookup";
import InventoryItemDetail from "@/pages/InventoryItemDetail";
import Missions from "@/pages/Missions";
import MissionDetail from "@/pages/MissionDetail";
import DirectoryCalendar from "@/pages/directory/DirectoryCalendar";
import EventDetail from "@/pages/EventDetail";
import FixerEvents from "@/pages/fixer/FixerEvents";
import LoginError from "@/pages/LoginError";
import SiteLocked from "@/pages/SiteLocked";
import LogoutError from "@/pages/LogoutError";
import Settings from "@/pages/Settings";
import VerificationRequired from "@/pages/VerificationRequired";

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

// The lore import pipeline is admin-only on the backend (drafts review +
// publish). Fixers can propose entries but cannot run/clear the import queue,
// so guard the route to admins and bounce everyone else home.
function AdminGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !user.isAdmin) return <Redirect to="/" />;
  return <>{children}</>;
}

// The unified Pending Requests page is staff-only. Each tab self-gates by
// role inside the page, but a plain player typing the URL should never see
// the queue — bounce them home.
function StaffRequestsGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useAuthMe();
  if (isLoading) return null;
  if (!user || !(user.isFixer || user.isCsApprover || user.isAdmin)) return <Redirect to="/" />;
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
  if (user && user.loginRestricted && !(user.isAdmin || user.isFixer || user.isArchivist)) {
    return <SiteLocked />;
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
          <Route path="/sheets/pending" component={PendingSheets} />
          <Route path="/sheets/:id/edit" component={NewSheet} />
          <Route path="/sheets/:id" component={SheetDetail} />
          <Route path="/pending-edits"><PendingEditsList /></Route>
          <Route path="/pending-edits/:id" component={PendingEditDetail} />
          <Route path="/requests/mine" component={MyRequests} />
          <Route path="/offers/mine" component={MyOffers} />
          <Route path="/breach/mine" component={MyBreaches} />
          <Route path="/breach/practice" component={BreachPractice} />
          <Route path="/breach/play/:id" component={BreachPlay} />
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
          <Route path="/directory/lore" component={DirectoryLore} />
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
          <Route path="/fixer" component={FixerHub} />
          <Route path="/fixer/missions" component={FixerMissions} />
          <Route path="/fixer/reports" component={FixerReports} />
          <Route path="/fixer/pay-actors" component={PayActors} />
          <Route path="/fixer/items" component={FixerInventorySearch} />
          <Route path="/fixer/players">
            <FixerGuard><FixerPlayerLookup /></FixerGuard>
          </Route>
          <Route path="/items/:uuid" component={InventoryItemDetail} />
          <Route path="/settings" component={Settings} />
          <Route path="/dice" component={DiceRoller} />
          <Route path="/missions" component={Missions} />
          <Route path="/missions/:id" component={MissionDetail} />
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

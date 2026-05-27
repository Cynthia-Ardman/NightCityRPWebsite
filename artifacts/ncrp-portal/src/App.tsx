import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthMe } from "@/hooks/useAuthMe";

import AppLayout from "@/components/layout/AppLayout";
import NotFound from "@/pages/not-found";
import Home from "@/pages/Home";
import CharactersList from "@/pages/CharactersList";
import CharacterDetail from "@/pages/CharacterDetail";
import AdminDashboard from "@/pages/AdminDashboard";
import AdminUserDetail from "@/pages/admin/AdminUserDetail";
import DiceRoller from "@/pages/DiceRoller";
import SheetsList from "@/pages/sheets/SheetsList";
import NewSheet from "@/pages/sheets/NewSheet";
import SheetDetail from "@/pages/sheets/SheetDetail";
import PendingSheets from "@/pages/sheets/PendingSheets";
import DirectoryStores from "@/pages/directory/DirectoryStores";
import DirectoryStoreDetail from "@/pages/directory/DirectoryStoreDetail";
import DirectoryRipperdocs from "@/pages/directory/DirectoryRipperdocs";
import DirectoryRipperdocDetail from "@/pages/directory/DirectoryRipperdocDetail";
import DirectoryCharacters from "@/pages/directory/DirectoryCharacters";
import DirectoryCharacterDetail from "@/pages/directory/DirectoryCharacterDetail";
import CatalogGuns from "@/pages/catalog/CatalogGuns";
import CatalogCyberware from "@/pages/catalog/CatalogCyberware";
import CatalogRent from "@/pages/catalog/CatalogRent";
import MyStores from "@/pages/stores/MyStores";
import MyStoreDetail from "@/pages/stores/MyStoreDetail";
import MyClinics from "@/pages/clinics/MyClinics";
import MyClinicDetail from "@/pages/clinics/MyClinicDetail";
import FixerHub from "@/pages/fixer/FixerHub";
import FixerNpcDetail from "@/pages/fixer/FixerNpcDetail";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

function AppRoutes() {
  const { isLoading } = useAuthMe();

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

  return (
    <>
      <AppLayout>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/characters" component={CharactersList} />
          <Route path="/characters/:id" component={CharacterDetail} />
          <Route path="/sheets" component={SheetsList} />
          <Route path="/sheets/new" component={NewSheet} />
          <Route path="/sheets/pending" component={PendingSheets} />
          <Route path="/sheets/:id" component={SheetDetail} />
          <Route path="/directory/stores" component={DirectoryStores} />
          <Route path="/directory/stores/:id" component={DirectoryStoreDetail} />
          <Route path="/directory/ripperdocs" component={DirectoryRipperdocs} />
          <Route path="/directory/ripperdocs/:id" component={DirectoryRipperdocDetail} />
          <Route path="/directory/characters" component={DirectoryCharacters} />
          <Route path="/directory/characters/:id" component={DirectoryCharacterDetail} />
          <Route path="/catalog/guns" component={CatalogGuns} />
          <Route path="/catalog/cyberware" component={CatalogCyberware} />
          <Route path="/catalog/rent" component={CatalogRent} />
          <Route path="/stores" component={MyStores} />
          <Route path="/stores/:id" component={MyStoreDetail} />
          <Route path="/clinics" component={MyClinics} />
          <Route path="/clinics/:id" component={MyClinicDetail} />
          <Route path="/fixer" component={FixerHub} />
          <Route path="/fixer/npcs/:id" component={FixerNpcDetail} />
          <Route path="/dice" component={DiceRoller} />
          <Route path="/admin" component={AdminDashboard} />
          <Route path="/admin/users/:userId" component={AdminUserDetail} />
          <Route component={NotFound} />
        </Switch>
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
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;

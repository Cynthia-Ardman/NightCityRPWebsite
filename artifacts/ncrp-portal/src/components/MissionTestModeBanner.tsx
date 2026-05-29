import { useGetMissionConfig, getGetMissionConfigQueryKey } from "@workspace/api-client-react";
import { AlertTriangle } from "lucide-react";

/**
 * Persistent "TEST MODE" cue shown across all mission surfaces (list, detail,
 * fixer management) whenever the master Test/Live toggle is OFF. Renders nothing
 * in live mode. Optionally accepts an explicit `live` value (e.g. from a mission
 * detail payload) to avoid an extra config fetch.
 */
export function MissionTestModeBanner({ live }: { live?: boolean }) {
  const { data: config } = useGetMissionConfig({
    query: { enabled: live === undefined, queryKey: getGetMissionConfigQueryKey() },
  });
  const isLive = live === undefined ? config?.live : live;
  if (isLive !== false) return null;

  return (
    <div
      className="border border-nc-yellow bg-nc-yellow/10 text-nc-yellow font-mono text-sm p-3 flex items-center gap-2"
      data-testid="banner-test-mode"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" />
      <span>
        <strong className="font-display tracking-widest">TEST MODE</strong> — payments and Discord events are
        simulated and recorded, but no real eddies move and no live Discord event is created. Flip the master
        toggle in Admin to go live.
      </span>
    </div>
  );
}

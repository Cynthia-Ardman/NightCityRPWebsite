import { useQuery } from "@tanstack/react-query";
import { useAuthMe } from "@/hooks/useAuthMe";

// Keys must match the API's NotificationRoleKey values (see discord.ts).
export type NotificationRoleKey = "npc" | "social_rp" | "main_session";

export interface NotificationRolesStatus {
  // false when the Discord lookup failed and we genuinely can't tell the
  // current state — mirrors the NPC role's `determined` flag.
  determined: boolean;
  roles: Record<NotificationRoleKey, boolean>;
}

// Shared query key so the Settings toggles and the dashboard NPC CTA stay in
// sync — a change in one place invalidates the other.
export const NOTIFICATION_ROLES_KEY = ["notification-roles"] as const;

// Display metadata for the three self-service notification roles, in order.
export const NOTIFICATION_ROLE_META: {
  key: NotificationRoleKey;
  label: string;
  description: string;
}[] = [
  {
    key: "npc",
    label: "NPC",
    description: "Get pinged to play background characters at events.",
  },
  {
    key: "social_rp",
    label: "Social RP",
    description: "Get pinged for casual, social roleplay sessions.",
  },
  {
    key: "main_session",
    label: "Main Session",
    description: "Get pinged for the headline weekly main sessions.",
  },
];

export function useNotificationRoles() {
  const { data: me } = useAuthMe();
  return useQuery<NotificationRolesStatus>({
    queryKey: NOTIFICATION_ROLES_KEY,
    queryFn: async () => {
      const r = await fetch("/api/auth/notification-roles", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!me,
    staleTime: 60_000,
  });
}

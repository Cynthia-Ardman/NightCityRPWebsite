import { useGetMe } from "@workspace/api-client-react";

export function useAuthMe() {
  return useGetMe({
    query: {
      retry: false,
      retryOnMount: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  });
}

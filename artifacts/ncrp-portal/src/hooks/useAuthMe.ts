import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";

export function useAuthMe() {
  return useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: false,
      retryOnMount: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  });
}

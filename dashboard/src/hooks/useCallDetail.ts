import { useQuery } from '@tanstack/react-query'
import { fetchCall } from '../lib/api.js'

export function useCallDetail(id: string) {
  return useQuery({
    queryKey: ['call', id],
    queryFn: () => fetchCall(id),
    staleTime: 60_000,
    retry: (failureCount, error: unknown) => {
      const apiError = error as { status?: number }
      if (apiError?.status === 404) return false
      return failureCount < 2
    },
  })
}

import { useQuery } from '@tanstack/react-query'
import { fetchCalls } from '../lib/api.js'
import type { CallsFilters } from '../lib/types.js'

export function useCallsList(filters: CallsFilters) {
  return useQuery({
    queryKey: ['calls', filters],
    queryFn: () => fetchCalls(filters),
    staleTime: 30_000,
  })
}

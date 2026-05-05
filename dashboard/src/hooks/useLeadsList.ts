import { useQuery } from '@tanstack/react-query'
import { fetchLeads } from '../lib/api.js'
import type { LeadsFilters } from '../lib/types.js'

export function useLeadsList(filters: LeadsFilters = {}) {
  return useQuery({
    queryKey: ['leads', filters],
    queryFn: () => fetchLeads(filters),
    staleTime: 30_000,
  })
}

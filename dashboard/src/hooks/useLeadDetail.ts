import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchLeadTimeline, updateLead } from '../lib/api.js'

export function useLeadDetail(id: string) {
  return useQuery({
    queryKey: ['lead-timeline', id],
    queryFn: () => fetchLeadTimeline(id),
    staleTime: 30_000,
    retry: (failureCount, error: unknown) => {
      const apiError = error as { status?: number }
      if (apiError?.status === 404) return false
      return failureCount < 2
    },
  })
}

export function useUpdateLead(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Parameters<typeof updateLead>[1]) => updateLead(id, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead-timeline', id] })
      qc.invalidateQueries({ queryKey: ['leads'] })
    },
  })
}

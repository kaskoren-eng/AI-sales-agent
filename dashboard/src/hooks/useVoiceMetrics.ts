import { useQuery } from '@tanstack/react-query'
import { fetchVoiceMetrics, type VoiceMetrics } from '../lib/api.js'

/** Voice-agent supervision figures for the selected range. */
export function useVoiceMetrics(range: 'today' | 'd7' | 'd30') {
  return useQuery<VoiceMetrics>({
    queryKey: ['voice-metrics', range],
    queryFn: () => fetchVoiceMetrics(range),
    staleTime: 60_000,
  })
}

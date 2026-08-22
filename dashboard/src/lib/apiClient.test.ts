import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch } from './apiClient'

/**
 * WHEN TO DECLARE A JSON CONTENT-TYPE.
 *
 * Fastify's JSON body parser rejects an EMPTY body that announces itself as application/json
 * (FST_ERR_CTP_EMPTY_JSON_BODY) before the request is routed at all. So a header set
 * unconditionally on every request broke every body-less mutation in the dashboard at once:
 * disconnecting Google Calendar, Airtable and Monday, removing a team member, regenerating the
 * API key.
 *
 * What made it survive was the shape of the failure. None of those buttons had an error state, so
 * a rejected request produced no toast, no message and no change on screen — the button looked
 * inert rather than broken, and the natural response was to press it again. Four identical DELETEs
 * in the production logs, seconds apart, are exactly that.
 *
 * These tests pin the rule in both directions, because either mistake is silent: omit the header
 * where a body exists and the server cannot parse it; send it where no body exists and the server
 * refuses before it looks.
 */

const originalFetch = globalThis.fetch

function captureFetch(status = 200, body: unknown = { ok: true }) {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  globalThis.fetch = spy as unknown as typeof fetch
  return spy
}

/** The headers actually sent, whatever init shape fetch was handed. */
function headersOf(spy: ReturnType<typeof captureFetch>) {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined
  return new Headers(init?.headers as HeadersInit)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('apiFetch content-type', () => {
  it('omits the JSON content-type when there is no body', async () => {
    // The bug, in one assertion. Every disconnect button in the product depended on this.
    const spy = captureFetch()

    await apiFetch('/integrations/google-calendar', { method: 'DELETE' })

    expect(headersOf(spy).has('content-type')).toBe(false)
  })

  it('omits it on a body-less POST too, not only on DELETE', async () => {
    // Regenerating the API key is a POST with nothing to send, and failed the same way.
    const spy = captureFetch()

    await apiFetch('/tenants/me/api-key', { method: 'POST' })

    expect(headersOf(spy).has('content-type')).toBe(false)
  })

  it('sends the JSON content-type when there IS a body', async () => {
    // The other half of the rule: without this header the server cannot parse the body at all.
    const spy = captureFetch()

    await apiFetch('/leads/abc', { method: 'PATCH', body: JSON.stringify({ status: 'won' }) })

    expect(headersOf(spy).get('content-type')).toBe('application/json')
  })

  it('lets an explicit content-type win, for callers that are not sending JSON', async () => {
    const spy = captureFetch()

    await apiFetch('/import', {
      method: 'POST',
      body: 'a,b,c',
      headers: { 'Content-Type': 'text/csv' },
    })

    expect(headersOf(spy).get('content-type')).toBe('text/csv')
  })

  it('still raises the error a failed mutation returns, so a caller can show it', async () => {
    // The header was only half the story: these requests DID fail loudly at the network layer and
    // the UI showed nothing. apiFetch must keep throwing, so the button has something to render.
    captureFetch(500, { message: 'Body cannot be empty' })

    await expect(apiFetch('/integrations/google-calendar', { method: 'DELETE' })).rejects.toThrow(
      /Body cannot be empty/,
    )
  })
})

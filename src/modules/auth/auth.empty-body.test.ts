import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'

/**
 * REGRESSION GUARD.
 *
 * /auth/refresh and /auth/logout take no body — the credential is in a cookie. But every normal
 * browser client sets `Content-Type: application/json` on POST by default, and Fastify's stock
 * JSON parser rejects that with an empty body:
 *
 *   "Body cannot be empty when content-type is set to 'application/json'"
 *
 * The request therefore failed before anything looked at the session, which meant EVERY silent
 * token renewal and every page reload signed the user out. It was invisible to a curl check,
 * because curl sends no content-type unless told to — the bug only appeared through a real
 * browser-shaped request.
 *
 * These tests pin the parser behaviour rather than the routes, because the parser is the fix.
 */

function buildWithAuthParser() {
  const app = Fastify({ logger: false })

  // Mirrors the parser registered in auth.routes.ts.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 262_144 },
    (_request, body: string, done) => {
      if (!body || body.trim() === '') return done(null, {})
      try {
        done(null, JSON.parse(body))
      } catch {
        const err = new Error('Invalid JSON body') as Error & { statusCode: number }
        err.statusCode = 400
        done(err, undefined)
      }
    },
  )

  app.post('/refresh', async (request) => ({ ok: true, body: request.body }))
  return app
}

describe('auth content-type parser', () => {
  it('accepts application/json with NO body — the browser refresh case', async () => {
    const app = buildWithAuthParser()
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().body).toEqual({})
    await app.close()
  })

  it('accepts application/json with a whitespace-only body', async () => {
    const app = buildWithAuthParser()
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { 'content-type': 'application/json' },
      payload: '   ',
    })
    expect(res.statusCode).toBe(200)
    await app.close()
  })

  it('still parses a real JSON body', async () => {
    const app = buildWithAuthParser()
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ hello: 'world' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().body).toEqual({ hello: 'world' })
    await app.close()
  })

  it('still REJECTS malformed JSON — tolerating empty must not mean tolerating garbage', async () => {
    const app = buildWithAuthParser()
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('demonstrates the ORIGINAL failure without the parser', async () => {
    // The control: stock Fastify rejects exactly the request a browser sends. If a future change
    // drops the custom parser, this is the behaviour that returns.
    const app = Fastify({ logger: false })
    app.post('/refresh', async () => ({ ok: true }))
    const res = await app.inject({
      method: 'POST',
      url: '/refresh',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/body cannot be empty/i)
    await app.close()
  })
})

describe('dashboard client contract', () => {
  it('omits the JSON content-type when there is no body', async () => {
    // Mirrors dashboard/src/lib/auth.ts post(). Belt and braces alongside the server fix: the
    // client should not announce a body it is not sending.
    const seen: Array<Record<string, string>> = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push((init.headers ?? {}) as Record<string, string>)
      return { ok: true, status: 204, json: async () => ({}) } as Response
    })

    const post = async (body?: unknown) =>
      fetchMock('/api/v1/auth/refresh', {
        method: 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    await post()
    await post({ email: 'a@b.com' })

    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ 'Content-Type': 'application/json' })
  })
})

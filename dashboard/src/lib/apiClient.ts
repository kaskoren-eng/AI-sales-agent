import { getAccessToken, refreshSession, clearSession } from './auth'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function toError(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`
  try {
    const body = await response.json()
    message = body.message || body.error || message
  } catch {
    // ignore parse errors
  }
  return new ApiError(response.status, message)
}

/**
 * Only declare a JSON content-type when there IS a body.
 *
 * Fastify's JSON parser rejects an EMPTY body that announces itself as application/json —
 * FST_ERR_CTP_EMPTY_JSON_BODY — before the request is ever routed. So every body-less mutation
 * sent through here failed at the parser: disconnecting Google Calendar, Airtable or Monday,
 * removing a team member, regenerating the API key. Each one returned an error the UI had no
 * state for, so the button simply did nothing, six times over, for one header.
 *
 * `lib/auth.ts` already carries this exact lesson for /refresh and /logout. It was fixed there and
 * not here, which is why the version that survived was the one nobody had clicked yet.
 */
function send(path: string, options?: RequestInit): Promise<Response> {
  const token = getAccessToken()
  return fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  })
}

/**
 * Access tokens last 15 minutes, so a long-lived dashboard tab WILL hit expiry mid-session.
 * Rather than bouncing the user to the login screen, a 401 triggers one refresh — shared across
 * concurrent callers, see auth.ts — and one retry. Only if that refresh also fails is the session
 * genuinely over.
 *
 * Exactly one retry, deliberately: if the retry 401s too then the token is not the problem, and
 * looping would turn an authorisation bug into a request storm against our own API.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  let response = await send(path, options)

  if (response.status === 401) {
    const refreshed = await refreshSession()
    if (!refreshed) {
      clearSession()
      throw await toError(response)
    }
    response = await send(path, options)
  }

  if (!response.ok) throw await toError(response)

  // 204 No Content is a valid success for DELETE and friends; response.json() would throw on it.
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

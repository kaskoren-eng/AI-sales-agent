/**
 * Client-side session state.
 *
 * THE ACCESS TOKEN LIVES IN A MODULE VARIABLE, NOT localStorage.
 *
 * What it replaces: `localStorage.getItem('auth_token') || import.meta.env.VITE_API_KEY`.
 * Nothing ever wrote `auth_token`, so in practice the production bundle shipped with a tenant's
 * API key compiled into the JavaScript — readable by anyone who opened devtools, and permanent,
 * because API keys do not expire. That single line is why a second customer could not use the
 * dashboard at all.
 *
 * In-memory means an XSS cannot read the token out of storage, and it dies with the tab. The
 * durable half of the session is the refresh cookie, which is httpOnly and therefore invisible to
 * JavaScript by construction. On page load we exchange that cookie for a fresh access token —
 * which is why a reload does not log you out despite nothing being persisted here.
 */

export interface SessionUser {
  id: string
  email: string
  name: string | null
  locale: string
}

export interface SessionTenant {
  id: string
  name: string
  slug: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
}

export interface Session {
  user: SessionUser
  tenant: SessionTenant
}

let accessToken: string | null = null
let session: Session | null = null

type Listener = (session: Session | null) => void
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l(session)
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAccessToken(): string | null {
  return accessToken
}

export function getSession(): Session | null {
  return session
}

export function setSession(token: string, next: Session): void {
  accessToken = token
  session = next
  emit()
}

export function clearSession(): void {
  accessToken = null
  session = null
  emit()
}

interface AuthResponse {
  accessToken: string
  expiresIn: number
  user: SessionUser
  tenant: SessionTenant
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1/auth${path}`, {
    method: 'POST',
    // Only declare a JSON content-type when there IS a JSON body. /refresh and /logout carry
    // their credential in the cookie and send nothing; announcing application/json with an empty
    // body makes a strict server reject the request before it ever looks at the session.
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    // Required for the refresh cookie to be sent and set at all.
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const parsed = await res.json()
      message = parsed.message || parsed.error || message
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

function adopt(res: AuthResponse): Session {
  const next = { user: res.user, tenant: res.tenant }
  setSession(res.accessToken, next)
  return next
}

export async function login(email: string, password: string): Promise<Session> {
  return adopt(await post<AuthResponse>('/login', { email, password }))
}

export async function registerAccount(input: {
  email: string
  password: string
  name?: string
  tenantName: string
}): Promise<Session> {
  return adopt(await post<AuthResponse>('/register', input))
}

export async function switchTenant(tenantId: string): Promise<Session> {
  const res = await fetch('/api/v1/auth/switch-tenant', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ tenantId }),
  })
  if (!res.ok) throw new Error('Could not switch workspace')
  return adopt((await res.json()) as AuthResponse)
}

export async function logout(): Promise<void> {
  try {
    await post('/logout')
  } finally {
    // Clear locally even if the request failed — the user asked to be logged out, and leaving
    // them apparently signed in because the network hiccuped is the wrong failure mode.
    clearSession()
  }
}

export async function forgotPassword(email: string): Promise<void> {
  await post('/forgot-password', { email })
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await post('/reset-password', { token, password })
}

export async function acceptInvite(input: {
  token: string
  password?: string
  name?: string
}): Promise<void> {
  await post('/accept-invite', input)
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Concurrency matters here: a page that fires six queries at once will get six simultaneous 401s,
 * and six parallel refreshes would rotate the token six times — the second through sixth would
 * each look like REUSE of an already-rotated token and the server would revoke the whole chain,
 * logging the user out for the crime of loading a dashboard. So all callers share one in-flight
 * promise.
 */
let inFlight: Promise<Session | null> | null = null

export function refreshSession(): Promise<Session | null> {
  if (inFlight) return inFlight
  inFlight = post<AuthResponse>('/refresh')
    .then((res) => adopt(res))
    .catch(() => {
      clearSession()
      return null
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Called once at startup: turns a surviving refresh cookie back into a live session. */
export async function restoreSession(): Promise<Session | null> {
  return refreshSession()
}

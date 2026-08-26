import { lazy, Suspense, type ComponentType } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout.js'
import { AuthGate } from './components/AuthGate.js'
import { RouteFallback } from './components/RouteFallback.js'
import { Overview } from './pages/Overview.js'
import { VoiceOps } from './pages/VoiceOps.js'
import { Leads } from './pages/Leads.js'
import { LeadDetail } from './pages/LeadDetail.js'
import { Calls } from './pages/Calls.js'
import { CallDetail } from './pages/CallDetail.js'
import { Bookings } from './pages/Bookings.js'
import { Integrations } from './pages/Integrations.js'
import { Settings } from './pages/Settings.js'
import { Members } from './pages/Members.js'
import { AgentPersonality } from './pages/AgentPersonality.js'
import { Copilot } from './pages/Copilot.js'

/**
 * ── WHAT IS LAZY, AND WHY ──────────────────────────────────────────────────────────────────────
 *
 * The whole dashboard used to ship as one 1.49 MB chunk, downloaded before the LOGIN SCREEN could
 * render. Most of that weight is code that most sessions never execute:
 *
 *   • `livekit-client` — the WebRTC stack, pulled in by Simulator and VoiceChat. It is the single
 *     largest dependency here and it is needed only when someone actually places a browser call.
 *   • the ADMIN console — a separate shell behind a super-admin key. Every tenant user downloads
 *     it today and not one of them can open it.
 *   • `recharts` — the Overview charts. Overview is the landing page, so this one is NOT split:
 *     deferring it would trade bundle size for a visible chart pop-in on the first screen anyone
 *     sees, which is the wrong trade.
 *
 * Split by WHO USES IT, not by what is biggest. A route that everyone hits on arrival belongs in
 * the main chunk even when it is heavy; a route that a few people hit occasionally does not,
 * however small.
 */

// The WebRTC stack. Loaded when a call actually starts, not when the dashboard opens.
const VoiceChat = lazyPage(() => import('./pages/VoiceChat.js').then((m) => ({ default: m.VoiceChat })))
const Simulator = lazyPage(() => import('./pages/Simulator.js').then((m) => ({ default: m.Simulator })))

// Operator console: its own shell, its own auth, and no tenant user can reach it.
const AdminLayout = lazyPage(() => import('./pages/admin/AdminLayout.js').then((m) => ({ default: m.AdminLayout })))
const AdminOverview = lazyPage(() => import('./pages/admin/AdminOverview.js').then((m) => ({ default: m.AdminOverview })))
const AdminTenants = lazyPage(() => import('./pages/admin/AdminTenants.js').then((m) => ({ default: m.AdminTenants })))

// Dev-only primitives inventory. Lazy + DEV-guarded so it never enters the prod bundle.
const Styleguide = import.meta.env.DEV ? lazyPage(() => import('./pages/Styleguide.js').then((m) => ({ default: m.Styleguide }))) : null

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  return lazy(loader)
}

/**
 * A lazy route, wrapped.
 *
 * The fallback is a real skeleton rather than `null`. A blank frame during a chunk fetch reads as
 * a broken click — the user presses the nav item again, and on a slow connection they keep pressing
 * it. Showing that something is happening is the whole reason splitting is safe to do at all.
 */
function Lazy({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Operator console — its own shell + super-admin auth, outside the tenant dashboard. */}
        <Route path="/admin" element={<Lazy><AdminLayout /></Lazy>}>
          <Route index element={<Lazy><AdminOverview /></Lazy>} />
          <Route path="tenants" element={<Lazy><AdminTenants /></Lazy>} />
        </Route>
        {/* Tenant dashboard — everything behind it requires a signed-in user. */}
        <Route path="/*" element={<AuthGate><TenantShell /></AuthGate>} />
      </Routes>
    </BrowserRouter>
  )
}

function TenantShell() {
  return (
    <AppLayout>
      <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/voice-ops" element={<VoiceOps />} />
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/voice" element={<Lazy><VoiceChat /></Lazy>} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/members" element={<Members />} />
          {/* Phase 3 targets — interim placeholders until each page is migrated to its v5 preview. */}
          <Route path="/chat" element={<Copilot />} />
          <Route path="/agent" element={<AgentPersonality />} />
          <Route path="/simulator" element={<Lazy><Simulator /></Lazy>} />
          {Styleguide && (
            <Route
              path="/styleguide"
              element={
                <Lazy>
                  <Styleguide />
                </Lazy>
              }
            />
          )}
        </Routes>
    </AppLayout>
  )
}

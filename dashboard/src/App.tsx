import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout.js'
import { AuthGate } from './components/AuthGate.js'
import { Overview } from './pages/Overview.js'
import { Leads } from './pages/Leads.js'
import { LeadDetail } from './pages/LeadDetail.js'
import { Calls } from './pages/Calls.js'
import { VoiceChat } from './pages/VoiceChat.js'
import { CallDetail } from './pages/CallDetail.js'
import { Bookings } from './pages/Bookings.js'
import { Integrations } from './pages/Integrations.js'
import { Settings } from './pages/Settings.js'
import { AgentPersonality } from './pages/AgentPersonality.js'
import { Copilot } from './pages/Copilot.js'
import { Simulator } from './pages/Simulator.js'
import { AdminLayout } from './pages/admin/AdminLayout.js'
import { AdminOverview } from './pages/admin/AdminOverview.js'
import { AdminTenants } from './pages/admin/AdminTenants.js'

// Dev-only primitives inventory. Lazy + DEV-guarded so it never enters the prod bundle.
const Styleguide = import.meta.env.DEV ? lazy(() => import('./pages/Styleguide.js').then((m) => ({ default: m.Styleguide }))) : null

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Operator console — its own shell + super-admin auth, outside the tenant dashboard. */}
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminOverview />} />
          <Route path="tenants" element={<AdminTenants />} />
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
          <Route path="/leads" element={<Leads />} />
          <Route path="/leads/:id" element={<LeadDetail />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/calls/:id" element={<CallDetail />} />
          <Route path="/voice" element={<VoiceChat />} />
          <Route path="/bookings" element={<Bookings />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          {/* Phase 3 targets — interim placeholders until each page is migrated to its v5 preview. */}
          <Route path="/chat" element={<Copilot />} />
          <Route path="/agent" element={<AgentPersonality />} />
          <Route path="/simulator" element={<Simulator />} />
          {Styleguide && (
            <Route
              path="/styleguide"
              element={
                <Suspense fallback={null}>
                  <Styleguide />
                </Suspense>
              }
            />
          )}
        </Routes>
    </AppLayout>
  )
}

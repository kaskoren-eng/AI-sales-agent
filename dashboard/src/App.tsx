import { lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from './components/layout/AppLayout.js'
import { Overview } from './pages/Overview.js'
import { Leads } from './pages/Leads.js'
import { LeadDetail } from './pages/LeadDetail.js'
import { Calls } from './pages/Calls.js'
import { VoiceChat } from './pages/VoiceChat.js'
import { CallDetail } from './pages/CallDetail.js'
import { Bookings } from './pages/Bookings.js'
import { Integrations } from './pages/Integrations.js'
import { Settings } from './pages/Settings.js'

// Dev-only primitives inventory. Lazy + DEV-guarded so it never enters the prod bundle.
const Styleguide = import.meta.env.DEV ? lazy(() => import('./pages/Styleguide.js').then((m) => ({ default: m.Styleguide }))) : null

export default function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  )
}

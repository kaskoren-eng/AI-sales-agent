import { useState, useEffect, useId } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@radix-ui/react-dialog'
import { Eye, EyeOff, RefreshCw, X, Save, CheckCircle2, Phone, Sun, Moon, Monitor } from 'lucide-react'
import { PrefSelect } from '../components/ui/PrefSelect.js'
import { useTheme } from '../hooks/useTheme.js'
import type { ThemePref } from '../lib/theme.js'
import type { Language } from '../i18n/index.js'
import {
  fetchTenantMe,
  updateTenantMe,
  updateTenantSettings,
  fetchTenantFlows,
  regenerateApiKey,
  fetchBusinessProfile,
  saveBusinessProfile,
  fetchVoiceNumber,
  type BusinessProfile,
} from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'

function maskApiKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length)
  return key.slice(0, 4) + '•'.repeat(Math.max(0, key.length - 8)) + key.slice(-4)
}

// v5 section caption — mono uppercase, auto-neutralized in Hebrew via `.uppercase-track`.
const capStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 600,
  fontSize: '11px',
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
}
function SectionCap({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <h3 className="uppercase-track" style={{ ...capStyle, ...style }}>
      {children}
    </h3>
  )
}

// v5 overlay dialog surface (shared by the two confirm dialogs below).
const dialogContentStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 'min(400px, calc(100vw - 32px))',
  backgroundColor: 'var(--surface-overlay)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-overlay)',
  padding: '24px',
  zIndex: 51,
}

function GeneralTab() {
  const nameId = useId()
  const queryClient = useQueryClient()
  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant-me'],
    queryFn: fetchTenantMe,
    staleTime: 60_000,
  })

  const [displayName, setDisplayName] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (tenant?.name) setDisplayName(tenant.name)
  }, [tenant?.name])

  const mutation = useMutation({
    mutationFn: () => updateTenantMe({ name: displayName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant-me'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '480px' }}>
      <Card>
        <SectionCap style={{ marginBottom: '16px' }}>Account</SectionCap>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label
              htmlFor={nameId}
              style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}
            >
              Display Name
            </label>
            {isLoading ? (
              <Skeleton height="36px" />
            ) : (
              <input
                id={nameId}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your organization name"
                style={{
                  width: '100%',
                  height: '36px',
                  backgroundColor: 'var(--surface-sunken)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  padding: '0 12px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontFamily: 'var(--font-body)',
                  outline: 'none',
                }}
              />
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => mutation.mutate()}
              loading={mutation.isPending}
              disabled={isLoading || !displayName.trim()}
            >
              <Save size={14} strokeWidth={1.5} /> Save Changes
            </Button>
            {saved && (
              <span style={{ fontSize: '12px', color: 'var(--status-success)' }}>Saved</span>
            )}
            {mutation.isError && (
              <span role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>
                Save failed
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

/**
 * Flow editor.
 *
 * This pane was labelled "Flow Configuration" and was in fact editing the ENTIRE tenant settings
 * document: it loaded `tenant.settings` — encrypted Zadarma secret, Monday API token, Airtable key,
 * spend caps, voice engine — into a visible textarea, and PATCHed the whole thing back on save. So
 * opening the page round-tripped every credential the tenant had through the browser, a stray edit
 * could silently wipe an integration, and the JSON never passed the flow schema that the dedicated
 * endpoint enforces.
 *
 * It now reads and writes only the `flows` section, which is what the label always claimed.
 */
function FlowsTab() {
  const queryClient = useQueryClient()
  const { data: flows, isLoading } = useQuery({
    queryKey: ['tenant-flows'],
    queryFn: fetchTenantFlows,
    staleTime: 60_000,
  })

  const [flowJson, setFlowJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (flows != null) setFlowJson(JSON.stringify(flows, null, 2))
  }, [flows])

  const handleChange = (val: string) => {
    setFlowJson(val)
    try {
      const parsed: unknown = JSON.parse(val)
      // The server rejects a non-object anyway; catching it here means the button disables instead
      // of the save failing with a error the user has to read to understand.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('Flows must be a JSON object, keyed by flow name')
        return
      }
      setJsonError(null)
    } catch {
      setJsonError('Invalid JSON')
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(flowJson) as Record<string, unknown>
      return updateTenantSettings('flows', parsed)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant-flows'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '680px' }}>
      <Card>
        <SectionCap style={{ marginBottom: '8px' }}>Flow Configuration</SectionCap>
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '16px', lineHeight: 1.5 }}>
          Define automation flows in JSON. Changes are applied on the next lead qualification cycle.
        </p>
        {isLoading ? (
          <Skeleton height="240px" />
        ) : (
          <textarea
            value={flowJson}
            onChange={(e) => handleChange(e.target.value)}
            aria-label="Flow configuration JSON"
            aria-describedby={jsonError ? 'json-error' : undefined}
            aria-invalid={jsonError != null}
            spellCheck={false}
            style={{
              width: '100%',
              height: '280px',
              backgroundColor: 'var(--surface-sunken)',
              border: `1px solid ${jsonError ? 'var(--status-danger)' : 'var(--border-default)'}`,
              borderRadius: '8px',
              padding: '12px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontFamily: 'var(--font-mono)',
              lineHeight: 1.6,
              outline: 'none',
              resize: 'vertical',
              marginBottom: '8px',
            }}
          />
        )}
        {jsonError && (
          <p id="json-error" role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)', marginBottom: '8px' }}>
            {jsonError}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={isLoading || !!jsonError || !flowJson.trim()}
          >
            <Save size={14} strokeWidth={1.5} /> Save Flow Config
          </Button>
          {saved && <span style={{ fontSize: '12px', color: 'var(--status-success)' }}>Saved</span>}
          {mutation.isError && (
            // Show what the server said. It now validates each flow against the real schema, so
            // the message names the flow and the field — "flows: lead-intake.steps Required" is
            // worth reading, where a bare "Save failed" sends people guessing.
            <span role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>
              {mutation.error instanceof Error ? mutation.error.message : 'Save failed'}
            </span>
          )}
        </div>
      </Card>
    </div>
  )
}

function ApiTab() {
  const [showKey, setShowKey] = useState(false)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)

  const mutation = useMutation({
    mutationFn: regenerateApiKey,
    onSuccess: (data) => {
      setNewKey(data.apiKey)
      setRegenOpen(false)
    },
  })

  const displayKey = newKey ?? '••••••••••••••••••••••••••••••••'
  const maskedKey = maskApiKey(displayKey)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '540px' }}>
      <Card>
        <SectionCap style={{ marginBottom: '16px' }}>API Key</SectionCap>
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '16px', lineHeight: 1.5 }}>
          Use this key to authenticate API requests. Keep it secret — it grants full access to your tenant.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            backgroundColor: 'var(--surface-sunken)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <code
            style={{
              flex: 1,
              fontSize: '13px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              wordBreak: 'break-all',
            }}
            aria-label={showKey ? 'API key (visible)' : 'API key (hidden)'}
          >
            {showKey ? displayKey : maskedKey}
          </code>
          <button
            onClick={() => setShowKey((v) => !v)}
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            {showKey ? <EyeOff size={15} strokeWidth={1.5} /> : <Eye size={15} strokeWidth={1.5} />}
          </button>
        </div>

        {newKey && (
          <div
            role="alert"
            style={{
              padding: '10px 12px',
              backgroundColor: 'color-mix(in srgb, var(--status-success) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--status-success) 28%, transparent)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--status-success)',
              marginBottom: '16px',
              lineHeight: 1.5,
            }}
          >
            New key generated. Copy it now — it will not be shown again.
          </div>
        )}

        <Button
          variant="danger"
          size="sm"
          onClick={() => setRegenOpen(true)}
          aria-label="Regenerate API key"
        >
          <RefreshCw size={14} strokeWidth={1.5} /> Regenerate Key
        </Button>
      </Card>

      {/* Confirmation dialog */}
      <Dialog.Root open={regenOpen} onOpenChange={setRegenOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.6)',
              zIndex: 50,
            }}
          />
          <Dialog.Content style={dialogContentStyle} aria-describedby="regen-key-desc">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <Dialog.Title
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 700,
                  fontSize: '16px',
                  color: 'var(--text-primary)',
                }}
              >
                Regenerate API Key
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label="Close dialog"
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: '2px' }}
                >
                  <X size={16} strokeWidth={1.5} />
                </button>
              </Dialog.Close>
            </div>
            <p
              id="regen-key-desc"
              style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}
            >
              This will immediately invalidate your current API key. Any integrations using the old key will stop working until updated. Are you sure?
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <Dialog.Close asChild>
                <Button variant="secondary" size="sm">Cancel</Button>
              </Dialog.Close>
              <Button
                variant="danger"
                size="sm"
                onClick={() => mutation.mutate()}
                loading={mutation.isPending}
              >
                Yes, regenerate
              </Button>
            </div>
            {mutation.isError && (
              <p role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)', marginTop: '12px' }}>
                Failed to regenerate key. Please try again.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px', fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  backgroundColor: 'var(--surface-sunken)',
  border: '1px solid var(--border-default)',
  borderRadius: '8px',
  padding: '8px 12px',
  color: 'var(--text-primary)',
  fontSize: '14px',
  fontFamily: 'var(--font-body)',
  outline: 'none',
  boxSizing: 'border-box',
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: '80px',
  lineHeight: 1.5,
}

const EMPTY_PROFILE: BusinessProfile = {
  companyName: '',
  description: '',
  product: '',
  targetAudience: '',
  pricing: '',
  commonObjections: '',
  toneOfVoice: '',
  language: 'hebrew',
}

function AgentTab() {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['business-profile'],
    queryFn: fetchBusinessProfile,
    staleTime: 60_000,
  })

  const [form, setForm] = useState<BusinessProfile>(EMPTY_PROFILE)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (data?.businessProfile) setForm(data.businessProfile)
  }, [data?.businessProfile])

  const set = (field: keyof BusinessProfile) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  const mutation = useMutation({
    mutationFn: () => saveBusinessProfile(form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['business-profile'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  if (isLoading) return <Skeleton height="400px" />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}>
      <Card>
        <SectionCap style={{ marginBottom: '4px' }}>Agent Business Profile</SectionCap>
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '20px', lineHeight: 1.5 }}>
          This information is injected into every call so your agent speaks as your brand — not a generic bot.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <FieldGroup label="Company Name">
            <input style={inputStyle} value={form.companyName} onChange={set('companyName')} placeholder="e.g. ClickScales" />
          </FieldGroup>

          <FieldGroup label="What does your business do?">
            <textarea style={textareaStyle} value={form.description} onChange={set('description')} placeholder="We build AI-powered sales agents for Israeli SMBs that qualify leads and book meetings automatically..." />
          </FieldGroup>

          <FieldGroup label="What are you selling?">
            <textarea style={textareaStyle} value={form.product} onChange={set('product')} placeholder="An AI sales agent SaaS platform — monthly subscription starting at ₪499/mo..." />
          </FieldGroup>

          <FieldGroup label="Who is your ideal customer?">
            <textarea style={{ ...textareaStyle, minHeight: '64px' }} value={form.targetAudience} onChange={set('targetAudience')} placeholder="Israeli business owners with 2–20 person sales teams who spend too much time manually following up with leads..." />
          </FieldGroup>

          <FieldGroup label="Pricing (optional)">
            <input style={inputStyle} value={form.pricing} onChange={set('pricing')} placeholder="₪499/mo Starter, ₪1,499/mo Pro, ₪3,999/mo Enterprise" />
          </FieldGroup>

          <FieldGroup label="Common objections & how to handle them (optional)">
            <textarea style={textareaStyle} value={form.commonObjections} onChange={set('commonObjections')} placeholder="'It's too expensive' → Remind them of the cost of a human SDR. 'We're not ready' → Ask what would need to change..." />
          </FieldGroup>

          <FieldGroup label="Tone of voice (optional)">
            <input style={inputStyle} value={form.toneOfVoice} onChange={set('toneOfVoice')} placeholder="Confident but warm. Direct. Not pushy. Speak like a trusted advisor." />
          </FieldGroup>

          <FieldGroup label="Language">
            <select style={{ ...inputStyle, height: '36px', cursor: 'pointer' }} value={form.language} onChange={set('language')}>
              <option value="hebrew">Hebrew (default)</option>
              <option value="english">English</option>
              <option value="both">Both — follow the lead</option>
            </select>
          </FieldGroup>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '20px' }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={!form.companyName.trim() || !form.description.trim() || !form.product.trim()}
          >
            <Save size={14} strokeWidth={1.5} /> Save Profile
          </Button>
          {saved && <span style={{ fontSize: '12px', color: 'var(--status-success)', display: 'flex', alignItems: 'center', gap: '4px' }}><CheckCircle2 size={13} /> Saved</span>}
          {mutation.isError && <span role="alert" style={{ fontSize: '12px', color: 'var(--status-danger)' }}>Save failed — try again</span>}
        </div>
      </Card>
    </div>
  )
}

/**
 * Voice — the tenant's phone number.
 *
 * This pane used to be a Twilio credential form: Account SID, Auth Token, phone number, posting to
 * `/settings/twilio`. Two things were wrong with it. There is no `/settings/twilio` route on the
 * backend — it has `/settings/zadarma` — so every load 404'd and the pane rendered its empty
 * "connect" state forever. And it contradicted how the product actually works: ClickScales
 * provisions and assigns the number during onboarding, so a tenant pasting their own telephony
 * credentials was never part of the model.
 *
 * It now shows the number the tenant actually has, read-only, from the route that exists.
 */
function VoiceTab() {
  const { data: status, isLoading, isError } = useQuery({
    queryKey: ['voice-number'],
    queryFn: fetchVoiceNumber,
    staleTime: 60_000,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '560px' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
          <Phone size={16} strokeWidth={1.5} color="var(--accent-fg)" />
          <SectionCap>Phone Number</SectionCap>
        </div>
        <p style={{ fontSize: '13px', color: 'var(--text-tertiary)', marginBottom: '20px', lineHeight: 1.5 }}>
          Your agent answers and dials on this number. ClickScales provisions it during onboarding —
          tell us if you need it changed or want another one.
        </p>

        {isLoading ? (
          <Skeleton height="92px" />
        ) : isError ? (
          <p role="alert" style={{ fontSize: '13px', color: 'var(--status-danger)' }}>
            Could not load your number. Try again in a moment.
          </p>
        ) : status?.configured ? (
          <div
            style={{
              padding: '14px 16px',
              backgroundColor: 'color-mix(in srgb, var(--status-success) 9%, transparent)',
              border: '1px solid color-mix(in srgb, var(--status-success) 24%, transparent)',
              borderRadius: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <CheckCircle2 size={14} color="var(--status-success)" />
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--status-success)' }}>Active</span>
            </div>
            <span
              dir="ltr"
              style={{ fontFamily: 'var(--font-mono)', fontSize: '18px', color: 'var(--text-primary)', letterSpacing: '0.02em' }}
            >
              {status.phoneNumber ?? '—'}
            </span>
            {status.configuredAt && (
              <span style={{ fontSize: '11.5px', color: 'var(--text-tertiary)' }}>
                Provisioned {new Date(status.configuredAt).toLocaleDateString()}
              </span>
            )}
          </div>
        ) : (
          <div
            style={{
              padding: '14px 16px',
              border: '1px dashed var(--border-default)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--text-secondary)',
              lineHeight: 1.6,
            }}
          >
            No number assigned yet. One is set up as part of onboarding — if your agent is live and
            this is empty, tell us and we will look.
          </div>
        )}
      </Card>
    </div>
  )
}

/** Appearance + interface-language, plus the account display-name (folk Profile pane).
 *  The language + theme pickers live here (Settings › Preferences), not pinned to the shell. */
function AccountPane() {
  const { t, i18n } = useTranslation()
  const { pref, setPref } = useTheme()
  const lang: Language = i18n.language.startsWith('he') ? 'he' : 'en'

  // Languages are labelled in their own script — a picker names options by what they are.
  const langOptions = [
    { value: 'en' as Language, label: 'English' },
    { value: 'he' as Language, label: 'עברית' },
  ]
  const themeOptions = [
    { value: 'light' as ThemePref, label: t('theme.light'), icon: <Sun size={15} strokeWidth={1.7} /> },
    { value: 'dark' as ThemePref, label: t('theme.dark'), icon: <Moon size={15} strokeWidth={1.7} /> },
    { value: 'system' as ThemePref, label: t('theme.system'), icon: <Monitor size={15} strokeWidth={1.7} /> },
  ]

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '18px', padding: '15px 20px', borderBlockEnd: '1px solid var(--border-default)' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '620px' }}>
      <GeneralTab />
      <div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)', marginBlockEnd: '10px' }} className="uppercase-track">
          {t('settings.appearanceTitle')}
        </div>
        <div style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-card)' }}>
          <div style={row}>
            <div style={{ flex: 1, minInlineSize: 0 }}>
              <div style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('settings.language')}</div>
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBlockStart: '3px' }}>{t('settings.languageDesc')}</div>
            </div>
            <PrefSelect ariaLabel={t('settings.language')} value={lang} options={langOptions} onChange={(v) => void i18n.changeLanguage(v)} />
          </div>
          <div style={{ ...row, borderBlockEnd: '0' }}>
            <div style={{ flex: 1, minInlineSize: 0 }}>
              <div style={{ fontSize: '14.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{t('settings.appearance')}</div>
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', marginBlockStart: '3px' }}>{t('settings.appearanceDesc')}</div>
            </div>
            <PrefSelect ariaLabel={t('settings.appearance')} value={pref} options={themeOptions} onChange={setPref} />
          </div>
        </div>
      </div>
    </div>
  )
}

type Pane = 'account' | 'api' | 'profile' | 'voice' | 'flows'
const NAV_GROUPS: { groupKey: string; items: Pane[] }[] = [
  { groupKey: 'settings.groups.account', items: ['account', 'api'] },
  { groupKey: 'settings.groups.business', items: ['profile', 'voice', 'flows'] },
]

export function Settings() {
  const { t, i18n } = useTranslation()
  const isHebrew = i18n.language.startsWith('he')
  const [pane, setPane] = useState<Pane>('profile')

  const railCap: React.CSSProperties = {
    paddingInline: '10px',
    paddingBlock: '10px 6px',
    fontFamily: isHebrew ? 'var(--font-body)' : 'var(--font-mono)',
    fontSize: isHebrew ? '12px' : '10.5px',
    fontWeight: 600,
    letterSpacing: isHebrew ? 'normal' : '0.1em',
    textTransform: isHebrew ? 'none' : 'uppercase',
    color: 'var(--text-tertiary)',
  }

  return (
    <div style={{ maxInlineSize: 'var(--container-max)', marginInline: 'auto', display: 'grid', gap: '22px', alignItems: 'start' }} className="set-grid">
      <nav aria-label="Settings sections" style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-card)', padding: '10px', position: 'sticky', top: '84px' }}>
        {NAV_GROUPS.map((g) => (
          <div key={g.groupKey} style={{ marginBlockStart: '4px' }}>
            <div style={railCap} className="uppercase-track">{t(g.groupKey)}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {g.items.map((p) => {
                const active = pane === p
                return (
                  <button
                    key={p}
                    onClick={() => setPane(p)}
                    aria-current={active ? 'page' : undefined}
                    style={{
                      display: 'flex',
                      inlineSize: '100%',
                      padding: '9px 12px',
                      borderRadius: '10px',
                      border: 0,
                      textAlign: 'start',
                      fontFamily: 'var(--font-body)',
                      fontSize: '14px',
                      fontWeight: active ? 600 : 500,
                      color: active ? 'var(--accent-fg)' : 'var(--text-secondary)',
                      background: active ? 'var(--accent-tint)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    {t(`settings.nav.${p}`)}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div>
        {pane === 'account' && <AccountPane />}
        {pane === 'api' && <ApiTab />}
        {pane === 'profile' && <AgentTab />}
        {pane === 'voice' && <VoiceTab />}
        {pane === 'flows' && <FlowsTab />}
      </div>
    </div>
  )
}

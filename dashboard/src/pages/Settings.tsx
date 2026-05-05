import { useState, useEffect, useId } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as Tabs from '@radix-ui/react-tabs'
import * as Dialog from '@radix-ui/react-dialog'
import { Eye, EyeOff, RefreshCw, X, Save } from 'lucide-react'
import { fetchTenantMe, updateTenantMe, regenerateApiKey } from '../lib/api.js'
import { Button } from '../components/ui/Button.js'
import { Card } from '../components/ui/Card.js'
import { Skeleton } from '../components/ui/Skeleton.js'

function maskApiKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length)
  return key.slice(0, 4) + '•'.repeat(Math.max(0, key.length - 8)) + key.slice(-4)
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
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '16px',
          }}
        >
          Account
        </h3>
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
                  backgroundColor: 'var(--bg-inset)',
                  border: '1px solid var(--border-default)',
                  borderRadius: '8px',
                  padding: '0 12px',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  fontFamily: "'Assistant', sans-serif",
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
              <span style={{ fontSize: '12px', color: 'var(--success)' }}>Saved</span>
            )}
            {mutation.isError && (
              <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>
                Save failed
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}

function FlowsTab() {
  const queryClient = useQueryClient()
  const { data: tenant, isLoading } = useQuery({
    queryKey: ['tenant-me'],
    queryFn: fetchTenantMe,
    staleTime: 60_000,
  })

  const [flowJson, setFlowJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (tenant?.settings != null) {
      setFlowJson(JSON.stringify(tenant.settings, null, 2))
    }
  }, [tenant?.settings])

  const handleChange = (val: string) => {
    setFlowJson(val)
    try {
      JSON.parse(val)
      setJsonError(null)
    } catch {
      setJsonError('Invalid JSON')
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(flowJson) as Record<string, unknown>
      return updateTenantMe({ settings: parsed })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tenant-me'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    },
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '680px' }}>
      <Card>
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '8px',
          }}
        >
          Flow Configuration
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
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
              backgroundColor: 'var(--bg-inset)',
              border: `1px solid ${jsonError ? 'var(--error)' : 'var(--border-default)'}`,
              borderRadius: '8px',
              padding: '12px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              fontFamily: "'Courier New', monospace",
              lineHeight: 1.6,
              outline: 'none',
              resize: 'vertical',
              marginBottom: '8px',
            }}
          />
        )}
        {jsonError && (
          <p id="json-error" role="alert" style={{ fontSize: '12px', color: 'var(--error)', marginBottom: '8px' }}>
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
          {saved && <span style={{ fontSize: '12px', color: 'var(--success)' }}>Saved</span>}
          {mutation.isError && (
            <span role="alert" style={{ fontSize: '12px', color: 'var(--error)' }}>
              Save failed
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
        <h3
          style={{
            fontFamily: "'Montserrat', sans-serif",
            fontWeight: 700,
            fontSize: '12px',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '16px',
          }}
        >
          API Key
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '16px', lineHeight: 1.5 }}>
          Use this key to authenticate API requests. Keep it secret — it grants full access to your tenant.
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            backgroundColor: 'var(--bg-inset)',
            border: '1px solid var(--border-default)',
            borderRadius: '8px',
            marginBottom: '16px',
          }}
        >
          <code
            style={{
              flex: 1,
              fontSize: '13px',
              fontFamily: "'Courier New', monospace",
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
              color: 'var(--text-muted)',
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
              backgroundColor: 'rgba(16, 185, 129, 0.08)',
              border: '1px solid rgba(16, 185, 129, 0.25)',
              borderRadius: '8px',
              fontSize: '13px',
              color: 'var(--success)',
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
          <Dialog.Content
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '400px',
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: '12px',
              boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
              padding: '24px',
              zIndex: 51,
            }}
            aria-describedby="regen-key-desc"
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <Dialog.Title
                style={{
                  fontFamily: "'Montserrat', sans-serif",
                  fontWeight: 700,
                  fontSize: '15px',
                  color: 'var(--text-primary)',
                }}
              >
                Regenerate API Key
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  aria-label="Close dialog"
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
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
              <p role="alert" style={{ fontSize: '12px', color: 'var(--error)', marginTop: '12px' }}>
                Failed to regenerate key. Please try again.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

const tabTriggerStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  backgroundColor: 'transparent',
  border: 'none',
  borderBottom: active ? '2px solid var(--accent-cyan)' : '2px solid transparent',
  color: active ? 'var(--accent-cyan)' : 'var(--text-secondary)',
  fontFamily: "'Assistant', sans-serif",
  fontWeight: 600,
  fontSize: '14px',
  cursor: 'pointer',
  transition: `color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)`,
  whiteSpace: 'nowrap',
})

export function Settings() {
  const [activeTab, setActiveTab] = useState('general')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
        {/* Tab list */}
        <Tabs.List
          aria-label="Settings sections"
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: '24px',
          }}
        >
          {[
            { value: 'general', label: 'General' },
            { value: 'flows', label: 'Flows' },
            { value: 'api', label: 'API' },
          ].map((tab) => (
            <Tabs.Trigger
              key={tab.value}
              value={tab.value}
              style={tabTriggerStyle(activeTab === tab.value)}
            >
              {tab.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="general">
          <GeneralTab />
        </Tabs.Content>
        <Tabs.Content value="flows">
          <FlowsTab />
        </Tabs.Content>
        <Tabs.Content value="api">
          <ApiTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

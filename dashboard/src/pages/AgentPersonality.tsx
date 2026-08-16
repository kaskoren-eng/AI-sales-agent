import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Plus, Trash2, Volume2 } from 'lucide-react'
import { Button } from '../components/ui/Button.js'
import { Input } from '../components/ui/Input.js'
import { TextArea } from '../components/ui/TextArea.js'
import { Skeleton } from '../components/ui/Skeleton.js'
import { useToast } from '../components/ui/Toast.js'
import {
  fetchAgentPersona,
  saveAgentPersona,
  type AgentPersonaPatch,
  type PersonaFaqEntry,
} from '../lib/api.js'

/**
 * Agent Personality — who the agent is on this tenant's calls.
 *
 * WHAT THIS PAGE USED TO BE: 244 lines of `useState` with no API call anywhere. It rendered a
 * hardcoded "קרן", three fabricated metrics ($0.08 / 1.2s / Sonic), eight behaviour switches wired
 * to nothing, and a fake system-prompt preview assembled from a template literal. Pressing Save did
 * not save.
 *
 * WHAT WAS CUT, and why, because dropping controls needs a better reason than tidiness:
 *
 *   - THE METRICS STRIP. Cost per minute has never been measured (docs/gtm/pricing-model.md says
 *     so explicitly) and "1.2s" was typed, not read. A dashboard that invents its own numbers is
 *     worse than one that shows none — a customer would quote them back at you.
 *   - THE EIGHT BEHAVIOUR SWITCHES. Nothing in the agent reads them. Wiring them to a settings key
 *     the prompt ignores would have been worse than leaving them dead: it looks like it works.
 *     They need prompt work and a real call each, which is content work, not plumbing.
 *
 * WHAT REPLACED THEM is the thing the switches were decoration around: the sentence a lead
 * actually hears, live, as you type. Everything on this page feeds that line.
 */

const CARD: React.CSSProperties = {
  background: 'var(--surface-card)',
  border: '1px solid var(--border-default)',
  borderRadius: 'var(--r)',
  boxShadow: 'var(--shadow-card)',
}

const LABEL: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
}

const HINT: React.CSSProperties = { fontSize: '12px', color: 'var(--text-tertiary)' }

const SECTION_TITLE: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: '16px',
  margin: '28px 0 12px',
}

interface Draft extends AgentPersonaPatch {}

const EMPTY_DRAFT: Draft = {
  agentName: '',
  agentGender: 'female',
  companyName: '',
  companyDescription: '',
  handoffPerson: '',
  greeting: '',
  faq: [],
}

/**
 * The greeting, previewed client-side.
 *
 * This MIRRORS `buildGreeting` in `src/modules/channels/voice-livekit/persona.ts` — deliberately,
 * so the preview updates on every keystroke rather than on every save. The duplication is the
 * price of a live preview; it is bounded (one sentence, one gender table) and the server's value
 * is always authoritative — `resolvedGreeting` from the API overwrites this the moment you save.
 */
function previewGreeting(draft: Draft): string {
  if (draft.greeting.trim()) return draft.greeting.trim()
  const speaking = draft.agentGender === 'male' ? 'מדבר' : 'מדברת'
  const can = draft.agentGender === 'male' ? 'יכול' : 'יכולה'
  const name = draft.agentName.trim() || '—'
  const company = draft.companyName.trim() || '—'
  return `שלום, ${speaking} ${name} מ-${company}. איך אני ${can} לעזור?`
}

export function AgentPersonality() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({ queryKey: ['agent-persona'], queryFn: fetchAgentPersona })

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [loaded, setLoaded] = useState(false)

  // Seed the form once. Re-seeding on every refetch would discard whatever the user is mid-way
  // through typing the moment a background refresh landed.
  useEffect(() => {
    if (!data || loaded) return
    const p = data.persona
    setDraft({
      agentName: p.agentName,
      agentGender: p.agentGender,
      companyName: p.companyName,
      companyDescription: p.companyDescription,
      handoffPerson: p.handoffPerson,
      greeting: p.greeting,
      faq: p.faq,
    })
    setLoaded(true)
  }, [data, loaded])

  const saved = useMemo<Draft | null>(() => {
    if (!data) return null
    const p = data.persona
    return {
      agentName: p.agentName,
      agentGender: p.agentGender,
      companyName: p.companyName,
      companyDescription: p.companyDescription,
      handoffPerson: p.handoffPerson,
      greeting: p.greeting,
      faq: p.faq,
    }
  }, [data])

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft)
  const nameMissing = draft.agentName.trim().length === 0
  const companyMissing = draft.companyName.trim().length === 0

  const mutation = useMutation({
    mutationFn: () =>
      saveAgentPersona({
        ...draft,
        agentName: draft.agentName.trim(),
        companyName: draft.companyName.trim(),
        companyDescription: draft.companyDescription.trim(),
        handoffPerson: draft.handoffPerson.trim(),
        greeting: draft.greeting.trim(),
        faq: draft.faq
          .map((f) => ({ topic: f.topic.trim(), answer: f.answer.trim() }))
          .filter((f) => f.topic.length > 0 && f.answer.length > 0),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-persona'] })
      setLoaded(false)
      toast({ variant: 'success', title: t('agent.saved'), description: t('agent.savedNote') })
    },
    onError: (err: Error) => {
      toast({ variant: 'error', title: t('agent.saveFailed'), description: err.message })
    },
  })

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  if (isLoading || !data) {
    return (
      <div style={{ maxInlineSize: '860px', marginInline: 'auto', display: 'grid', gap: '16px' }}>
        <Skeleton height="88px" />
        <Skeleton height="240px" />
        <Skeleton height="180px" />
      </div>
    )
  }

  return (
    <div style={{ maxInlineSize: '860px', marginInline: 'auto', paddingBlockEnd: '96px' }}>
      <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', marginBlockEnd: '20px' }}>
        {t('agent.sub')}
      </p>

      {/*
        The state that matters most, so it is the first thing on the page: this tenant never named
        their agent, so it is currently introducing itself to their leads under ClickScales' name.
      */}
      {!data.configured && (
        <div
          role="status"
          style={{
            display: 'flex',
            gap: '12px',
            alignItems: 'flex-start',
            padding: '14px 16px',
            borderRadius: 'var(--r)',
            background: 'var(--status-warning-bg, var(--surface-sunken))',
            border: '1px solid var(--status-warning, var(--border-strong))',
            marginBlockEnd: '20px',
          }}
        >
          <AlertTriangle size={17} strokeWidth={1.9} style={{ flexShrink: 0, marginBlockStart: '1px', color: 'var(--status-warning, var(--text-secondary))' }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: '13.5px', color: 'var(--text-primary)' }}>
              {t('agent.unconfigured')}
            </div>
            <div style={{ ...HINT, marginBlockStart: '3px' }}>{t('agent.unconfiguredNote')}</div>
          </div>
        </div>
      )}

      {/*
        THE SIGNATURE ELEMENT. Not a metric, not a chart — the actual sentence, in the actual
        language, at the size it deserves. Every field below exists to change this line, so it sits
        above them and moves as you type. dir="rtl" because it is Hebrew regardless of the
        dashboard's interface language.
      */}
      <div style={{ ...CARD, padding: '20px 22px' }}>
        <div style={{ ...HINT, marginBlockEnd: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: '11px', fontWeight: 600 }}>
          {t('agent.greetingPreview')}
        </div>
        <p
          dir="rtl"
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: '21px',
            lineHeight: 1.5,
            fontWeight: 500,
            color: 'var(--text-primary)',
            borderInlineStart: '3px solid var(--accent)',
            paddingInlineStart: '14px',
          }}
        >
          {previewGreeting(draft)}
        </p>
      </div>

      {/* ── Identity ────────────────────────────────────────────────────────────────────────── */}
      <h2 style={SECTION_TITLE}>{t('agent.identity')}</h2>
      <div style={{ ...CARD, padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px', maxInlineSize: '340px' }}>
          <span style={LABEL}>{t('agent.name')}</span>
          <Input
            value={draft.agentName}
            dir="auto"
            invalid={nameMissing}
            onChange={(e) => set('agentName', e.target.value)}
            placeholder={t('agent.namePlaceholder')}
          />
          <span style={HINT}>{nameMissing ? t('agent.nameRequired') : t('agent.nameHint')}</span>
        </label>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={LABEL}>{t('agent.gender')}</span>
          <Segmented
            value={draft.agentGender}
            onChange={(v) => set('agentGender', v)}
            options={[
              { value: 'female', label: t('agent.female') },
              { value: 'male', label: t('agent.male') },
            ]}
          />
          <span style={HINT}>{t('agent.genderHint')}</span>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px', maxInlineSize: '340px' }}>
          <span style={LABEL}>{t('agent.company')}</span>
          <Input
            value={draft.companyName}
            dir="auto"
            invalid={companyMissing}
            onChange={(e) => set('companyName', e.target.value)}
          />
          <span style={HINT}>{t('agent.companyHint')}</span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={LABEL}>{t('agent.companyDescription')}</span>
          <Input
            value={draft.companyDescription}
            dir="auto"
            onChange={(e) => set('companyDescription', e.target.value)}
            placeholder={t('agent.companyDescriptionPlaceholder')}
          />
          <span style={HINT}>{t('agent.companyDescriptionHint')}</span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px', maxInlineSize: '340px' }}>
          <span style={LABEL}>{t('agent.handoff')}</span>
          <Input
            value={draft.handoffPerson}
            dir="auto"
            onChange={(e) => set('handoffPerson', e.target.value)}
            placeholder={t('agent.handoffPlaceholder')}
          />
          <span style={HINT}>{t('agent.handoffHint')}</span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
          <span style={LABEL}>{t('agent.customGreeting')}</span>
          <Input
            value={draft.greeting}
            dir="auto"
            onChange={(e) => set('greeting', e.target.value)}
            placeholder={previewGreeting({ ...draft, greeting: '' })}
          />
          <span style={HINT}>{t('agent.customGreetingHint')}</span>
        </label>
      </div>

      {/* ── Voice: a fact, not a control ────────────────────────────────────────────────────── */}
      <h2 style={SECTION_TITLE}>{t('agent.voice')}</h2>
      <div style={{ ...CARD, padding: '16px 18px', display: 'flex', alignItems: 'center', gap: '13px' }}>
        <Volume2 size={18} strokeWidth={1.8} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        <div style={{ flex: 1, minInlineSize: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', color: 'var(--text-primary)' }}>
            {data.tts?.voiceId ?? t('agent.voiceDefault')}
          </div>
          <div style={{ ...HINT, marginBlockStart: '3px' }}>{t('agent.voiceManaged')}</div>
        </div>
      </div>

      {/* ── FAQ ─────────────────────────────────────────────────────────────────────────────── */}
      <h2 style={SECTION_TITLE}>{t('agent.faq')}</h2>
      <div style={{ ...CARD, padding: '18px 20px' }}>
        <p style={{ ...HINT, margin: '0 0 16px' }}>{t('agent.faqHint')}</p>

        {draft.faq.length === 0 && (
          <p style={{ ...HINT, margin: '0 0 16px', fontStyle: 'italic' }}>{t('agent.faqEmpty')}</p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {draft.faq.map((entry, i) => (
            <FaqRow
              key={i}
              entry={entry}
              topicLabel={t('agent.faqTopic')}
              answerLabel={t('agent.faqAnswer')}
              removeLabel={t('agent.faqRemove')}
              onChange={(next) =>
                set('faq', draft.faq.map((e, j) => (j === i ? next : e)))
              }
              onRemove={() => set('faq', draft.faq.filter((_, j) => j !== i))}
            />
          ))}
        </div>

        <Button
          variant="secondary"
          size="sm"
          style={{ marginBlockStart: draft.faq.length ? '16px' : 0 }}
          onClick={() => set('faq', [...draft.faq, { topic: '', answer: '' }])}
        >
          <Plus size={14} strokeWidth={2} />
          {t('agent.faqAdd')}
        </Button>
      </div>

      {/* ── Save ────────────────────────────────────────────────────────────────────────────── */}
      <div
        style={{
          position: 'sticky',
          insetBlockEnd: 0,
          marginBlockStart: '24px',
          background: 'var(--surface-card)',
          borderBlockStart: '1px solid var(--border-default)',
          padding: '12px 4px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span style={HINT}>{dirty ? t('agent.unsaved') : t('agent.saveNote')}</span>
        <div style={{ marginInlineStart: 'auto', display: 'flex', gap: '10px' }}>
          <Button variant="secondary" disabled={!dirty} onClick={() => saved && setDraft(saved)}>
            {t('agent.discard')}
          </Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            disabled={!dirty || nameMissing || companyMissing || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {t('agent.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<{ value: T; label: string }>
}) {
  return (
    <div
      role="radiogroup"
      style={{
        display: 'inline-flex',
        inlineSize: 'max-content',
        padding: '3px',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-default)',
        borderRadius: '10px',
      }}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: '13px',
              fontWeight: 500,
              padding: '7px 16px',
              border: 0,
              borderRadius: '7px',
              cursor: 'pointer',
              background: active ? 'var(--surface-card)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: active ? 'var(--shadow-card)' : 'none',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function FaqRow({
  entry,
  topicLabel,
  answerLabel,
  removeLabel,
  onChange,
  onRemove,
}: {
  entry: PersonaFaqEntry
  topicLabel: string
  answerLabel: string
  removeLabel: string
  onChange: (next: PersonaFaqEntry) => void
  onRemove: () => void
}) {
  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: '10px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'var(--surface-sunken)',
      }}
    >
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
        <label style={{ flex: 1, minInlineSize: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ ...LABEL, fontSize: '12px' }}>{topicLabel}</span>
          <Input
            size="sm"
            dir="auto"
            value={entry.topic}
            onChange={(e) => onChange({ ...entry, topic: e.target.value })}
          />
        </label>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={removeLabel}>
          <Trash2 size={14} strokeWidth={1.9} />
        </Button>
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <span style={{ ...LABEL, fontSize: '12px' }}>{answerLabel}</span>
        <TextArea
          dir="auto"
          rows={2}
          value={entry.answer}
          onChange={(e) => onChange({ ...entry, answer: e.target.value })}
        />
      </label>
    </div>
  )
}

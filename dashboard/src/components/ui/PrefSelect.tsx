import { useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'

export interface PrefOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
}

interface PrefSelectProps<T extends string> {
  value: T
  options: PrefOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  /** Trigger min inline-size — keeps sibling selects aligned. */
  minWidth?: number
}

/**
 * Notion-style preference dropdown: a trigger showing the current choice (icon + label + chevron)
 * that opens a small menu; the selected option is checked. Flat v5 surfaces, logical properties so
 * it mirrors correctly in RTL. Closes on outside-click / Escape; arrow keys move between options.
 */
export function PrefSelect<T extends string>({ value, options, onChange, ariaLabel, minWidth = 196 }: PrefSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // On open, focus the selected option so keyboard users land on the current choice.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]') ?? listRef.current?.querySelector<HTMLButtonElement>('button')
    el?.focus()
  }, [open])

  const moveFocus = (dir: 1 | -1, from: HTMLElement) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const i = items.indexOf(from as HTMLButtonElement)
    const next = items[(i + dir + items.length) % items.length]
    next?.focus()
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '8px',
          minInlineSize: `${minWidth}px`,
          inlineSize: '100%',
          paddingBlock: '8px',
          paddingInline: '12px',
          borderRadius: '10px',
          border: '1px solid var(--border-default)',
          background: 'var(--surface-card)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-body)',
          fontSize: '14px',
          fontWeight: 500,
          cursor: 'pointer',
          transition: 'border-color var(--duration-fast) var(--ease-standard)',
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-strong)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border-default)')}
      >
        {current.icon && <span style={{ display: 'inline-flex', color: 'var(--text-secondary)', flexShrink: 0 }}>{current.icon}</span>}
        <span style={{ flex: 1, textAlign: 'start' }}>{current.label}</span>
        <ChevronDown size={16} strokeWidth={1.7} style={{ color: 'var(--text-tertiary)', flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--duration-fast) var(--ease-standard)' }} />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          id={listId}
          aria-label={ariaLabel}
          style={{
            position: 'absolute',
            insetBlockStart: 'calc(100% + 6px)',
            insetInlineStart: 0,
            inlineSize: '100%',
            minInlineSize: `${minWidth}px`,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: '12px',
            boxShadow: 'var(--shadow-overlay)',
            padding: '5px',
            zIndex: 60,
          }}
        >
          {options.map((opt) => {
            const selected = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1, e.currentTarget) }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1, e.currentTarget) }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '9px',
                  inlineSize: '100%',
                  paddingBlock: '8px',
                  paddingInline: '10px',
                  borderRadius: '8px',
                  border: 'none',
                  background: selected ? 'var(--accent-tint)' : 'transparent',
                  color: selected ? 'var(--accent-fg)' : 'var(--text-primary)',
                  fontFamily: 'var(--font-body)',
                  fontSize: '14px',
                  fontWeight: selected ? 600 : 500,
                  cursor: 'pointer',
                  textAlign: 'start',
                }}
                onMouseEnter={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-sunken)' }}
                onMouseLeave={(e) => { if (!selected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
              >
                {opt.icon && <span style={{ display: 'inline-flex', color: selected ? 'var(--accent-fg)' : 'var(--text-secondary)', flexShrink: 0 }}>{opt.icon}</span>}
                <span style={{ flex: 1 }}>{opt.label}</span>
                {selected && <Check size={16} strokeWidth={2} style={{ flexShrink: 0 }} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

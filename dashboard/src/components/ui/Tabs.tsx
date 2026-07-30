import { useState, type ReactNode } from 'react'
import * as RadixTabs from '@radix-ui/react-tabs'

export interface TabItem {
  value: string
  label: string
  content: ReactNode
}

interface TabsProps {
  items: TabItem[]
  defaultValue?: string
  ariaLabel?: string
}

/**
 * Radix Tabs with token-only styling. Controlled internally so the active trigger can be
 * inline-styled (Radix exposes state via data-attributes; we mirror it in JS to stay
 * consistent with the codebase's inline-style convention).
 */
export function Tabs({ items, defaultValue, ariaLabel }: TabsProps) {
  const [value, setValue] = useState(defaultValue ?? items[0]?.value ?? '')

  return (
    <RadixTabs.Root value={value} onValueChange={setValue}>
      <RadixTabs.List
        aria-label={ariaLabel}
        style={{
          display: 'flex',
          gap: '4px',
          borderBottom: '1px solid var(--border-default)',
          marginBottom: '20px',
        }}
      >
        {items.map((item) => {
          const active = item.value === value
          return (
            <RadixTabs.Trigger
              key={item.value}
              value={item.value}
              style={{
                appearance: 'none',
                background: 'none',
                border: 'none',
                paddingInline: '4px',
                paddingBlock: '10px',
                marginInlineEnd: '12px',
                fontSize: '13px',
                fontWeight: 600,
                fontFamily: 'var(--font-body)',
                cursor: 'pointer',
                color: active ? 'var(--accent-fg)' : 'var(--text-tertiary)',
                borderBottom: `2px solid ${active ? 'var(--accent-fg)' : 'transparent'}`,
                marginBottom: '-1px',
                transition: `color var(--duration-fast) var(--ease-standard)`,
              }}
            >
              {item.label}
            </RadixTabs.Trigger>
          )
        })}
      </RadixTabs.List>
      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value}>
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  )
}

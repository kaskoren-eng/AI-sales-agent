import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import * as RadixToast from '@radix-ui/react-toast'
import { CheckCircle, Info, X, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

type ToastVariant = 'success' | 'error' | 'info'

interface ToastOptions {
  variant: ToastVariant
  title: string
  description?: string
}

interface ToastItem extends ToastOptions {
  id: number
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/** Fire a toast from anywhere under <ToastProvider> (mounted in AppLayout). */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

const ICON: Record<ToastVariant, typeof CheckCircle> = {
  success: CheckCircle,
  error: XCircle,
  info: Info,
}
const ACCENT: Record<ToastVariant, string> = {
  success: 'var(--success)',
  error: 'var(--error)',
  info: 'var(--info)',
}

let nextId = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const toast = useCallback((options: ToastOptions) => {
    setToasts((prev) => [...prev, { ...options, id: ++nextId }])
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      <RadixToast.Provider swipeDirection="right" duration={4000}>
        {children}

        {toasts.map((item) => {
          const Icon = ICON[item.variant]
          return (
            <RadixToast.Root
              key={item.id}
              onOpenChange={(open) => {
                if (!open) dismiss(item.id)
              }}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '10px',
                padding: '12px 14px',
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-default)',
                borderRadius: '10px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
              }}
            >
              <span
                aria-hidden="true"
                style={{ color: ACCENT[item.variant], flexShrink: 0, display: 'inline-flex', marginTop: '1px' }}
              >
                <Icon size={16} strokeWidth={1.5} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <RadixToast.Title
                  style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}
                >
                  {item.title}
                </RadixToast.Title>
                {item.description && (
                  <RadixToast.Description
                    dir="auto"
                    style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}
                  >
                    {item.description}
                  </RadixToast.Description>
                )}
              </div>
              <RadixToast.Close
                aria-label={t('common.close')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px',
                  display: 'inline-flex',
                  flexShrink: 0,
                }}
              >
                <X size={14} strokeWidth={1.5} />
              </RadixToast.Close>
            </RadixToast.Root>
          )
        })}

        <RadixToast.Viewport
          style={{
            position: 'fixed',
            insetBlockEnd: '20px',
            insetInlineEnd: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            width: '340px',
            maxWidth: 'calc(100vw - 40px)',
            margin: 0,
            padding: 0,
            listStyle: 'none',
            zIndex: 60,
            outline: 'none',
          }}
        />
      </RadixToast.Provider>
    </ToastContext.Provider>
  )
}

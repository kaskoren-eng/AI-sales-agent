import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  closeLabel?: string
  width?: string
}

/**
 * Centered dialog on the elevated surface (brief §2 primitive spec). Focus is trapped by
 * Radix; Esc / overlay-click close. Footer is the actions row (right-aligned, mirrors in RTL).
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  closeLabel,
  width = '420px',
}: ModalProps) {
  const { t } = useTranslation()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 50 }}
        />
        <Dialog.Content
          style={{
            position: 'fixed',
            top: '50%',
            insetInlineStart: '50%',
            transform: 'translate(-50%, -50%)',
            width,
            maxWidth: 'calc(100vw - 32px)',
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-default)',
            borderRadius: '12px',
            boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
            padding: '24px',
            zIndex: 51,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '12px',
              marginBottom: description != null ? '12px' : '20px',
            }}
          >
            <Dialog.Title
              style={{
                fontFamily: "'Montserrat', sans-serif",
                fontWeight: 700,
                fontSize: '15px',
                color: 'var(--text-primary)',
                margin: 0,
              }}
            >
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label={closeLabel ?? t('common.close')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: '2px',
                  display: 'inline-flex',
                }}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </Dialog.Close>
          </div>

          {description != null && (
            <Dialog.Description asChild>
              <div
                style={{
                  fontSize: '14px',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                  marginBottom: children || footer ? '20px' : 0,
                }}
              >
                {description}
              </div>
            </Dialog.Description>
          )}

          {children}

          {footer && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              {footer}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, ShieldAlert, Trash2, X } from 'lucide-react'
import { ConfirmContext, type ConfirmFunction, type ConfirmOptions, type ConfirmTone } from './confirm'

const toneIcons: Record<ConfirmTone, ReactNode> = {
  default: <ShieldAlert size={20} />,
  danger: <Trash2 size={20} />,
  warning: <AlertTriangle size={20} />,
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const confirm = useCallback<ConfirmFunction>((options) => (
    new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setPending(options)
    })
  ), [])

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setPending(null)
  }, [])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmDialog
          options={pending}
          onCancel={() => settle(false)}
          onConfirm={() => settle(true)}
        />
      )}
    </ConfirmContext.Provider>
  )
}

function ConfirmDialog({ options, onCancel, onConfirm }: {
  options: ConfirmOptions
  onCancel: () => void
  onConfirm: () => void
}) {
  const tone = options.tone ?? 'default'
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus the safe action first, and allow Escape to dismiss.
  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}
    >
      <section
        className="connect-modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-heading"
        aria-describedby="confirm-copy"
      >
        <button className="modal-close" aria-label="Cancel" onClick={onCancel}><X size={17} /></button>
        <span className={`modal-icon ${tone === 'default' ? '' : tone}`.trim()}>{options.icon ?? toneIcons[tone]}</span>
        {options.eyebrow && <p className="eyebrow">{options.eyebrow}</p>}
        <h2 id="confirm-heading">{options.title}</h2>
        <p className="modal-copy confirm-copy" id="confirm-copy">{options.message}</p>
        <div className="modal-confirm-actions">
          <button ref={cancelRef} type="button" className="button button-secondary" onClick={onCancel}>
            {options.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`}
            onClick={onConfirm}
          >
            {options.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

export type ConfirmTone = 'default' | 'danger' | 'warning'

export type ConfirmOptions = {
  /** Short uppercase label shown above the title, e.g. "DELETE DUPLICATE". */
  eyebrow?: string
  title: string
  /** Body copy. Rendered as-is, so pass text or simple inline elements. */
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmTone
  /** Overrides the default icon for the chosen tone. */
  icon?: ReactNode
}

export type ConfirmFunction = (options: ConfirmOptions) => Promise<boolean>

export const ConfirmContext = createContext<ConfirmFunction | null>(null)

/**
 * Promise-based replacement for window.confirm that renders a styled dialog
 * matching the rest of the app.
 *
 *   const confirmed = await confirm({ title: 'Delete this file?', tone: 'danger' })
 */
export function useConfirm() {
  const context = useContext(ConfirmContext)
  if (!context) throw new Error('useConfirm must be used within a ConfirmProvider')
  return context
}

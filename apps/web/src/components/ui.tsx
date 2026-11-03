import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { errorMessage } from '../lib/api'

const BUTTON_STYLES = {
  primary: 'border border-accent bg-accent text-on-accent hover:brightness-95',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-raised',
  ghost: 'border border-transparent text-ink-2 hover:bg-raised hover:text-ink',
  danger: 'border border-danger text-danger hover:bg-raised',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_STYLES
}

export function Button({ variant = 'secondary', className = '', ...props }: ButtonProps) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-8 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${BUTTON_STYLES[variant]} ${className}`}
    />
  )
}

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
}

export function Field({ label, className = '', ...props }: FieldProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-ink-2">
        {label}
      </label>
      <input
        id={id}
        {...props}
        className={`rounded border border-line-strong bg-deep px-3 py-2 text-sm text-ink ${className}`}
      />
    </div>
  )
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-danger">
      {typeof error === 'string' ? error : errorMessage(error)}
    </p>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" className="p-4 text-sm text-muted">
      {label}
    </p>
  )
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-line bg-raised px-2 py-0.5 text-xs font-medium text-muted">{children}</span>
  )
}

export interface DialogProps {
  title: string
  open: boolean
  onClose: () => void
  children: ReactNode
  wide?: boolean
}

// The native element gives focus trapping, Escape to close and an inert background.
export function Dialog({ title, open, onClose, children, wide = false }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-label={title}
      className={`m-auto rounded-lg border border-line bg-surface p-5 text-ink backdrop:bg-[color-mix(in_oklab,var(--deep)_72%,transparent)] ${
        wide ? 'h-[85vh] w-[90vw]' : 'w-full max-w-md'
      }`}
    >
      {open && (
        <div className="flex h-full flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-medium">{title}</h2>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  )
}

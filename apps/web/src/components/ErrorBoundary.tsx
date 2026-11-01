import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: string
}

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-6">
        <p className="font-medium">{this.props.fallback ?? 'This page stopped working.'}</p>
        <button type="button" className="text-sm underline" onClick={() => location.reload()}>
          Reload the page
        </button>
      </div>
    )
  }
}

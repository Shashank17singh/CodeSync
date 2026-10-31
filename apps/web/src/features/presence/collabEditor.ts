import './monacoEnvironment'
import {
  createCursor,
  resolveCursor,
  type CollabSession,
  type PresencePeer,
} from '@codesync/collab-client'
import {
  PRESENCE_TIMINGS,
  colorIndexForUser,
  type PresenceCursor,
} from '@codesync/shared'
import * as monaco from 'monaco-editor'
import { MonacoBinding } from 'y-monaco'
import * as Y from 'yjs'
import { installPresenceStyles } from './presenceStyles'

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: 'python',
  cpp: 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  java: 'java',
  js: 'javascript',
  ts: 'typescript',
}

class RemoteCursor implements monaco.editor.IContentWidget {
  readonly allowEditorOverflow = false
  private readonly root = document.createElement('div')
  private readonly label = document.createElement('div')
  private position: monaco.IPosition = { lineNumber: 1, column: 1 }
  private key = ''
  private fadeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly clientId: number, userId: string) {
    this.root.className = `cs-cursor cs-cursor-${colorIndexForUser(userId)}`
    this.root.setAttribute('aria-hidden', 'true')
    this.root.dataset['clientId'] = String(clientId)
    const caret = document.createElement('div')
    caret.className = 'cs-caret'
    this.label.className = 'cs-label'
    this.root.append(caret, this.label)
  }

  getId(): string {
    return `cs.remote-cursor.${this.clientId}`
  }

  getDomNode(): HTMLElement {
    return this.root
  }

  getPosition(): monaco.editor.IContentWidgetPosition {
    return {
      position: this.position,
      preference: [monaco.editor.ContentWidgetPositionPreference.EXACT],
    }
  }

  update(position: monaco.IPosition, name: string, cursor: PresenceCursor): void {
    this.position = position
    // textContent, so a display name can never become markup.
    this.label.textContent = name
    this.root.classList.toggle('cs-cursor-first-line', position.lineNumber === 1)
    const key = JSON.stringify(cursor)
    if (key === this.key) return
    this.key = key
    this.label.classList.remove('cs-label-faded')
    clearTimeout(this.fadeTimer)
    this.fadeTimer = setTimeout(() => {
      this.label.classList.add('cs-label-faded')
    }, PRESENCE_TIMINGS.labelFadeMs)
  }

  dispose(): void {
    clearTimeout(this.fadeTimer)
  }
}

export interface CollabEditorOptions {
  container: HTMLElement
  session: CollabSession
  theme: 'vs' | 'vs-dark'
}

// Owns the Monaco instance. y-monaco's own cursor rendering is off, because it has no idea of
// which file a peer is in and cannot show labels or fade them.
export class CollabEditor {
  private readonly editor: monaco.editor.IStandaloneCodeEditor
  private readonly session: CollabSession
  private readonly models = new Map<string, monaco.editor.ITextModel>()
  private readonly cursors = new Map<number, RemoteCursor>()
  private readonly selections: monaco.editor.IEditorDecorationsCollection
  private readonly disposables: monaco.IDisposable[] = []
  private binding: MonacoBinding | null = null
  private text: Y.Text | null = null
  private fileId: string | null = null
  private peers: readonly PresencePeer[] = []

  constructor({ container, session, theme }: CollabEditorOptions) {
    installPresenceStyles()
    this.session = session
    this.editor = monaco.editor.create(container, {
      model: null,
      theme,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    })
    this.selections = this.editor.createDecorationsCollection()
    this.disposables.push(
      this.editor.onDidChangeCursorSelection((event) => this.publishCursor(event.selection)),
    )
  }

  get activeFileId(): string | null {
    return this.fileId
  }

  openFile(fileId: string): void {
    if (fileId === this.fileId) return
    const text = this.session.files.get(fileId)
    if (!(text instanceof Y.Text)) return

    this.binding?.destroy()
    this.text?.unobserve(this.onTextChange)
    this.text = text
    this.fileId = fileId
    const model = this.modelFor(fileId)
    this.editor.setModel(model)
    this.binding = new MonacoBinding(text, model, new Set([this.editor]), null)
    // Observed after the binding, so positions resolve against an updated model.
    text.observe(this.onTextChange)
    this.session.presence.setFile(fileId)
    this.render()
  }

  private modelFor(fileId: string): monaco.editor.ITextModel {
    const existing = this.models.get(fileId)
    if (existing) return existing
    const path = this.session.tree.get(fileId)?.path ?? ''
    const extension = path.split('.').pop()?.toLowerCase() ?? ''
    const model = monaco.editor.createModel('', LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext')
    // Yjs offsets count one character per newline, which CRLF would break.
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    this.models.set(fileId, model)
    return model
  }

  private publishCursor(selection: monaco.Selection): void {
    const model = this.editor.getModel()
    if (!model || !this.text) return
    const anchor = model.getOffsetAt({
      lineNumber: selection.selectionStartLineNumber,
      column: selection.selectionStartColumn,
    })
    const head = model.getOffsetAt({
      lineNumber: selection.positionLineNumber,
      column: selection.positionColumn,
    })
    const length = this.text.length
    this.session.presence.setCursor(
      createCursor(this.text, Math.min(anchor, length), Math.min(head, length)),
    )
  }

  focus(): void {
    this.editor.focus()
  }

  reveal(fileId: string, cursor: PresenceCursor): void {
    const model = this.editor.getModel()
    if (!model || !this.text || fileId !== this.fileId) return
    const resolved = resolveCursor(this.text, cursor)
    if (resolved) {
      this.editor.revealPositionInCenterIfOutsideViewport(model.getPositionAt(resolved.head))
    }
  }

  renderPeers(peers: readonly PresencePeer[]): void {
    this.peers = peers
    this.render()
  }

  private readonly onTextChange = (): void => this.render()

  private render(): void {
    const model = this.editor.getModel()
    const text = this.text
    const seen = new Set<number>()
    const selections: monaco.editor.IModelDeltaDecoration[] = []

    if (model && text) {
      for (const peer of this.peers) {
        if (peer.fileId !== this.fileId || !peer.cursor) continue
        const resolved = resolveCursor(text, peer.cursor)
        if (!resolved) continue
        seen.add(peer.clientId)

        const head = model.getPositionAt(resolved.head)
        this.showCursor(peer, head, peer.cursor)
        if (resolved.anchor === resolved.head) continue
        selections.push({
          range: monaco.Range.fromPositions(
            model.getPositionAt(Math.min(resolved.anchor, resolved.head)),
            model.getPositionAt(Math.max(resolved.anchor, resolved.head)),
          ),
          options: {
            className: `cs-sel-${colorIndexForUser(peer.userId)}`,
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        })
      }
    }

    for (const [clientId, cursor] of this.cursors) {
      if (seen.has(clientId)) continue
      this.editor.removeContentWidget(cursor)
      cursor.dispose()
      this.cursors.delete(clientId)
    }
    this.selections.set(selections)
  }

  private showCursor(peer: PresencePeer, head: monaco.Position, cursor: PresenceCursor): void {
    const existing = this.cursors.get(peer.clientId)
    if (existing) {
      existing.update(head, peer.name, cursor)
      this.editor.layoutContentWidget(existing)
      return
    }
    const created = new RemoteCursor(peer.clientId, peer.userId)
    created.update(head, peer.name, cursor)
    this.cursors.set(peer.clientId, created)
    this.editor.addContentWidget(created)
  }

  dispose(): void {
    this.binding?.destroy()
    this.text?.unobserve(this.onTextChange)
    for (const cursor of this.cursors.values()) cursor.dispose()
    this.cursors.clear()
    this.disposables.forEach((disposable) => disposable.dispose())
    this.selections.clear()
    this.editor.dispose()
    this.models.forEach((model) => model.dispose())
  }
}

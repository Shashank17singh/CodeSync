import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'

globalThis.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

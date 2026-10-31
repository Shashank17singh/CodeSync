import { PRESENCE_PALETTE } from '@codesync/shared'

const SELECTION_OPACITY = 0.25

function selectionColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  return `rgb(${r} ${g} ${b} / ${SELECTION_OPACITY})`
}

// Classes come from the fixed palette, so remote data never reaches a stylesheet.
export function presenceStyles(): string {
  const colors = PRESENCE_PALETTE.map(
    (color, index) => `
.cs-sel-${index} { background-color: ${selectionColor(color)}; }
.cs-cursor-${index} .cs-caret { background-color: ${color}; }
.cs-cursor-${index} .cs-label { background-color: ${color}; }`,
  ).join('')

  return `${colors}
.cs-cursor { position: relative; width: 0; height: 0; pointer-events: none; }
.cs-caret { position: absolute; top: 0; left: -1px; width: 2px; height: 19px; }
.vs-dark .cs-caret, .hc-black .cs-caret { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.6); }
.cs-label {
  position: absolute;
  bottom: 0;
  left: -1px;
  padding: 1px 4px;
  border-radius: 3px 3px 3px 0;
  color: #fff;
  font: 500 11px/14px system-ui, sans-serif;
  white-space: nowrap;
  opacity: 1;
  transition: opacity 300ms ease;
}
.cs-cursor-first-line .cs-label { top: 19px; bottom: auto; border-radius: 0 3px 3px 3px; }
.cs-label-faded { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .cs-label { transition: none; }
}`
}

export function installPresenceStyles(): void {
  if (document.getElementById('cs-presence-styles')) return
  const style = document.createElement('style')
  style.id = 'cs-presence-styles'
  style.textContent = presenceStyles()
  document.head.append(style)
}

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Chat and problem statements are untrusted. react-markdown builds React elements and skips raw
// HTML, and its default URL filter drops javascript: links.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="cs-markdown min-w-0 text-sm break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  )
}

import { isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyText } from '../lib/clipboard'

/** React 노드 트리에서 표시 텍스트만 재귀적으로 추출 (코드블럭 원문 복사용) */
function nodeText(node: ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/** 코드블럭(pre) 래퍼 — 우상단에 복사 버튼을 얹는다 */
function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void copyText(nodeText(children).replace(/\n$/, ''))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="codeblock">
      <button className="code-copy" onClick={copy} title="코드 복사">
        {copied ? '복사됨 ✓' : '복사'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

/**
 * 에이전트 응답 마크다운 렌더러.
 * react-markdown은 raw HTML을 렌더링하지 않으므로 XSS에 안전하다.
 * 링크는 target=_blank로 열어 main의 setWindowOpenHandler가 외부 브라우저로 넘긴다.
 */
export default function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

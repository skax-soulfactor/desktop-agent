import { isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyText } from '../lib/clipboard'

/** hast 노드 — 하이라이트 플러그인이 다루는 최소 형태 */
interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** 텍스트 노드에서 검색어와 일치하는 모든 구간을 <mark>로 감싼다 */
function markMatches(node: HastNode, q: string): void {
  if (!node.children) return
  const out: HastNode[] = []
  for (const child of node.children) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      markMatches(child, q)
      out.push(child)
      continue
    }
    const text = child.value
    const lower = text.toLowerCase()
    let from = 0
    let pos = lower.indexOf(q)
    if (pos < 0) {
      out.push(child)
      continue
    }
    while (pos >= 0) {
      if (pos > from) out.push({ type: 'text', value: text.slice(from, pos) })
      out.push({
        type: 'element',
        tagName: 'mark',
        properties: {},
        children: [{ type: 'text', value: text.slice(pos, pos + q.length) }]
      })
      from = pos + q.length
      pos = lower.indexOf(q, from)
    }
    if (from < text.length) out.push({ type: 'text', value: text.slice(from) })
  }
  node.children = out
}

/**
 * 검색어 하이라이트 rehype 플러그인.
 * 마크다운 파싱이 끝난 뒤 텍스트 노드만 건드리므로 문법이나 링크를 깨뜨리지 않는다.
 */
function rehypeMark(query: string) {
  const q = query.trim().toLowerCase()
  return () => (tree: HastNode): void => {
    if (q) markMatches(tree, q)
  }
}

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
 * highlight가 있으면 본문에서 일치하는 구간을 <mark>로 표시한다 (검색 결과로 이동했을 때).
 */
export default function Markdown({
  text,
  highlight
}: {
  text: string
  highlight?: string
}): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={highlight ? [rehypeMark(highlight)] : []}
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

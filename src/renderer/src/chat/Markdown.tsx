import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

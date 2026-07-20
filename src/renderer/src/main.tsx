import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// 숨긴 타이틀바의 네이티브 버튼(맥 신호등/윈도우 컨트롤) 자리를 CSS에서 비워두기 위한 플랫폼 클래스
if (navigator.userAgent.includes('Macintosh')) document.body.classList.add('mac')
else if (navigator.userAgent.includes('Windows')) document.body.classList.add('win')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

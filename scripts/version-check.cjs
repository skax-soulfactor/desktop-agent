'use strict'

/**
 * npm version이 새 번호를 package.json에 쓴 뒤, 커밋과 태그를 만들기 직전에 도는 확인.
 *
 * 여기여야 하는 이유: npm은 올릴 번호를 preversion에 알려 주지 않는다. preversion에서
 * 충돌을 보려면 현재 버전만으로 짐작해야 하고, 그러면 "빈 번호로 직접 지정하라"는 탈출구도
 * 같이 막혀 아무것도 낼 수 없게 된다. 이 시점에는 package.json에 확정된 새 번호가 들어 있다.
 *
 * 여기서 죽으면 커밋도 태그도 만들어지지 않는다(확인함). 다만 package.json·lock은 이미
 * 새 번호로 쓰인 뒤라 그대로 두면 작업 트리가 더러워지므로 직접 되돌린다 — npm version은
 * 깨끗한 트리에서만 시작하니 이 시점의 변경은 전부 npm이 만든 것이다.
 */

const { execFileSync } = require('child_process')
const { version } = require('../package.json')
const { listVersionTags, nextFree } = require('./version-tags.cjs')

const tags = listVersionTags()

if (!tags.includes(version)) {
  console.log('✓ v' + version + ' — 아직 쓰지 않은 번호입니다')
  process.exit(0)
}

// npm이 방금 쓴 버전 파일을 되돌린다. 그대로 두면 다음 실행이 "더러운 트리"로 거절된다.
try {
  execFileSync('git', ['checkout', '--', 'package.json', 'package-lock.json'], { stdio: 'ignore' })
} catch (e) {
  // 되돌리기에 실패해도 아래 안내는 그대로 유효하다
}

const free = nextFree(version, tags)

console.error('')
console.error('✗ v' + version + ' 태그가 이미 있습니다. 커밋과 태그를 만들지 않고 멈췄습니다.')
console.error('')
console.error('  이미 발행된 번호를 다시 쓰면 자동 업데이트가 받아 간 릴리스와 어긋납니다.')
console.error('  package.json은 원래대로 되돌렸습니다.')
console.error('')
console.error('  빈 번호로 다시 실행하세요: npm version ' + free)
console.error('')

process.exit(1)

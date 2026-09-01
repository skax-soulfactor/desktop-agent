'use strict'

/**
 * npm version 앞에 서는 가드 — 어디서 올리는지를 본다.
 *
 * 2026-09-01에 기능 브랜치에서 올린 v0.1.18~v0.1.20의 버전 커밋이 머지되지 않아 main의
 * package.json은 0.1.17에 머물렀고, 원격보다 뒤처진 main에서 만든 v0.1.21이 코드가 한 줄도
 * 바뀌지 않은 릴리스로 발행됐다. 그 둘(브랜치, 동기화)을 여기서 막는다.
 *
 * 번호 충돌은 여기서 막지 않는다. preversion은 npm이 올릴 "다음 번호"를 알 수 없어서
 * 현재 버전만 보고 판단하게 되는데, 그러면 빠져나갈 명령(npm version 0.1.21)까지 같이
 * 막힌다 — 실제로 그렇게 막혀서 아무것도 낼 수 없는 상태가 됐다. 충돌은 새 번호가 확정된
 * 뒤인 scripts/version-check.cjs에서 본다.
 */

const { execFileSync } = require('child_process')
const { version } = require('../package.json')
const { isGreater, listVersionTags, nextFree } = require('./version-tags.cjs')

const RELEASE_BRANCH = 'main'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function fail(title, lines) {
  console.error('')
  console.error('✗ ' + title)
  console.error('')
  for (const line of lines) console.error('  ' + line)
  console.error('')
  console.error('  이 확인을 건너뛰려면: ALLOW_VERSION=1 npm version <새 버전>')
  console.error('')
  process.exit(1)
}

if (process.env.ALLOW_VERSION === '1') {
  console.log('! 버전 가드를 건너뜁니다 (ALLOW_VERSION=1)')
  process.exit(0)
}

// 1. 릴리스 브랜치인가 — 기능 브랜치에서 올린 버전 커밋은 PR 머지에서 빠지고 태그 번호만 태운다
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== RELEASE_BRANCH) {
  fail('버전은 ' + RELEASE_BRANCH + '에서만 올립니다. 지금 브랜치: ' + branch, [
    '기능 브랜치에서 올리면 태그는 만들어지는데 버전 커밋은 PR 머지에서 빠지기 쉽습니다.',
    '작업을 먼저 머지한 뒤: git checkout ' + RELEASE_BRANCH + ' && git pull'
  ])
}

// 2. 원격과 같은 지점인가 — 뒤처진 곳에서 태그를 만들면 그 릴리스에는 머지된 작업이 빠진다
try {
  execFileSync('git', ['fetch', '--quiet', 'origin', RELEASE_BRANCH, '--tags'], { stdio: 'ignore' })
} catch (e) {
  fail('origin에서 fetch하지 못했습니다.', [
    '원격 상태를 모르는 채로 태그를 만들면 이미 머지된 작업이 빠진 릴리스가 나갑니다.',
    '네트워크를 확인한 뒤 다시 시도하세요.'
  ])
}

const [behind, ahead] = git('rev-list', '--left-right', '--count', 'origin/' + RELEASE_BRANCH + '...HEAD')
  .split(/\s+/)
  .map(Number)

if (behind > 0) {
  fail('로컬 ' + RELEASE_BRANCH + '가 origin보다 ' + behind + '개 뒤처져 있습니다.', [
    '지금 태그를 만들면 원격에 머지된 작업이 빠진 릴리스가 발행됩니다.',
    'git pull 후 다시 시도하세요.'
  ])
}

if (ahead > 0) {
  fail('로컬 ' + RELEASE_BRANCH + '에 푸시하지 않은 커밋이 ' + ahead + '개 있습니다.', [
    git('log', '--oneline', 'origin/' + RELEASE_BRANCH + '..HEAD'),
    '',
    '먼저 푸시하거나 정리한 뒤 버전을 올리세요.'
  ])
}

// 3. 번호가 어긋나 있으면 알려만 준다. 막지는 않는다 — 막으면 고칠 방법까지 함께 막힌다.
const tags = listVersionTags()
const aheadTags = tags.filter((t) => isGreater(t, version))

if (aheadTags.length > 0) {
  console.warn('')
  console.warn('! package.json은 ' + version + '인데 더 높은 태그가 이미 있습니다: ' + aheadTags.map((t) => 'v' + t).join(', '))
  console.warn('  patch로 올리면 이미 쓴 번호와 부딪힙니다. 빈 번호로 직접 지정하세요:')
  console.warn('    npm version ' + nextFree(version, tags))
  console.warn('')
}

console.log('✓ ' + RELEASE_BRANCH + ' / origin과 동일 — ' + version + '에서 버전을 올립니다')

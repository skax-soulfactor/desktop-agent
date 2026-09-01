'use strict'

/**
 * npm version 앞에 서는 가드.
 *
 * 2026-09-01에 세 가지가 한꺼번에 터졌다. 기능 브랜치에서 npm version을 돌려 v0.1.18~v0.1.20
 * 태그를 먼저 써 버렸는데 그 버전 커밋은 머지되지 않아 main의 package.json은 0.1.17에 머물렀고,
 * main에서 patch를 올리자 이미 쓴 태그와 계속 부딪혔다. npm version은 커밋을 먼저 만들고 태그를
 * 나중에 붙이므로 실패한 실행마다 버전 커밋만 쌓였다. 게다가 그 main은 원격보다 뒤처져 있어서,
 * 결국 이번 작업이 하나도 담기지 않은 v0.1.21이 릴리스로 발행됐다.
 *
 * 셋 다 아래 세 가지 확인으로 막힌다. 정말 필요하면 ALLOW_VERSION=1로 넘어갈 수 있다.
 */

const { execFileSync } = require('child_process')
const { version } = require('../package.json')

const RELEASE_BRANCH = 'main'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/** "0.1.9"와 "0.1.10"을 문자열로 비교하면 뒤집힌다 */
function toParts(v) {
  return v.split('.').map(Number)
}

function isGreater(a, b) {
  const [x, y] = [toParts(a), toParts(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  }
  return false
}

/** 아직 쓰지 않은 다음 패치 번호 */
function nextFree(current, taken) {
  const [major, minor] = toParts(current)
  const used = new Set(taken)
  let patch = toParts(current)[2] + 1
  while (used.has(major + '.' + minor + '.' + patch)) patch++
  return major + '.' + minor + '.' + patch
}

function fail(title, lines) {
  console.error('')
  console.error('✗ ' + title)
  console.error('')
  for (const line of lines) console.error('  ' + line)
  console.error('')
  console.error('  이 확인을 건너뛰려면: ALLOW_VERSION=1 npm version <patch|minor|major>')
  console.error('')
  process.exit(1)
}

if (process.env.ALLOW_VERSION === '1') {
  console.log('! 버전 가드를 건너뜁니다 (ALLOW_VERSION=1)')
  process.exit(0)
}

// 1. 릴리스 브랜치인가 — 기능 브랜치에서 올린 버전은 머지에서 빠지고 태그 번호만 태운다
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

const counts = git('rev-list', '--left-right', '--count', 'origin/' + RELEASE_BRANCH + '...HEAD')
const [behind, ahead] = counts.split(/\s+/).map(Number)

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

// 3. 태그가 package.json보다 앞서 있지 않은가 — 앞서 있으면 patch를 올려도 계속 충돌한다
const tags = git('tag', '--list', 'v*')
  .split('\n')
  .filter(Boolean)
  .map((t) => t.replace(/^v/, ''))
  .filter((t) => /^\d+\.\d+\.\d+$/.test(t))

const aheadTags = tags.filter((t) => isGreater(t, version))
if (aheadTags.length > 0) {
  fail('package.json은 ' + version + '인데 더 높은 태그가 이미 있습니다: ' + aheadTags.map((t) => 'v' + t).join(', '), [
    '다른 브랜치에서 버전을 올리고 그 커밋이 머지되지 않았을 때 이렇게 됩니다.',
    '그대로 두면 npm version이 이미 쓴 번호를 다시 만들려다 실패하는데, 실패해도 커밋은 남습니다.',
    '',
    '쓸 수 있는 번호로 직접 지정하세요: npm version ' + nextFree(version, tags),
    '또는 쓰지 않은 태그를 지우세요: git tag -d <태그> && git push origin :refs/tags/<태그>'
  ])
}

console.log(
  '✓ ' + RELEASE_BRANCH + ' / origin과 동일 / 태그 충돌 없음 — ' + version + '에서 버전을 올립니다'
)

'use strict'

/** preversion(어디서 올리는지)과 version(어떤 번호로 올리는지)이 함께 쓰는 태그 계산. */

const { execFileSync } = require('child_process')

function parts(v) {
  return v.split('.').map(Number)
}

/** "0.1.9"와 "0.1.10"을 문자열로 비교하면 뒤집힌다 */
function isGreater(a, b) {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0)
  }
  return false
}

/** 저장소의 v* 태그를 "0.1.17" 형태로 (semver 꼴이 아닌 태그는 버린다) */
function listVersionTags() {
  return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
}

/** from 다음으로 아직 쓰지 않은 패치 번호 */
function nextFree(from, taken) {
  const [major, minor] = parts(from)
  const used = new Set(taken)
  let patch = parts(from)[2] + 1
  while (used.has(major + '.' + minor + '.' + patch)) patch++
  return major + '.' + minor + '.' + patch
}

module.exports = { isGreater, listVersionTags, nextFree }

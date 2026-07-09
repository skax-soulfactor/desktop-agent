'use strict'

const { spawn } = require('child_process')

const SYSTEM_CA_FLAG = '--use-system-ca'

function withSystemCa(env) {
  const next = { ...env }
  const existing = next.NODE_OPTIONS?.trim()
  if (!existing?.includes(SYSTEM_CA_FLAG)) {
    next.NODE_OPTIONS = [existing, SYSTEM_CA_FLAG].filter(Boolean).join(' ')
  }
  return next
}

function run(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: withSystemCa(process.env),
    shell: process.platform === 'win32'
  })
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    process.exit(code ?? 1)
  })
}

const mode = process.argv[2]
const rest = process.argv.slice(3)

if (mode === 'dev') {
  run('npx', ['electron-vite', 'dev', ...rest])
} else if (mode === 'start') {
  run('npx', ['electron-vite', 'preview', ...rest])
} else {
  console.error('usage: node scripts/electron-env.cjs <dev|start>')
  process.exit(1)
}

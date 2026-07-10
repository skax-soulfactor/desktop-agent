import type { McpServerConfig } from '@shared/types'
import { readJson, writeJson } from '../storage/jsonStore'

interface McpFile {
  servers: McpServerConfig[]
}

function load(): McpFile {
  return readJson<McpFile>('mcp.json', { servers: [] })
}

function save(file: McpFile): void {
  writeJson('mcp.json', file)
}

export function listMcpServers(): McpServerConfig[] {
  return load().servers
}

export function getMcpServer(id: string): McpServerConfig | undefined {
  return load().servers.find((s) => s.id === id)
}

export function saveMcpServer(config: McpServerConfig): void {
  const file = load()
  const idx = file.servers.findIndex((s) => s.id === config.id)
  if (idx >= 0) file.servers[idx] = config
  else file.servers.push(config)
  save(file)
}

export function deleteMcpServer(id: string): void {
  const file = load()
  file.servers = file.servers.filter((s) => s.id !== id)
  save(file)
}

export function setMcpLastStatus(id: string, status: McpServerConfig['lastStatus']): void {
  const file = load()
  const s = file.servers.find((x) => x.id === id)
  if (!s) return
  s.lastStatus = status
  save(file)
}

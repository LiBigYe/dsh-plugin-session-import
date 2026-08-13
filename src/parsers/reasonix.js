/**
 * reasonix 会话解析器。
 * 输入：~/.reasonix/sessions/code-*.jsonl（+ 同名 .meta.json 取 workspace）
 * 输出：{ messages: [...], cwd: string | undefined }
 */
import { readFileSync, existsSync } from 'node:fs'

function mapBlock(block) {
  if (block.type === 'tool-call') {
    return { type: 'tool-call', id: block.id ?? `t-${Math.random().toString(36).slice(2, 8)}`, name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) }
  }
  if (block.type === 'tool-result') {
    return { type: 'tool-result', toolCallId: block.toolCallId, content: [{ type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '') }] }
  }
  return { type: 'text', text: block.text ?? JSON.stringify(block) }
}

export function parseReasonix(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  const messages = []
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const role = record.role
    if (role !== 'user' && role !== 'assistant') continue

    const content = []
    if (record.content) content.push({ type: 'text', text: typeof record.content === 'string' ? record.content : JSON.stringify(record.content) })
    if (record.reasoning_content) content.push({ type: 'reasoning', text: typeof record.reasoning_content === 'string' ? record.reasoning_content : JSON.stringify(record.reasoning_content) })
    if (Array.isArray(record.tool_calls)) {
      for (const tc of record.tool_calls) {
        content.push({ type: 'tool-call', id: tc.id ?? `t-${Math.random().toString(36).slice(2, 8)}`, name: tc.function?.name ?? 'tool', arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}) })
      }
    }

    // workspace 从同名 .meta.json 读
    let cwd
    if (!cwd) {
      const metaPath = filePath.replace(/\.jsonl$/, '.meta.json')
      if (existsSync(metaPath)) {
        try { cwd = JSON.parse(readFileSync(metaPath, 'utf8')).workspace } catch { /* 忽略 */ }
      }
    }

    messages.push({ role, content, cwd })
  }
  // 汇总 cwd（任意一条消息带上的）
  const cwd = messages.find((m) => m.cwd)?.cwd
  for (const m of messages) delete m.cwd
  return { messages, cwd }
}

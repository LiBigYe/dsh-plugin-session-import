/**
 * codex 会话解析器。
 * 输入：~/.codex/sessions 下的 rollout-*.jsonl
 * 输出：{ messages: [...], cwd: string | undefined }
 * 兼容新旧两种响应格式：
 *  - 新（Codex desktop / 2026+）：response_item 含 custom_tool_call / custom_tool_call_output
 *  - 旧：function_call / function_call_output
 */
import { readFileSync } from 'node:fs'

function mapBlock(block) {
  switch (block.type) {
    case 'input_text':
    case 'output_text':
    case 'text':
    case 'summary_text':
      return { type: 'text', text: block.text ?? '' }
    case 'tool_call':
      return { type: 'tool-call', id: block.id, name: block.name ?? 'tool', arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) }
    case 'tool_use':
      return { type: 'tool-call', id: block.id, name: block.name, arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}) }
    case 'function_call':
      return { type: 'tool-call', id: block.call_id ?? block.id, name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}) }
    case 'function_call_output':
      return { type: 'tool-result', toolCallId: block.call_id, content: mapBlocks(block.output) }
    case 'reasoning':
      return { type: 'reasoning', text: block.summary ?? block.text ?? '' }
    default:
      return { type: 'text', text: `[${block.type}] ` + JSON.stringify(block) }
  }
}

/** content 可能是数组（block 列表）或字符串 */
function mapBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content ?? '') }]
  return content.map(mapBlock)
}

/**
 * 从 codex 工具调用的 input 提取真正的参数 JSON。
 * codex（opencode）的 custom_tool_call.input 是 JS 代码字符串，
 * 形如 `tools.exec_command({cmd: "...", workdir: "..."})`、
 * `const r = await tools.exec_command({...}); text(r.output)` 或
 * `Promise.all([tools.exec_command({...}), ...])`（并行多调用）。
 * 直接当 arguments 传给模型会让模型学到错误的工具调用格式（JS/XML 混合）。
 * 提取第一个 `exec_command({...})` 的对象字面量转成 JSON；提取失败回退原字符串。
 */
function extractToolArguments(p) {
  const raw = typeof p.arguments === 'string' ? p.arguments : (typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? {}))
  if (typeof raw !== 'string') return raw
  // 只处理 exec_command 调用形态；其他（Patch / ALL_TOOLS 动态调用等 codex 专属格式）
  // 不做对象提取——patch 内容里的 { 会误导定位，且这些参数本就不该进模型
  if (!raw.includes('exec_command(')) {
    return JSON.stringify({ note: 'codex 内部工具调用（参数为 JS 代码，未转换）' })
  }
  // 定位 exec_command( 后的对象字面量
  let start = raw.indexOf('exec_command(')
  start = raw.indexOf('{', start)
  if (start === -1) return JSON.stringify({ note: 'codex 内部工具调用（参数为 JS 代码，未转换）' })
  let depth = 0, end = -1
  let inStr = false, strCh = ''
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === strCh) inStr = false
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end === -1) return raw
  const objText = raw.slice(start, end + 1)
  try {
    // JS 对象字面量 → JSON：键名加引号、反引号/单引号转双引号、去尾逗号
    const jsonText = objText
      .replace(/`/g, '"')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/,\s*}/g, '}')
    const parsed = JSON.parse(jsonText)
    return JSON.stringify(parsed)
  } catch {
    try { return JSON.stringify(JSON.parse(objText)) } catch {
      // 提取失败：参数是 codex 专属 JS（Patch / ALL_TOOLS 动态调用等）。
      // 不能把 JS 代码当 arguments 传给模型（会污染工具调用格式），降级为描述文本
      return JSON.stringify({ note: 'codex 内部工具调用（参数为 JS 代码，未转换）' })
    }
  }
}

export function parseCodex(filePath) {
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  const messages = []
  let cwd
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    const t = record.type
    const p = record.payload ?? {}

    if (t === 'session_meta' || t === 'turn_context') {
      if (!cwd && p.cwd) cwd = p.cwd
      continue
    }
    if (t !== 'response_item') continue

    const itemType = p.type
    const role = p.role
    const content = mapBlocks(p.content)
    if (itemType === 'message') {
      if (role === 'developer') {
        // 系统指令跳过（含沙箱权限说明等）
        continue
      }
      if (role === 'user') {
        // 过滤 codex 注入的环境上下文消息（<environment_context>）
        const text = content.map((b) => b.text ?? '').join('')
        if (text.includes('<environment_context>')) continue
        messages.push({ role: 'user', content })
      } else if (role === 'assistant') {
        messages.push({ role: 'assistant', content, model: p.model ?? 'codex' })
      }
    } else if (itemType === 'function_call' || itemType === 'tool_call' || itemType === 'custom_tool_call') {
      // 工具调用：call_id 优先（新格式），name + arguments/input
      const callId = p.call_id ?? p.id
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: callId,
          name: p.name ?? 'tool',
          arguments: extractToolArguments(p),
        }],
      })
    } else if (itemType === 'function_call_output' || itemType === 'tool_call_output' || itemType === 'custom_tool_call_output') {
      // 工具结果
      messages.push({
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: p.call_id ?? p.id, content: mapBlocks(p.output) }],
      })
    }
  }
  return { messages, cwd }
}

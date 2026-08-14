/**
 * codex 解析器单元测试：验证 exec_command JS 参数转 JSON、环境上下文过滤、工具调用配对
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCodex } from './src/parsers/codex.js'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'codex-test-'))
const file = join(dir, 'sessions.jsonl')
const cleanup = () => rmSync(dir, { recursive: true, force: true })

try {
  // mock codex 会话：session_meta + user 消息（含环境上下文过滤）+ assistant 文本 + 工具调用 + 结果
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { cwd: 'C:/proj' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我读文件' }] } }),
    // 环境上下文应被过滤
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>这是注入</environment_context>' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的' }], model: 'codex-1' } }),
    // exec_command 工具调用（JS 对象字面量参数）
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec_command', input: "tools.exec_command({cmd: 'dir', cwd: 'C:/proj'})" } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'output_text', text: '文件列表' }] } }),
    // 非 exec_command 工具（patch）应降级为 note
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: "tools.apply_patch({patch: 'diff'})" } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'ok' } }),
  ]
  writeFileSync(file, lines.join('\n'))

  const { messages, cwd } = parseCodex(file)

  check('cwd 解析', cwd === 'C:/proj', cwd)
  check('环境上下文被过滤（user 只有 1 条真实消息）', messages.filter(m => m.role === 'user' && m.content.some(b => b.type === 'text')).length === 1)
  check('assistant 文本保留', messages.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'text' && b.text === '好的')))

  const call1 = messages.find(m => m.content?.some(b => b.type === 'tool-call' && b.id === 'call-1'))
  const args1 = call1 ? JSON.parse(call1.content.find(b => b.id === 'call-1').arguments) : null
  check('exec_command 参数转 JSON', args1 && args1.cmd === 'dir' && args1.cwd === 'C:/proj', JSON.stringify(args1))
  check('exec_command 参数不含 JS 代码', call1 && !call1.content.find(b => b.id === 'call-1').arguments.includes('tools.exec_command'))

  const call2 = messages.find(m => m.content?.some(b => b.type === 'tool-call' && b.id === 'call-2'))
  const args2 = call2 ? JSON.parse(call2.content.find(b => b.id === 'call-2').arguments) : null
  check('非 exec_command 降级为 note', args2 && args2.note?.includes('未转换'), JSON.stringify(args2))

  const results = messages.filter(m => m.role === 'user' && m.content?.some(b => b.type === 'tool-result'))
  check('工具结果配对（2 个）', results.length === 2)
} finally {
  cleanup()
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

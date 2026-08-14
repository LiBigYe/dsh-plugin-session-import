/**
 * reasonix 解析器单元测试：JSONL 消息解析、tool_calls 转换、workspace 读取
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseReasonix } from './src/parsers/reasonix.js'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

const dir = mkdtempSync(join(tmpdir(), 'reasonix-test-'))
const file = join(dir, 'code-test.jsonl')
const metaFile = join(dir, 'code-test.meta.json')

try {
  writeFileSync(metaFile, JSON.stringify({ workspace: 'C:/reasonix-proj' }))
  const lines = [
    JSON.stringify({ role: 'user', content: '帮我查一下' }),
    JSON.stringify({ role: 'assistant', content: '好的', reasoning_content: '思考中', tool_calls: [{ id: 'tc1', function: { name: 'read', arguments: '{"file":"a.txt"}' } }] }),
    JSON.stringify({ role: 'system', content: '系统消息' }), // 应被忽略
  ]
  writeFileSync(file, lines.join('\n'))

  const { messages, cwd } = parseReasonix(file)

  check('cwd 从 meta.json 读取', cwd === 'C:/reasonix-proj', cwd)
  check('system 消息被忽略', messages.length === 2, `len=${messages.length}`)
  check('user 消息保留', messages.some(m => m.role === 'user' && m.content[0]?.text === '帮我查一下'))
  const asst = messages.find(m => m.role === 'assistant')
  check('assistant reasoning 保留', asst?.content?.some(b => b.type === 'reasoning' && b.text === '思考中'))
  const call = asst?.content?.find(b => b.type === 'tool-call')
  check('tool-call 转换（id/name/args）', call?.id === 'tc1' && call?.name === 'read' && call?.arguments === '{"file":"a.txt"}')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

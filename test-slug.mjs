/**
 * decodeSlugPath 单元测试：reasonix slug → 真实路径的贪心解码
 * 通过构造临时目录验证（slug 带 c-- 盘符前缀）
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeSlugPath } from './src/index.js'

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('PASS', name) } else { fail++; console.log('FAIL', name, extra) }
}

const root = mkdtempSync(join(tmpdir(), 'slug-test-'))
try {
  const cwd = process.cwd()
  const testDir = join(cwd, '.slug-test-dir')
  mkdirSync(testDir, { recursive: true })

  // slug 带 c-- 前缀，从 c:\ 根开始编码
  const rel = cwd.replace(/^[A-Za-z]:[\\/]/, '').split(/[\\/]/).filter(Boolean)
  const slug = 'c--' + rel.concat(['.slug-test-dir']).join('-')
  const decoded = decodeSlugPath(slug)
  const expected = testDir.replace(/[\\/]+$/, '')
  check('带连字符目录解码成功', decoded?.toLowerCase() === expected.toLowerCase(), `slug=${slug}\n  decoded=${decoded}\n  expect=${expected}`)

  // 不存在路径返回 undefined（修复的 bug）
  const bad = decodeSlugPath('c--no-such-dir-xyz-12345')
  check('不存在路径返回 undefined', bad === undefined, `bad=${bad}`)

  // 空/异常输入不抛错
  let threw = false
  try { decodeSlugPath('') } catch { threw = true }
  check('空输入不抛错', !threw)

  // 非法 slug（无盘符前缀但路径不存在）返回 undefined
  const noPrefix = decodeSlugPath('no-such-dir-xyz-12345')
  check('无前缀且不存在返回 undefined', noPrefix === undefined, `noPrefix=${noPrefix}`)

  rmSync(testDir, { recursive: true, force: true })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

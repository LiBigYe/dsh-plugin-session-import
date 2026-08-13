/**
 * 构建脚本：生成 lib/ 发布产物（官方格式）。
 * - lib/index.js   host 端（ESM，bundle parsers + converter）
 * - lib/client.js  client bundle（CJS + __ModuleLoader__.load 包装，官方格式）
 */
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'

const ID = 'dsh-plugin-session-import'
rmSync('lib', { recursive: true, force: true })
mkdirSync('lib', { recursive: true })

// 1. host 端：ESM bundle（parsers + to-session-events 内联）
execSync(
  `npx esbuild src/index.js --bundle --format=esm --platform=node --target=es2022 ` +
  `--external:node:fs --external:node:path --external:node:sqlite --external:@deepseek-ai/* ` +
  `--outfile=lib/index.js`,
  { stdio: 'inherit' })

// 2. client bundle：CJS + load 包装（官方 banner/footer 格式）
const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`
const footer = `return module.exports; } });`
execSync(
  `npx esbuild src/client-source.js --bundle --format=cjs --platform=browser --target=es2022 ` +
  `--external:react --external:react/jsx-runtime --external:@deepseek-ai/* ` +
  `--banner:js=${JSON.stringify(banner)} --footer:js=${JSON.stringify(footer)} ` +
  `--outfile=lib/client.js`,
  { stdio: 'inherit' })

// 3. 校验产物
const host = readFileSync('lib/index.js', 'utf8')
const client = readFileSync('lib/client.js', 'utf8')
if (!client.includes('__ModuleLoader__.load')) throw new Error('client bundle 缺 load 包装')
if (!host.includes('discoverSessions')) throw new Error('host bundle 缺 discoverSessions')
console.log('构建完成：lib/index.js + lib/client.js')
console.log('host:', host.length, 'bytes | client:', client.length, 'bytes')

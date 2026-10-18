/**
 * 由同目录的 host-e2e.mjs 生成「打包产物版」端到端 harness：
 * 不再对源码做 shim，而是把 lib/host.js 与 lib/typert.js 复制到带桩 node_modules 的目录里导入，
 * 验证真正要发布/安装的产物。可换目标包：DSH_TODO_PLUGIN_DIR=<包目录>。
 *
 * 用法（在本目录下执行）：
 *   node mk-bundle-e2e.mjs                        # 生成 host-e2e-bundle.mjs（默认对着源码包）
 *   node mk-bundle-e2e.mjs --out _bundle.mjs
 *   DSH_TODO_PLUGIN_DIR=<包目录> node host-e2e-bundle.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const src = fs.readFileSync(path.join(HERE, 'host-e2e.mjs'), 'utf8')

const rep = (from, to, text) => {
  if (!text.includes(from)) throw new Error('未找到待替换片段：' + from.slice(0, 60))
  return text.replace(from, to)
}

let out = src

out = rep(
  `const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh-todo')`,
  `const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh-todo')
const ROOT_DIR = PLUGIN`,
  out,
)

out = rep(
  `const STORE_TMP = path.join(PLUGIN, '_h_store.mjs')
const HOST_TMP = path.join(PLUGIN, '_h_host.mjs')`,
  `const ROOT_TMP = path.join(os.tmpdir(), 'dsh-todo-e2e-bundle')
const BUNDLE_DIR = path.join(ROOT_TMP, 'bundle')
const HOST_TMP = path.join(BUNDLE_DIR, 'host.js')
const TYPERT_TMP = path.join(BUNDLE_DIR, 'typert.js')`,
  out,
)

const shimBlock = `// 生成 shim（zod 从插件 node_modules 解析；defineDomain/defineTool 用恒等替代）
let storeSrc = fs.readFileSync(path.join(PLUGIN, 'host', 'store.js'), 'utf8')
storeSrc = storeSrc.replace("import { defineDomain } from '@deepseek-ai/dsh-storage-domain'", 'const defineDomain = (spec) => spec')
fs.writeFileSync(STORE_TMP, storeSrc, 'utf8')
let hostSrc = fs.readFileSync(path.join(PLUGIN, 'host', 'index.js'), 'utf8')
hostSrc = hostSrc.replaceAll("'./store.js'", "'./_h_store.mjs'")
// shim 落在包根（PLUGIN/_h_host.mjs），源码里的 '../shared/export-core.js' 要改成本层相对路径
hostSrc = hostSrc.replaceAll("'../shared/export-core.js'", "'./shared/export-core.js'")
hostSrc = hostSrc.replace("import { defineTool } from '@deepseek-ai/dsh-tools'", 'const defineTool = (spec) => spec')
fs.writeFileSync(HOST_TMP, hostSrc, 'utf8')`

const bundleBlock = `// 直接用「打包后的真实产物」：把 lib/host.js、lib/typert.js 复制进带桩 node_modules 的目录，
// 让产物里 external 的 @deepseek-ai/* 裸导入解析到桩（zod 已内联，无需桩）。
fs.rmSync(ROOT_TMP, { recursive: true, force: true })
fs.mkdirSync(BUNDLE_DIR, { recursive: true })
for (const [dir, body] of [
  ['dsh-tools', 'export const defineTool = (spec) => spec\\n'],
  ['dsh-storage-domain', 'export const defineDomain = (spec) => spec\\n'],
]) {
  const d = path.join(ROOT_TMP, 'node_modules', '@deepseek-ai', dir)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + dir, version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2), 'utf8')
  fs.writeFileSync(path.join(d, 'index.js'), body, 'utf8')
}
if (!fs.existsSync(path.join(PLUGIN, 'lib', 'host.js'))) throw new Error('缺少打包产物 lib/host.js，请先跑 node scripts/build-host.mjs')
fs.copyFileSync(path.join(PLUGIN, 'lib', 'host.js'), HOST_TMP)
fs.copyFileSync(path.join(PLUGIN, 'lib', 'typert.js'), TYPERT_TMP)`

out = rep(shimBlock, bundleBlock, out)

out = rep(
  `const STATE_DIR = path.join(os.tmpdir(), \`dsh-todo-e2e-\${Date.now()}\`)`,
  `const STATE_DIR = path.join(os.tmpdir(), \`dsh-todo-e2e-\${Date.now()}\`)`,
  out,
)

out = rep(
  `fs.rmSync(STORE_TMP, { force: true })
fs.rmSync(HOST_TMP, { force: true })`,
  `fs.rmSync(ROOT_TMP, { recursive: true, force: true })`,
  out,
)

const fBlock = `// ---------- F. 打包产物自检 ----------
const pkgName = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).name
const typertMod = await import(pathToFileURL(TYPERT_TMP).href)
check('F1 typert 产物导出 TYPERT 对象', typeof typertMod.TYPERT === 'object' && typertMod.TYPERT !== null)
check('F2 manifest.package 等于包名（loader 强校验）', typertMod.TYPERT.package === pkgName, \`\${typertMod.TYPERT.package} vs \${pkgName}\`)
check('F3 face=host 且 invocations 为数组', typertMod.TYPERT.face === 'host' && Array.isArray(typertMod.TYPERT.invocations), \`\${typertMod.TYPERT.invocations.length} 个\`)
check('F4 打包产物不含裸 zod 导入', !/\\bfrom\\s*["']zod["']/.test(fs.readFileSync(path.join(PLUGIN, 'lib', 'host.js'), 'utf8')))
check('F5 打包产物无运行时依赖（package.json dependencies 为空）', !JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).dependencies)

const failed = results.filter((r) => !r.ok)`

out = rep('const failed = results.filter((r) => !r.ok)', fBlock, out)

const outName = process.argv[process.argv.indexOf('--out') + 1] && process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'host-e2e-bundle.mjs'
const outPath = path.join(HERE, outName)
fs.writeFileSync(outPath, out, 'utf8')
console.log('generated', outPath, out.length, 'bytes')

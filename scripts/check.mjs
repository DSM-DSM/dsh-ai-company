// 公开发布前静态检查：语法、文档锚点、必需内核和本机绑定扫描。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const pathOf = (relative) => join(root, relative)
const required = [
  'entry.js', 'index.js', 'cordis.patch.yml', 'src/runtime.js', 'src/store.js',
  'vendor/dsh-superagent/lib/company-kernel.js',
  'LICENSE', 'NOTICE', 'PROVENANCE.md', 'SECURITY.md',
]
for (const file of required) {
  if (!existsSync(pathOf(file))) throw new Error(`缺少发布必需文件：${file}`)
}
const kernelEntry = readFileSync(pathOf('vendor/dsh-superagent/lib/company-kernel.js'), 'utf8')
const kernelImports = [...kernelEntry.matchAll(/from "(\.\/[^"]+\.js)"/g)].map((match) => match[1])
for (const file of kernelImports) {
  if (!existsSync(pathOf(`vendor/dsh-superagent/lib/${file.slice(2)}`))) throw new Error(`company-kernel 引用了不存在的 chunk：${file}`)
}

const syntaxFiles = [
  'entry.js', 'index.js',
  ...readdirSync(pathOf('src')).filter((file) => file.endsWith('.js')).map((file) => `src/${file}`),
]
for (const file of syntaxFiles) {
  const result = spawnSync(process.execPath, ['--check', pathOf(file)], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${file} 语法检查失败：${result.stderr}`)
}

for (const file of ['package.json', 'locale/en.json', 'locale/zh.json']) JSON.parse(readFileSync(pathOf(file), 'utf8'))

const readme = readFileSync(pathOf('README.zh-CN.md'), 'utf8')
const anchors = [...readme.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1])
const tocBlock = readme.split('## 目录')[1]?.split('<a id="sec-1"></a>')[0] ?? ''
const links = [...tocBlock.matchAll(/\]\(#([^\)]+)\)/g)].map((match) => match[1])
const missing = links.filter((link) => !anchors.includes(link))
if (missing.length) throw new Error(`README 目录锚点缺失：${missing.join(', ')}`)
if (new Set(anchors).size !== anchors.length) throw new Error('README 存在重复锚点')

const ownFiles = [
  ...readdirSync(pathOf('src')).filter((file) => file.endsWith('.js')).map((file) => `src/${file}`),
  'entry.js', 'index.js', 'cordis.patch.yml', 'examples/profile.cordis.patch.yml',
]
const forbidden = [
  /C:\/Users\/YJY/iu,
  /D:\/AI-Company/iu,
  /F:\/MDS-ED/iu,
  /casdao/iu,
  /session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
  /sk-[A-Za-z0-9]{20,}/u,
  /\.credentials\.yaml/iu,
]
for (const file of ownFiles) {
  const text = readFileSync(pathOf(file), 'utf8')
  for (const pattern of forbidden) {
    if (pattern.test(text)) throw new Error(`公开源码疑似含本机/内部绑定：${file} 命中 ${pattern}`)
  }
}

console.log(`STATIC_OK required=${required.length} syntax=${syntaxFiles.length} anchors=${links.length} ownFiles=${ownFiles.length}`)

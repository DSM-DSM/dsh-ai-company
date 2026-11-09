// 核对 npm pack 的真实文件清单，防止 .gitignore 把运行内核排除。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const windows = process.platform === 'win32'
const result = spawnSync(windows ? 'cmd.exe' : 'npm', windows
  ? ['/d', '/s', '/c', 'npm', 'pack', '--dry-run', '--json']
  : ['pack', '--dry-run', '--json'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
})
if (result.status !== 0) throw new Error(result.stderr || 'npm pack --dry-run 失败')
const [manifest] = JSON.parse(result.stdout)
const paths = new Set(manifest.files.map((file) => file.path))
const root = fileURLToPath(new URL('..', import.meta.url))
const kernelEntry = readFileSync(join(root, 'vendor/dsh-superagent/lib/company-kernel.js'), 'utf8')
const kernelImports = [...kernelEntry.matchAll(/from "(\.\/[^"]+\.js)"/g)].map((match) => `vendor/dsh-superagent/lib/${match[1].slice(2)}`)
const required = [
  'entry.js',
  'vendor/dsh-superagent/lib/company-kernel.js',
  ...kernelImports,
  'vendor/dsh-superagent/LICENSE',
]
const missing = required.filter((file) => !paths.has(file))
if (missing.length) throw new Error(`打包缺少：${missing.join(', ')}`)
const forbidden = [...paths].filter((file) => /(?:^|\/)(?:node_modules|\.git|data|runtime|artifacts)(?:\/|$)|\.sqlite(?:-|$)|\.jsonl$|\.bak|\.env$/u.test(file))
if (forbidden.length) throw new Error(`打包含运行态或敏感文件：${forbidden.join(', ')}`)
console.log(`PACK_OK files=${manifest.entryCount} packedBytes=${manifest.size} unpackedBytes=${manifest.unpackedSize}`)

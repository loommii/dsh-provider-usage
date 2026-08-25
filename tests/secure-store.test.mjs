// 私有加密凭证库单测（临时目录，零依赖）：密钥生成/权限、加解密 round-trip、明文不落盘、重启复用。
import { createSecureStore } from '../lib/secure-store.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'

let passed = 0
let failed = 0
function assert(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name) }
  else { failed++; console.error('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra) : '')) }
}

const dir = mkdtempSync(join(tmpdir(), 'pu-sec-'))
const store = createSecureStore(dir)
await store.init()

const keyStat = await stat(join(dir, 'secret.key'))
assert((keyStat.mode & 0o777) === 0o600, '密钥文件 0600')
const credStat = await stat(join(dir, 'credentials.json'))
assert((credStat.mode & 0o777) === 0o600, '凭证文件 0600')

await store.set('MY_KEY_1', 'sk-secret-value-123')
assert((await store.get('MY_KEY_1')) === 'sk-secret-value-123', '加解密 round-trip')
const raw = await readFile(join(dir, 'credentials.json'), 'utf8')
assert(!raw.includes('sk-secret-value-123'), '落盘内容不含明文')

await store.set('MY_KEY_2', 'another-secret')
assert((await store.get('MY_KEY_1')) === 'sk-secret-value-123' && (await store.get('MY_KEY_2')) === 'another-secret', '多 ref 独立')
assert((await store.list()).length === 2 && (await store.has('MY_KEY_1')), 'list/has')
await store.remove('MY_KEY_1')
assert(!(await store.has('MY_KEY_1')), 'remove 后消失')

// 同值不同 ref 密文不同（IV 随机）
await store.set('SAME_A', 'x')
await store.set('SAME_B', 'x')
const raw2 = await readFile(join(dir, 'credentials.json'), 'utf8')
const tA = raw2.match(/"SAME_A": "([^"]+)"/)[1]
const tB = raw2.match(/"SAME_B": "([^"]+)"/)[1]
assert(tA !== tB, '同值密文不同（IV 随机）')

// 重启（新实例同目录）密钥复用可解密
const store2 = createSecureStore(dir)
await store2.init()
assert((await store2.get('MY_KEY_2')) === 'another-secret', '同目录密钥复用')

if (failed > 0) { console.error('\nFAILED: ' + failed + ' 项'); process.exit(1) }
console.log('\nPASSED: ' + passed + ' 项全部通过')
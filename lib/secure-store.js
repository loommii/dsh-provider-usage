// dsh-provider-usage — 私有加密凭证库（方案 B，2026-08-24 用户决策）。
// 用途：用户"手动填写"的 AI Key 加密落盘，不写入 DSH 全局凭证表。
// 布局：
//   $DSH_HOME/provider-usage/secret.key     —— AES-256 密钥（随机生成一次，0600）
//   $DSH_HOME/provider-usage/credentials.json —— {version, credentials:{ref: ciphertext}}（0600）
// 加密：AES-256-GCM，密文格式 v1:<b64(iv)>:<b64(authTag)>:<b64(data)>
// 边界（与 DSH 凭证同款）：0600 挡其他 OS 用户；同一用户的其它进程（含 agent）
// 理论上仍可读——更强隔离需 OS 钥匙串（DSH 官方路线图延后项）。

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'

const KEY_FILENAME = 'secret.key'
const CRED_FILENAME = 'credentials.json'
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 计算 $DSH_HOME/provider-usage 目录：优先 DSH_HOME，回落 ~/.dsh。 */
export function resolveProviderUsageDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'provider-usage')
}

/** 解析一个 ref 是否为合法凭证引用名。 */
export function isValidRefName(name) {
  return typeof name === 'string' && REF_PATTERN.test(name)
}

function encrypt(key, value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + data.toString('base64')
}

function decrypt(key, token) {
  const parts = String(token).split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad ciphertext format')
  const iv = Buffer.from(parts[1], 'base64')
  const tag = Buffer.from(parts[2], 'base64')
  const data = Buffer.from(parts[3], 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

async function readJson(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const doc = JSON.parse(raw)
    if (doc && doc.version === 1 && doc.credentials && typeof doc.credentials === 'object') return doc
  } catch (e) { /* missing/corrupt → 空库 */ }
  return { version: 1, credentials: {} }
}

async function writeJson(file, doc) {
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  await chmod(tmp, 0o600)
  // 尽力原子换名；失败时直接写目标
  try { await (await import('node:fs/promises')).rename(tmp, file) } catch (e) { await writeFile(file, JSON.stringify(doc, null, 2), { mode: 0o600 }) }
  await chmod(file, 0o600)
}

/**
 * 私有加密凭证库实例。
 * init()：建目录(0700)、生成密钥(0600)、种子空库(0600)。密钥永久复用，丢失即无法解密。
 */
export function createSecureStore(dir) {
  let key = null
  const keyFile = join(dir, KEY_FILENAME)
  const credFile = join(dir, CRED_FILENAME)
  // 文档内存缓存：has/get/list 不再每次读盘+解析；所有写路径同步更新缓存。
  let docCache = null
  let docLoaded = false

  async function doc() {
    if (!docLoaded) { docCache = await readJson(credFile); docLoaded = true }
    return docCache
  }

  async function writeDoc(next) {
    docCache = next
    await writeJson(credFile, next)
  }

  async function init() {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(keyFile, 'utf8')
      key = Buffer.from(raw.trim(), 'base64')
      if (key.length !== 32) throw new Error('bad key length')
    } catch (e) {
      key = randomBytes(32)
      await writeFile(keyFile, key.toString('base64') + '\n', { mode: 0o600 })
      await chmod(keyFile, 0o600)
    }
    await writeDoc(await readJson(credFile))
  }

  async function set(ref, value) {
    const d = await doc()
    d.credentials[ref] = encrypt(key, value)
    await writeDoc(d)
  }

  async function get(ref) {
    const d = await doc()
    const token = d.credentials[ref]
    if (!token) return null
    try { return decrypt(key, token) } catch (e) { return null }
  }

  async function has(ref) {
    const d = await doc()
    return Object.prototype.hasOwnProperty.call(d.credentials, ref)
  }

  async function list() {
    const d = await doc()
    return Object.keys(d.credentials)
  }

  async function remove(ref) {
    const d = await doc()
    if (Object.prototype.hasOwnProperty.call(d.credentials, ref)) {
      delete d.credentials[ref]
      await writeDoc(d)
    }
  }

  return { dir, keyFile, credFile, init, set, get, has, list, remove, isValidRefName }
}
// dsh-provider-usage — 按天物化的本地 Token 统计存储（v0.5.0，用户决策 2026-08-26）。
// 位置：$DSH_HOME/provider-usage/daily-stats/YYYY-MM-DD.json（单文件=单天，0600，原子写）。
// 语义：昨天及以前 = 封存（sealed，永不再算，deps mtime 校验兜底 compaction 改写）；只有今天重算，
//       且今天只扫描"今天变过的会话文件"（mtime >= 今天零点 - 1h 缓冲），历史文件零读取。

import { join } from 'node:path'
import { promises as fs } from 'node:fs'
import { init as zstdInit, decompress as zstdWasmDec } from '@bokuweb/zstd-wasm'
import { decompress as zstdFzDec } from 'fzstd'

// v2（v0.7.0）：byModel 升级为按提供方嵌套 { 提供方: { 模型: 计数 } }；v1 为扁平 { 模型: 计数 }。
// .backfilled 哨兵按版本判定：v1 哨兵会触发一次性全量重折（从会话文件恢复提供方归属）。
export const DAILY_VERSION = 2

/** 本地时区日期键：YYYY-MM-DD。 */
export function dayKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/** 日期键对应本地时区当天零点（ms）。 */
export function dayStartMs(day) {
  const parts = day.split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime()
}

/** 日期键 +N 天（可为负）。 */
export function addDays(day, n) {
  return dayKey(dayStartMs(day) + n * 86400000)
}

/** 返回 [from, …到 to]（含）的日期键数组。 */
export function dayRange(from, to) {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** 扫描会话目录（深度 ≤2）收集所有 session.jsonl.zstd；minMtimeMs 过滤后按 mtime 降序取前 limit。 */
export async function scanSessionFiles(dir, limit, minMtimeMs) {
  const found = []
  async function walk(d, depth) {
    let entries
    try { entries = await fs.readdir(d, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      if (ent.isFile() && ent.name === 'session.jsonl.zstd') { found.push(join(d, ent.name)); continue }
      if (ent.isDirectory() && depth < 2) await walk(join(d, ent.name), depth + 1)
    }
  }
  await walk(dir, 0)
  const meta = await Promise.all(found.map(async (f) => {
    try { const st = await fs.stat(f); return { path: f, mtimeMs: st.mtimeMs, size: st.size } } catch { return null }
  }))
  let list = meta.filter(Boolean)
  if (typeof minMtimeMs === 'number' && minMtimeMs > 0) list = list.filter((m) => m.mtimeMs >= minMtimeMs)
  list.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return list.slice(0, (typeof limit === 'number' && limit > 0) ? limit : list.length)
}

// ── 解码层：DSH 会话文件 = 多帧 zstd（每次 flush 一帧），支持按帧增量解码 ──
// 主解码器 @bokuweb/zstd-wasm（帧级快 20 倍；个别大帧不支持），失败帧回退 fzstd（正确性兜底）；
// 测试注入 identity（文件内容直接存明文 JSONL，整段视为一帧）。
let identityDecoder = null
let wasmReady = false
export async function initDecoder() {
  if (!identityDecoder && !wasmReady) {
    if (process.env.DSH_PROVIDER_USAGE_TEST !== '1') await zstdInit()
    wasmReady = true
  }
}
export function _setDecoderForTests(fn) {
  identityDecoder = fn || null
  wasmReady = !!fn
}

/** 解一个字节区间（单帧）为文本；wasm 失败自动回退 fzstd。 */
function decodeFrameBytes(buf) {
  try {
    if (identityDecoder) return identityDecoder(buf).toString('utf8')
    try {
      if (wasmReady) return Buffer.from(zstdWasmDec(new Uint8Array(buf))).toString('utf8')
    } catch { /* 大帧回退 */ }
    return Buffer.from(zstdFzDec(buf)).toString('utf8')
  } catch { return '' }
}


/** zstd frame magic（小端 28 B5 2F FD）。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 扫描 buf 中所有帧起始偏移；找不到任何 magic 时把整段视为一帧（identity 模式）。 */
export function splitFrames(buf) {
  const frames = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) frames.push(i)
  }
  if (frames.length === 0) return buf.length > 0 ? [{ start: 0, end: buf.length }] : []
  const out = []
  for (let i = 0; i < frames.length; i++) {
    out.push({ start: frames[i], end: i + 1 < frames.length ? frames[i + 1] : buf.length })
  }
  return out
}


/** 全量解码（所有帧串联）→ 文本；失败返回 null。 */
export async function readSessionFile(path) {
  try {
    const raw = await fs.readFile(path)
    const frames = splitFrames(raw)
    let text = ''
    for (const f of frames) text += decodeFrameBytes(raw.subarray(f.start, f.end))
    return text || null
  } catch { return null }
}

/** 增量解码：只解 prevOffset 之后的新帧。
 * 返回 { text（新事件的文本，可能为空串）, changed(bool), total（当前文件大小） }；
 * 无法按偏移衔接（异常）时 changed=false，调用方应回退全量。 */
export async function readSessionFileFrom(path, prevOffset) {
  try {
    const raw = await fs.readFile(path)
    const prev = (typeof prevOffset === 'number' && prevOffset > 0) ? prevOffset : 0
    if (identityDecoder && prev > 0 && prev <= raw.length) {
      // 测试模式：整段即文本，新内容 = 追加部分
      return { text: Buffer.from(raw.subarray(prev)).toString('utf8'), changed: true, total: raw.length }
    }
    if (prev === 0 || prev >= raw.length) {
      return { text: null, changed: false, total: raw.length }
    }
    const frames = splitFrames(raw)
    let start = -1
    for (let i = 0; i < frames.length; i++) { if (frames[i].start >= prev) { start = i; break } }
    if (start < 0) return { text: null, changed: false, total: raw.length }
    let text = ''
    for (let i = start; i < frames.length; i++) text += decodeFrameBytes(raw.subarray(frames[i].start, frames[i].end))
    return { text, changed: true, total: raw.length }
  } catch { return { text: null, changed: false, total: 0 } }
}


/** 解析 JSONL 文本为事件数组（损坏行跳过）。 */
export function parseEvents(text) {
  const out = []
  if (!text) return out
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return out
}

/** 把事件流中落在 [dayStart, dayEnd) 的 assistant/message 记账折叠成按天 totals。
 * 归属：message.source.provider/model，缺失回退 request/header；targetProvider 为空 = 全部 provider；
 * 事件 time 缺失按当天计入（宽松）。返回 { byProvider, byModel }，键值含
 * { requests, inputTokens, outputTokens, cacheReadTokens }；
 * byModel 为按提供方嵌套：{ <provider>: { <model>: e } }（v0.7.0 起，支持按提供方过滤模型汇总）。 */
/** 内部：把一条记账累加到 byProvider/byModel 桶。 */
function bump(map, key, usage) {
  let e = map[key]
  if (!e) { e = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; map[key] = e }
  e.requests += 1
  e.inputTokens += Number(usage.inputTokens) || 0
  e.outputTokens += Number(usage.outputTokens) || 0
  e.cacheReadTokens += Number(usage.cacheReadTokens) || 0
}

/** 内部：解析一条事件的 provider/model 归属（source 优先，回退 header）。 */
function stepGuess(data, headerProvider, headerModel) {
  const message = data.message && typeof data.message === 'object' ? data.message : undefined
  const source = message && message.source && typeof message.source === 'object' ? message.source : undefined
  const stepProvider = source && typeof source.provider === 'string' ? source.provider : headerProvider
  const stepModel = source && typeof source.model === 'string' ? source.model : headerModel
  return { stepProvider, stepModel }
}

/** 把事件流中落在 [dayStart, dayEnd) 的 assistant/message 记账折叠成按天 totals。
 * 归属：message.source.provider/model，缺失回退 request/header；targetProvider 为空 = 全部 provider；
 * 事件 time 缺失按当天计入（宽松）。返回 { byProvider, byModel }，键值含
 * { requests, inputTokens, outputTokens, cacheReadTokens }。 */
export function foldEventsByDay(events, dayStart, dayEnd, targetProvider) {
  const target = (typeof targetProvider === 'string' && targetProvider.trim() !== '') ? targetProvider.trim() : null
  const byProvider = {}
  const byModel = {}
  let headerProvider = null
  let headerModel = null
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data
    if (!data || typeof data !== 'object') continue
    if (ev.type === 'request/header') {
      const conf = data.header && typeof data.header === 'object' ? data.header.config : undefined
      if (conf && typeof conf === 'object') {
        if (typeof conf.provider === 'string') headerProvider = conf.provider
        if (typeof conf.model === 'string') headerModel = conf.model
      }
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const usage = data.usage
    if (!usage || typeof usage !== 'object') continue
    if (typeof ev.time === 'number' && ev.time > 0) {
      if (ev.time < dayStart || ev.time >= dayEnd) continue
    }
    const guess = stepGuess(data, headerProvider, headerModel)
    if (target !== null && guess.stepProvider !== target) continue
    bump(byProvider, guess.stepProvider || 'unknown', usage)
    const provKey = guess.stepProvider || 'unknown'
    if (!byModel[provKey]) byModel[provKey] = {}
    bump(byModel[provKey], guess.stepModel || 'unknown', usage)
  }
  return { byProvider, byModel }
}

/** 把事件流按天分组折叠（首次全量回填用）：返回 { <YYYY-MM-DD>: { byProvider, byModel },
 * unknown: {...} }——time 缺失的事件归 unknown 桶。targetProvider 为空 = 全部 provider。
 * byModel 按提供方嵌套（v0.7.0 起，见 foldEventsByDay）。 */
export function foldEventsByDays(events, targetProvider) {
  const target = (typeof targetProvider === 'string' && targetProvider.trim() !== '') ? targetProvider.trim() : null
  const days = {}
  let headerProvider = null
  let headerModel = null
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const data = ev.data
    if (!data || typeof data !== 'object') continue
    if (ev.type === 'request/header') {
      const conf = data.header && typeof data.header === 'object' ? data.header.config : undefined
      if (conf && typeof conf === 'object') {
        if (typeof conf.provider === 'string') headerProvider = conf.provider
        if (typeof conf.model === 'string') headerModel = conf.model
      }
      continue
    }
    if (ev.type !== 'assistant/message') continue
    const usage = data.usage
    if (!usage || typeof usage !== 'object') continue
    const guess = stepGuess(data, headerProvider, headerModel)
    if (target !== null && guess.stepProvider !== target) continue
    const key = (typeof ev.time === 'number' && ev.time > 0) ? dayKey(ev.time) : 'unknown'
    let bucket = days[key]
    if (!bucket) { bucket = { byProvider: {}, byModel: {} }; days[key] = bucket }
    bump(bucket.byProvider, guess.stepProvider || 'unknown', usage)
    const provKey = guess.stepProvider || 'unknown'
    if (!bucket.byModel[provKey]) bucket.byModel[provKey] = {}
    bump(bucket.byModel[provKey], guess.stepModel || 'unknown', usage)
  }
  return days
}

/** 判断 byModel 是否为 v1 扁平形态（顶层直接是计数条目，无提供方层）。 */
export function isFlatByModel(map) {
  for (const k of Object.keys(map || {})) {
    const v = map[k]
    if (v && typeof v === 'object' && typeof v.requests === 'number') return true
  }
  return false
}

/** 把 src 的 byProvider/byModel 累加进 dst（同键相加）。
 * byModel 兼容 v0.6.1 扁平形态（{ <model>: e }，双向）：src 顶层条目并入 unknown 提供方桶，
 * dst 顶层条目迁移到 unknown 桶后再合并（旧天文件被今天的重算复写时保持形态一致）。 */
export function mergeTotals(dst, src) {
  if (!src) return
  if (!dst.byProvider || typeof dst.byProvider !== 'object') dst.byProvider = {}
  if (!dst.byModel || typeof dst.byModel !== 'object') dst.byModel = {}
  function mergeInto(map, srcMap) {
    for (const k of Object.keys(srcMap || {})) {
      const s = srcMap[k], t = map[k] || (map[k] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
      t.requests += s.requests || 0
      t.inputTokens += s.inputTokens || 0
      t.outputTokens += s.outputTokens || 0
      t.cacheReadTokens += s.cacheReadTokens || 0
    }
  }
  mergeInto(dst.byProvider, src.byProvider)
  if (isFlatByModel(dst.byModel)) {
    const legacy = dst.byModel
    dst.byModel = {}
    mergeInto(dst.byModel.unknown || (dst.byModel.unknown = {}), legacy)
  }
  for (const prov of Object.keys(src.byModel || {})) {
    const bucket = src.byModel[prov]
    if (!bucket || typeof bucket !== 'object') continue
    if (typeof bucket.requests === 'number') { mergeInto(dst.byModel.unknown || (dst.byModel.unknown = {}), { [prov]: bucket }); continue }
    if (!dst.byModel[prov] || typeof dst.byModel[prov] !== 'object' || typeof dst.byModel[prov].requests === 'number') {
      const legacy = dst.byModel[prov] && typeof dst.byModel[prov] === 'object' ? dst.byModel[prov] : null
      dst.byModel[prov] = legacy ? { unknown: legacy } : {}
    }
    mergeInto(dst.byModel[prov], bucket)
  }
}

/** 读某天文件；损坏/缺失返回 null。 */
export async function readDayFile(dir, day) {
  try {
    const raw = await fs.readFile(join(dir, day + '.json'), 'utf8')
    const data = JSON.parse(raw)
    return (data && typeof data === 'object') ? data : null
  } catch { return null }
}

/** 原子写某天文件（tmp + rename，0600）。 */
export async function writeDayFile(dir, day, data) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, '.' + day + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2))
  await fs.writeFile(tmp, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 })
  await fs.rename(tmp, join(dir, day + '.json'))
}

/** 会话文件解码游标（watermark）：path -> { offset, mtimeMs }，持久化到 daily-stats/cursors.json。 */
export async function loadCursors(dir) {
  try {
    const raw = await fs.readFile(join(dir, 'cursors.json'), 'utf8')
    const j = JSON.parse(raw)
    return (j && j.files && typeof j.files === 'object') ? j.files : {}
  } catch { return {} }
}
export async function saveCursors(dir, cursors) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, '.cursors.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2))
  await fs.writeFile(tmp, JSON.stringify({ version: 1, files: cursors }, null, 1) + '\n', { mode: 0o600 })
  await fs.rename(tmp, join(dir, 'cursors.json'))
}

/** 回填哨兵：标记"全量历史回填已完成且天文件为当前格式"（防止每次请求都重扫）。
 * v0.7.0 起（DAILY_VERSION=2）按哨兵内容版本判定：旧版写的 version 1 哨兵视为未完成，
 * 触发一次性全量重折，把 v1 扁平 byModel 天文件重算成嵌套形态（会话文件仍是事实源）。 */
export async function hasBackfilled(dir) {
  try {
    const raw = await fs.readFile(join(dir, '.backfilled'), 'utf8')
    const j = JSON.parse(raw)
    return !!(j && typeof j === 'object' && Number(j.version) >= DAILY_VERSION)
  } catch { return false }
}
export async function writeBackfilled(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(dir, '.backfilled'), JSON.stringify({ version: DAILY_VERSION, at: Date.now() }) + '\n', { mode: 0o600 })
}

/** 重置本地统计：删除全部派生数据（天文件/游标/回填哨兵/格式标记），不触碰会话原文。
 * 下一次 local-usage 查询会自动从会话文件重新全量回填。返回删除的天文件数。 */
export async function resetDailyStats(dir) {
  let removed = 0
  let names
  try { names = await fs.readdir(dir) } catch { return 0 }
  for (const n of names) {
    if (n === 'cursors.json' || n === '.backfilled' || n === '.format' || /^\.\d{4}-\d{2}-\d{2}\.tmp-/.test(n)) {
      try { await fs.rm(join(dir, n)); removed++; continue } catch { /* ignore */ }
    }
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n)) {
      try { await fs.rm(join(dir, n)); removed++ } catch { /* ignore */ }
    }
  }
  return removed
}

/** 校验 deps（path -> mtime）：返回变化的与缺失的路径。 */
export async function validateDeps(deps) {
  const changed = []
  const missing = []
  for (const [path, mtime] of Object.entries(deps || {})) {
    try {
      const st = await fs.stat(path)
      if (Math.abs(st.mtimeMs - Number(mtime)) > 1) changed.push(path)
    } catch { missing.push(path) }
  }
  return { changed, missing }
}

/** 枚举 daily-stats 目录中已有的天文件（YYYY-MM-DD.json），按日期升序。 */
export async function listDayFiles(dir) {
  let names
  try { names = await fs.readdir(dir) } catch { return [] }
  const days = []
  for (const n of names) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(n)) days.push(n.slice(0, 10))
  }
  days.sort()
  return days
}

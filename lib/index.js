// dsh-provider-usage — Host half (M2 简易版，多供应商)。
// 两类适配器（对齐 cc-switch 的 UsageData 统一模型）：
//   usage-percent（订阅型）：OpenCode Go  {{baseUrl}}/v1/usage        → rolling/weekly/monthly %
//   balance-json（余额型）  ：DeepSeek     {{baseUrl}}/user/balance    → balance_infos[]
// 凭证链 per provider：DSH 设置 provider.apiKeyEnv → 凭证服务 → 环境变量。
// 路由：/api/provider-usage/opencode-go（兼容旧版）、/api/provider-usage/query?provider=<id>、
//       /api/provider-usage/templates / credentials / dsh-providers / credential-refs（仅回环）。
// 本地 Token 统计（v0.5.0）：/api/provider-usage/local-usage（累计+按模型汇总，按天物化存储），
//       数据源 = 自读 $DSH_HOME/sessions 会话文件（fzstd 解压，assistant/message 事件 data.usage），只读、不联网；
//       存储 = $DSH_HOME/provider-usage/daily-stats/YYYY-MM-DD.json：历史天封存（deps mtime 校验），只算今天。
// 缓存：每 provider 独立 30s 新鲜窗口 + 并发去重 + 3 快照环；stale-while-error。

import { join, dirname } from 'node:path'
import { stat as fsStat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createSecureStore, resolveProviderUsageDir } from './secure-store.js'
import * as daily from './daily-stats.js'

export const name = 'provider-usage'

/** 插件版本单一来源：package.json（UA 标识用；bundle 内嵌等读不到时回退字面量）。 */
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.6.0' }
  catch { return '0.6.0' }
})()
const USER_AGENT = 'dsh-provider-usage/' + PLUGIN_VERSION

/** 插件需要的运行时服务。本地统计不依赖 sessionQuery（自读会话文件）。 */
export const inject = ['webServer', 'settings', 'credentials']

const DEFAULT_TIMEOUT_MS = 15000
/** Command Code 次要端点（subscriptions）超时：失败只降级不致命，不拖累整体响应。 */
const SUBSCRIPTION_TIMEOUT_MS = 5000
const DEFAULT_PROVIDER_ID = 'opencode-go'
/** 缓存新鲜窗口：30s 内直接复用上次成功结果（per provider）。 */
const CACHE_FRESH_MS = 30000
/** 诊断快照环大小。 */
const SNAPSHOT_LIMIT = 3
/** 解析逻辑版本，改动加 1。 */
const PARSE_VERSION = 1

// ── 本地 Token 统计（DSH 会话日志，v0.5.0）──
const LOCAL_MAX_SESSIONS = 30
const LOCAL_PARSE_VERSION = 2
/** deps 校验周期：每 5 分钟重新校验一次历史天文件的依赖 mtime（compaction 改写兜底）。 */
const LOCAL_DEPS_CHECK_MS = 300000

/** 内置适配器注册表（URL 由插件自身维护，不读 DSH 内置目录 —— 2026-08-24 决策）。
 * 用户可在客户端配置多个"供应商实例"，每个实例绑定一个适配器 + 自定义名称 + key 引用。 */
const ADAPTERS = [
  {
    id: 'usage-percent',
    displayName: 'OpenCode Go（订阅额度）',
    baseUrl: 'https://opencode.ai/zen/go',
    usagePath: '/v1/usage',
    defaultCredentialRef: 'OPENCODE_GO_API_KEY',
    settingsProviderKey: 'opencode-go',
    description: 'OpenCode Go 订阅额度（5小时/7天/月度窗口百分比）',
  },
  {
    id: 'balance-json',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    usagePath: '/user/balance',
    defaultCredentialRef: 'DEEPSEEK_API_KEY',
    settingsProviderKey: 'deepseek',
    description: 'DeepSeek 开放平台账户余额（CNY，balance_infos）',
  },
  {
    // Command Code：DSH 非内置提供方（pi-ai 注册表无 commandcode），只允许「添加自定义提供方」
    // （customOnly），Key 只存插件私有库（settingsProviderKey: null → 凭证链跳过 DSH 模型设置）。
    id: 'commandcode-credits',
    displayName: 'Command Code（订阅+余额）',
    baseUrl: 'https://api.commandcode.ai',
    usagePath: '/alpha/billing/credits',
    subscriptionPath: '/alpha/billing/subscriptions',
    defaultCredentialRef: 'COMMANDCODE_API_KEY',
    settingsProviderKey: null,
    customOnly: true,
    description: 'Command Code 订阅使用量（5小时/周窗口）+ 月度剩余额度（USD）',
  },
]

/** 旧 provider id → 适配器 id（向后兼容 /api/provider-usage/opencode-go 与 query?provider=…）。 */
const LEGACY_PROVIDER_MAP = { 'opencode-go': 'usage-percent', 'deepseek-balance': 'balance-json' }

/** Command Code 混合卡适配器（模块级常量，避免每次查询重复 find）。 */
const COMMANDCODE_ADAPTER = ADAPTERS.find((a) => a.id === 'commandcode-credits') || null

function isLoopbackRequest(req) {
  const addr = req.socket && req.socket.remoteAddress
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false
  const host = req.headers && req.headers.host
  if (host) {
    const hostname = String(host).replace(/:[0-9]+$/, '').toLowerCase()
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  }
  return true
}

/** 掩码 key：前 4 + … + 后 4。 */
function maskKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null
  if (key.length <= 8) return '***'
  return key.slice(0, 4) + '…' + key.slice(-4)
}

/** 解析指定 key 引用的 API Key：provider 配置 apiKeyEnv → DSH 凭证 → 环境变量。
 * spec = { credentialRef, settingsProviderKey }。 */
/**
 * 解析 Key 引用。
 * - fromVault=true：手动实例显式来源=插件私有库 → 【直接】解密私有库，跳过 DSH 链（同名也不冲突）
 * - fromVault=false：DSH 模型设置 → DSH 凭证 → 环境变量 → 私有库兜底（兼容旧实例）
 */
async function resolveCredentialFor(ctx, spec, storeFn, fromVault) {
  let ref = spec.credentialRef
  if (!fromVault) {
    try {
      let cfg = null
      try { cfg = ctx.settings.get('llm-pi-ai') } catch { /* ignore */ }
      if (!cfg) {
        try { cfg = ctx.settings.get('settings.llm-pi-ai') } catch { /* ignore */ }
      }
      const p = cfg && cfg.providers && cfg.providers[spec.settingsProviderKey]
      if (p && typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.trim() !== '') ref = p.apiKeyEnv.trim()
    } catch { /* ignore */ }
    try {
      const creds = ctx.credentials || ctx.get('credentials')
      if (creds && typeof creds.resolve === 'function') {
        const hit = await creds.resolve(ref)
        if (hit && hit.value) return { key: String(hit.value), source: 'credential:' + ref }
      }
    } catch { /* ignore */ }
    try {
      const env = typeof process !== 'undefined' ? process.env[ref] : undefined
      if (env) return { key: env, source: 'env:' + ref }
    } catch { /* ignore */ }
  }
  // 私有加密库：vault 直取，或作为旧链兜底
  if (typeof storeFn === 'function') {
    try {
      const s = await storeFn()
      const v = await s.get(ref)
      if (v) return { key: v, source: 'provider-usage:' + ref }
    } catch { /* ignore */ }
  }
  return null
}

// ── 解析（订阅型：与 cc-switch extractor 语义一致）────────────────

function getUsedPercent(usage, name) {
  const item = usage && usage[name]
  if (!item || item.percent === undefined || item.percent === null) return null
  const value = Number(item.percent)
  if (Number.isNaN(value)) return null
  return Math.max(0, Math.min(100, value))
}

function formatRemainingPercent(usedPercent) {
  if (usedPercent === null) return '--'
  return Math.round(100 - usedPercent) + '%'
}

function formatCountdown(isoTime) {
  if (!isoTime) return '--'
  const resetTimestamp = Date.parse(isoTime)
  if (Number.isNaN(resetTimestamp)) return '--'
  const seconds = Math.max(0, Math.floor((resetTimestamp - Date.now()) / 1000))
  if (seconds <= 0) return '已到期'
  const days = Math.floor(seconds / 86400)
  let rest = seconds % 86400
  const hours = Math.floor(rest / 3600)
  rest = rest % 3600
  const minutes = Math.floor(rest / 60)
  if (days > 0) return days + 'd' + hours + 'h'
  if (hours > 0) return hours + 'h' + minutes + 'm'
  if (minutes > 0) return minutes + 'm'
  return Math.floor(rest) + 's'
}

/** 把官方响应换算成结构化结果（含用户脚本同款 extra 文案）。 */
function parseUsage(body) {
  let data = body
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return { error: 'bad-json' } }
  }
  const usage = data && data.usage
  if (!usage) return { error: 'no-usage' }

  const rollingUsed = getUsedPercent(usage, 'rolling')
  const weeklyUsed = getUsedPercent(usage, 'weekly')
  const monthlyUsed = getUsedPercent(usage, 'monthly')
  const monthlyRemaining = monthlyUsed === null ? 0 : 100 - monthlyUsed

  const windowOf = (name, usedPct) => {
    const item = usage[name] || {}
    return {
      status: typeof item.status === 'string' ? item.status : 'ok',
      usedPct,
      remainingPct: usedPct === null ? null : Math.round((100 - usedPct) * 100) / 100,
      resetsAt: typeof item.resetsAt === 'string' && item.resetsAt ? item.resetsAt : null,
    }
  }

  return {
    planName: 'OpenCode Go',
    remaining: monthlyRemaining,
    unit: '%',
    extra:
      '5小时: ' + formatRemainingPercent(rollingUsed) +
      '  7天: ' + formatRemainingPercent(weeklyUsed) +
      '  ◷ ' + formatCountdown(usage.monthly && usage.monthly.resetsAt) +
      '  5小时重置 ' + formatCountdown(usage.rolling && usage.rolling.resetsAt) +
      ' · 7天重置 ' + formatCountdown(usage.weekly && usage.weekly.resetsAt),
    windows: {
      rolling: windowOf('rolling', rollingUsed),
      weekly: windowOf('weekly', weeklyUsed),
      monthly: windowOf('monthly', monthlyUsed),
    },
    cards: null,
    isValid: true,
    invalidMessage: null,
  }
}

// ── 解析（余额型：DeepSeek /user/balance，官方文档 + cc-switch balance.rs 语义）──

/** 把 DeepSeek balance 响应换算成结构化结果（每币种一张卡）。 */
function parseBalance(body) {
  let data = body
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { return { error: 'bad-json' } }
  }
  const isAvailable = data && typeof data.is_available === 'boolean'
    ? data.is_available
    : true
  const infos = data && Array.isArray(data.balance_infos) ? data.balance_infos : null
  if (!infos) return { error: 'no-balance' }

  const cards = infos.map((info) => {
    const currency = typeof info.currency === 'string' && info.currency ? info.currency : 'CNY'
    const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
    return {
      currency,
      remaining: toNum(info.total_balance),
      granted: toNum(info.granted_balance),
      toppedUp: toNum(info.topped_up_balance),
      isValid: isAvailable,
      invalidMessage: isAvailable ? null : '余额不足（账户不可用）',
    }
  })

  const fmt = (n) => (n === null ? '--' : n.toFixed(2))
  const parts = cards.map((c) => {
    let s = c.currency + ' ¥' + fmt(c.remaining)
    if (c.granted !== null || c.toppedUp !== null) {
      s += '（赠送 ' + fmt(c.granted) + ' + 充值 ' + fmt(c.toppedUp) + '）'
    }
    return s
  })
  const extra = parts.join('；') + (isAvailable ? '' : ' · 账户不可用（余额不足）')

  return {
    planName: 'DeepSeek 余额',
    remaining: cards.length > 0 ? cards[0].remaining : null,
    unit: cards.length > 0 ? cards[0].currency : 'CNY',
    extra,
    windows: null,
    cards,
    isValid: isAvailable,
    invalidMessage: isAvailable ? null : '余额不足（账户不可用）',
  }
}

// ── 解析（Command Code：订阅使用量 + 月度剩余额度混合卡）──────────────
// 官方 API（api.commandcode.ai）：
//   GET /alpha/billing/credits        → credits.monthlyCredits（月度剩余 $）+ windowLimits.{fiveHour,weekly}.{used,cap,resetAt}
//   GET /alpha/billing/subscriptions  → data.{planId,currentPeriodEnd,status}
// 官方【不提供月用量窗口】，月用量 = 计划总额 − monthlyCredits（调研方案 A，Rainytoken 同款减法）。
// 计划总额依赖 planId → 映射表（官方新增计划需同步更新；未知计划安全降级为仅窗口+剩余）。

/** Command Code 订阅计划 → 月度额度（USD）与展示名（调研文档 §3，2026-08 实测）。 */
const COMMANDCODE_PLANS = {
  'individual-go':    { quota: 10,  name: 'Go' },
  'individual-goat':  { quota: 70,  name: 'GOAT' },
  'individual-pro':   { quota: 80,  name: 'Pro' },
  'individual-max':   { quota: 150, name: 'Max' },
  'individual-ultra': { quota: 300, name: 'Ultra' },
}

const COMMANDCODE_PLAN_FALLBACK_NAME = 'Command Code'
/** 月已用百分比钳制到 [0,100]；无法推算（无总额/无剩余）返回 null。 */
function commandcodeMonthlyUsedPct(totalQuota, monthlyCredits) {
  if (totalQuota === null || totalQuota === undefined || !(totalQuota > 0)) return null
  const remaining = Number(monthlyCredits)
  if (!Number.isFinite(remaining)) return null
  return Math.max(0, Math.min(100, ((totalQuota - remaining) / totalQuota) * 100))
}

/** 把 credits + subscriptions 两个端点的响应换算成混合模型（订阅使用量 + 剩余额度）。 */
function parseCommandCodeCredits(creditsBody, subBody) {
  let credits = creditsBody
  if (typeof credits === 'string') { try { credits = JSON.parse(credits) } catch { return { error: 'bad-json' } } }
  const creditsData = credits && credits.credits
  const limits = credits && credits.windowLimits
  if (creditsData === undefined || creditsData === null || limits === undefined || limits === null) {
    return { error: 'no-credits' }
  }
  const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
  const monthlyCredits = toNum(creditsData.monthlyCredits)
  const purchasedCredits = toNum(creditsData.purchasedCredits)
  const freeCredits = toNum(creditsData.freeCredits)
  const fiveHour = limits.fiveHour || {}
  const weekly = limits.weekly || {}
  const fiveHourCap = toNum(fiveHour.cap)
  const weeklyCap = toNum(weekly.cap)
  const fiveHourUsed = toNum(fiveHour.used)
  const weeklyUsed = toNum(weekly.used)
  const fiveHourResetAt = typeof fiveHour.resetAt === 'number' && Number.isFinite(fiveHour.resetAt)
    ? new Date(fiveHour.resetAt).toISOString() : null
  const weeklyResetAt = typeof weekly.resetAt === 'number' && Number.isFinite(weekly.resetAt)
    ? new Date(weekly.resetAt).toISOString() : null

  // 订阅端点：planId → 计划总额/名称；失败或未知计划安全降级
  let sub = subBody
  if (typeof sub === 'string') { try { sub = JSON.parse(sub) } catch { sub = null } }
  const subData = sub && sub.success !== false && sub.data ? sub.data : null
  const planId = subData && typeof subData.planId === 'string' ? subData.planId : null
  const plan = planId ? COMMANDCODE_PLANS[planId] : null
  const totalQuota = plan ? plan.quota : null
  const planName = plan ? COMMANDCODE_PLAN_FALLBACK_NAME + '（' + plan.name + '）' : COMMANDCODE_PLAN_FALLBACK_NAME
  const nextResetAt = subData && typeof subData.currentPeriodEnd === 'string' && subData.currentPeriodEnd
    ? subData.currentPeriodEnd : null

  const monthlyUsedPct = commandcodeMonthlyUsedPct(totalQuota, monthlyCredits)
  const monthlyUsed = (monthlyUsedPct === null || totalQuota === null) ? null
    : Math.max(0, totalQuota - monthlyCredits)

  // resetsAt 命名对齐 parseUsage（client WindowRow 统一读 win.resetsAt）
  const windowOf = (used, cap, resetAt) => {
    const pct = (used !== null && cap !== null && cap > 0) ? Math.max(0, Math.min(100, (used / cap) * 100)) : null
    return { usedPct: pct, used, cap, resetsAt: resetAt }
  }

  const extraParts = []
  if (totalQuota !== null && monthlyUsed !== null) {
    extraParts.push('月已用 ' + monthlyUsed.toFixed(2) + ' / ' + totalQuota.toFixed(2) + ' USD')
  }
  if (monthlyCredits !== null) extraParts.push('月剩余 ' + monthlyCredits.toFixed(2) + ' USD')
  if (purchasedCredits !== null && purchasedCredits > 0) extraParts.push('付费包 ' + purchasedCredits.toFixed(2) + ' USD')
  if (freeCredits !== null && freeCredits > 0) extraParts.push('赠送 ' + freeCredits.toFixed(2) + ' USD')
  if (fiveHourResetAt) extraParts.push('5小时重置 ' + formatCountdown(fiveHourResetAt))
  if (weeklyResetAt) extraParts.push('周重置 ' + formatCountdown(weeklyResetAt))

  return {
    planName,
    remaining: monthlyCredits,
    unit: 'USD',
    used: monthlyUsed,
    totalQuota,
    // 顶层透传字段（对外协议，v0.6.0 起保留）：月度周期重置时间 = currentPeriodEnd。
    // 与 monthly.resetAt 同源；顶层供调试/外部脚本读取，卡片月窗口行读 monthly.resetAt。
    nextResetAt,
    extra: extraParts.join('；'),
    windows: {
      fiveHour: windowOf(fiveHourUsed, fiveHourCap, fiveHourResetAt),
      weekly: windowOf(weeklyUsed, weeklyCap, weeklyResetAt),
    },
    monthly: { usedPct: monthlyUsedPct, used: monthlyUsed, totalQuota, remaining: monthlyCredits, resetsAt: nextResetAt },
    cards: null,
    isValid: true,
    invalidMessage: null,
  }
}

// ── 插件主体 ────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const config = {
    baseUrlOverride: rawConfig && typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl
      ? rawConfig.baseUrl.replace(/\/$/, '')
      : null,
    timeoutMs: rawConfig && typeof rawConfig.timeoutMs === 'number' && rawConfig.timeoutMs > 0
      ? Math.min(rawConfig.timeoutMs, 30000)
      : DEFAULT_TIMEOUT_MS,
    // Command Code 次要端点超时（可覆盖：慢网络用户可调大；测试可调小）
    subscriptionTimeoutMs: rawConfig && typeof rawConfig.subscriptionTimeoutMs === 'number' && rawConfig.subscriptionTimeoutMs > 0
      ? Math.min(rawConfig.subscriptionTimeoutMs, 30000)
      : SUBSCRIPTION_TIMEOUT_MS,
    maxSessions: rawConfig && typeof rawConfig.maxSessions === 'number' && rawConfig.maxSessions > 0
      ? Math.min(rawConfig.maxSessions, 100)
      : LOCAL_MAX_SESSIONS,
    // 本地 Token 统计：会话目录默认 $DSH_HOME/sessions（可覆盖）；天文件存 $DSH_HOME/provider-usage/daily-stats/
    sessionsDir: rawConfig && typeof rawConfig.sessionsDir === 'string' && rawConfig.sessionsDir
      ? rawConfig.sessionsDir
      : join(dirname(resolveProviderUsageDir()), 'sessions'),
    dailyDir: join(resolveProviderUsageDir(), 'daily-stats'),
  }

  // cordis 配置的 baseUrl 仅覆盖 opencode-go（历史语义），其余 preset 用内置 URL（插件自维护）
  const effectiveBaseUrl = (cfg) =>
    cfg.id === 'usage-percent' && config.baseUrlOverride ? config.baseUrlOverride : cfg.baseUrl

  // 私有加密凭证库（方案 B，懒初始化：首次使用时生成密钥）
  let secure = null
  async function secureStore() {
    if (!secure) { secure = createSecureStore(resolveProviderUsageDir()); await secure.init() }
    return secure
  }

  /** 某 Key 引用位于哪个库：'dsh' | 'vault' | 'both' | null（供客户端区分导入/手动实例，旧数据自愈）。 */
  async function refStoreOf(name) {
    let dshHit = false
    const creds = ctx.credentials || ctx.get('credentials')
    if (creds) {
      try {
        if (typeof creds.describe === 'function') {
          const d = await creds.describe(name)
          if (d && (d.source || d.value !== undefined || d.inherited !== undefined || d.status === 'configured')) dshHit = true
        } else if (typeof creds.resolve === 'function') {
          const r = await creds.resolve(name)
          if (r && r.value !== undefined && r.value !== null) dshHit = true
        }
      } catch (e) { /* ignore */ }
    }
    let vaultHit = false
    try { vaultHit = await (await secureStore()).has(name) } catch (e) { /* ignore */ }
    if (dshHit && vaultHit) return 'both'
    if (dshHit) return 'dsh'
    if (vaultHit) return 'vault'
    return null
  }

  /** 某 Key 引用是否已配置：DSH describe/resolve → 私有加密库。 */
  async function refConfigured(name) {
    return (await refStoreOf(name)) !== null
  }

  // per-adapter 状态：adapterId -> { lastGood, fetching }
  const states = new Map()
  function stateOf(adapterId) {
    let s = states.get(adapterId)
    if (!s) { s = { lastGood: null, fetching: null }; states.set(adapterId, s) }
    return s
  }

  // 天文件内容缓存：轮询不再每次 readFile+parse 历史天（recompute/写入时刷新）
  const dayCache = new Map()
  async function cachedDay(day) {
    let d = dayCache.get(day)
    if (d === undefined) {
      d = await daily.readDayFile(config.dailyDir, day)
      if (d) dayCache.set(day, d)
      if (dayCache.size > 2000) dayCache.clear()
    }
    return d || null
  }
  function rememberDay(day, data) {
    dayCache.set(day, data)
  }

  function recordSnapshot(adapterId, snapshot) {
    const s = stateOf(adapterId)
    s.snapshots = s.snapshots || []
    s.snapshots.push(snapshot)
    if (s.snapshots.length > SNAPSHOT_LIMIT) s.snapshots = s.snapshots.slice(-SNAPSHOT_LIMIT)
  }

  const okResponse = (cfg, value, state, extraFields) => ({
    ok: true,
    providerId: cfg.id,
    displayName: cfg.displayName,
    config: { baseUrl: effectiveBaseUrl(cfg) + cfg.usagePath, timeoutMs: config.timeoutMs, provider: cfg.id },
    valid: true,
    planName: value.planName,
    remaining: value.remaining,
    unit: value.unit,
    used: value.used,
    totalQuota: value.totalQuota,
    nextResetAt: value.nextResetAt,
    monthly: value.monthly,
    extra: value.extra,
    windows: value.windows,
    cards: value.cards,
    isValid: value.isValid !== false,
    invalidMessage: value.invalidMessage || null,
    fetchedAt: state.lastGood ? state.lastGood.queriedAt : Date.now(),
    cached: false,
    stale: false,
    error: null,
    credential: state.lastGood ? state.lastGood.credential : null,
    snapshots: (state.snapshots || []).slice(),
    parseVersion: PARSE_VERSION,
    ...extraFields,
  })

  /** 对单个 GET 端点发起请求；返回 { status, ok, body, error }（error 为 null 表示成功）。
   * timeoutMs 可选：次要端点用短超时，避免拖累整体响应。 */
  async function fetchEndpoint(cfg, resolved, path, timeoutMs) {
    const attemptAt = Date.now()
    const url = effectiveBaseUrl(cfg) + path
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || config.timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + resolved.key,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const aborted = e && (e.name === 'AbortError' || e.message === 'AbortError')
      return { attemptAt, status: null, ok: false, body: null, error: aborted ? 'timeout' : 'network' }
    }
    clearTimeout(timer)
    if (res.status === 401 || res.status === 403) {
      return { attemptAt, status: res.status, ok: false, body: null, error: 'unauthorized' }
    }
    if (!res.ok) {
      return { attemptAt, status: res.status, ok: false, body: null, error: 'http-' + res.status }
    }
    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    if (body === null) return { attemptAt, status: res.status, ok: false, body: null, error: 'bad-json' }
    return { attemptAt, status: res.status, ok: true, body, error: null }
  }

  async function doQuery(cfg, credentialRef, fromVault) {
    const ref = (typeof credentialRef === 'string' && credentialRef.trim() !== '') ? credentialRef.trim() : cfg.defaultCredentialRef
    const key = cfg.id + '|' + ref + '|' + (fromVault ? 'vault' : 'dsh')
    const state = stateOf(key)
    const resolved = await resolveCredentialFor(ctx, { credentialRef: ref, settingsProviderKey: cfg.settingsProviderKey }, secureStore, fromVault === true)
    if (!resolved) {
      recordSnapshot(key, { attemptAt: Date.now(), httpStatus: null, error: 'no-api-key' })
      return fail(cfg, state, 'no-api-key', '未找到 ' + cfg.displayName + ' API Key：请在 DSH 模型设置中配置，或设置环境变量 ' + ref)
    }

    const credential = { source: resolved.source, keyHint: maskKey(resolved.key) }

    // Command Code：并行查两个端点（credits 必查、subscriptions 可选）；其余适配器单端点。
    // 主端点失败 → 走统一失败路径（stale 保留旧值）；订阅端点失败 → 降级展示（窗口+剩余仍在）。
    if (COMMANDCODE_ADAPTER && cfg.id === COMMANDCODE_ADAPTER.id) {
      const [creditsRes, subRes] = await Promise.all([
        fetchEndpoint(cfg, resolved, cfg.usagePath),
        // subscriptions 是次要端点：短超时，credits 成功而它卡死时整体不被拖到全局超时
        fetchEndpoint(cfg, resolved, cfg.subscriptionPath, config.subscriptionTimeoutMs),
      ])
      recordSnapshot(key, { attemptAt: creditsRes.attemptAt, httpStatus: creditsRes.status, error: creditsRes.error })
      if (!creditsRes.ok) {
        const msg = creditsRes.error === 'unauthorized'
          ? 'API Key 无效或已过期（401/403）'
          : creditsRes.error === 'timeout'
            ? '请求超时（' + config.timeoutMs + 'ms）'
            : creditsRes.error === 'network'
              ? '网络请求失败'
              : creditsRes.error === 'bad-json'
                ? '接口响应不是有效 JSON'
                : '接口返回 HTTP ' + creditsRes.status
        if (creditsRes.error === 'unauthorized') return fail(cfg, state, 'unauthorized', msg, creditsRes.status)
        if (creditsRes.error === 'timeout' || creditsRes.error === 'network') return failTransient(cfg, state, creditsRes.error, msg)
        return fail(cfg, state, creditsRes.error === 'bad-json' ? 'parse' : 'http', msg, creditsRes.status)
      }
      let parsed = parseCommandCodeCredits(creditsRes.body, subRes.ok ? subRes.body : null)
      if (parsed.error === 'no-credits') {
        recordSnapshot(key, { attemptAt: creditsRes.attemptAt, httpStatus: creditsRes.status, error: 'no-credits' })
        return fail(cfg, state, 'parse', '没有找到 Command Code 额度数据（credits/windowLimits）', creditsRes.status)
      }
      if (parsed.error === 'bad-json') {
        recordSnapshot(key, { attemptAt: creditsRes.attemptAt, httpStatus: creditsRes.status, error: 'bad-json' })
        return fail(cfg, state, 'parse', '接口返回的数据不是有效 JSON', creditsRes.status)
      }
      const good = { queriedAt: Date.now(), credential, parsed }
      state.lastGood = good
      return okResponse(cfg, parsed, state, { fetchedAt: good.queriedAt, credential })
    }

    const attemptAt = Date.now()
    const url = effectiveBaseUrl(cfg) + cfg.usagePath
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    let res
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: 'Bearer ' + resolved.key,
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      const aborted = e && (e.name === 'AbortError' || e.message === 'AbortError')
      recordSnapshot(key, { attemptAt, httpStatus: null, error: aborted ? 'timeout' : 'network' })
      return aborted ? failTransient(cfg, state, 'timeout', '请求超时（' + config.timeoutMs + 'ms）') : failTransient(cfg, state, 'network', '网络请求失败：' + String((e && e.message) || e))
    }
    clearTimeout(timer)

    if (res.status === 401 || res.status === 403) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'unauthorized' })
      return fail(cfg, state, 'unauthorized', res.status === 401 ? 'API Key 无效或已过期（401）' : '无访问权限（403）', res.status)
    }
    if (!res.ok) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'http-' + res.status })
      return fail(cfg, state, 'http', '接口返回 HTTP ' + res.status, res.status)
    }

    let body = null
    try { body = await res.json() } catch { /* ignore */ }
    if (body === null) {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail(cfg, state, 'parse', '接口响应不是有效 JSON', res.status)
    }

    const parsed = cfg.id === 'balance-json' ? parseBalance(body) : parseUsage(body)
    if (parsed.error === 'no-usage') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'no-usage' })
      return fail(cfg, state, 'parse', '没有找到 OpenCode Go 用量数据', res.status)
    }
    if (parsed.error === 'no-balance') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'no-balance' })
      return fail(cfg, state, 'parse', '没有找到 DeepSeek 余额数据（balance_infos）', res.status)
    }
    if (parsed.error === 'bad-json') {
      recordSnapshot(key, { attemptAt, httpStatus: res.status, error: 'bad-json' })
      return fail(cfg, state, 'parse', '接口返回的数据不是有效 JSON', res.status)
    }

    recordSnapshot(key, { attemptAt, httpStatus: res.status, error: null })
    const good = { queriedAt: Date.now(), credential, parsed }
    state.lastGood = good
    return okResponse(cfg, parsed, state, { fetchedAt: good.queriedAt, credential })
  }

  function fail(cfg, state, type, message, httpStatus) {
    if (state.lastGood) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: httpStatus || null } }
    }
    return { ok: false, providerId: cfg.id, displayName: cfg.displayName, valid: null, planName: null, remaining: null, unit: '%', used: null, totalQuota: null, nextResetAt: null, monthly: null, extra: null, windows: null, cards: null, isValid: false, invalidMessage: null, fetchedAt: null, cached: false, stale: false, error: { type, message, httpStatus: httpStatus || null }, credential: null, snapshots: (state.snapshots || []).slice(), parseVersion: PARSE_VERSION, config: { baseUrl: effectiveBaseUrl(cfg) + cfg.usagePath, timeoutMs: config.timeoutMs, provider: cfg.id } }
  }

  function failTransient(cfg, state, type, message) {
    if (state.lastGood) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true, stale: true, ok: false, error: { type, message, httpStatus: null } }
    }
    return fail(cfg, state, type, message, null)
  }

  /** 查询参数：adapter（新）/ provider（旧兼容）/ ref（key 引用，客户端实例可自定义）。 */
  async function query(params) {
    const provider = params && params.provider
    const adapter = params && params.adapter
    const mapped = provider ? LEGACY_PROVIDER_MAP[provider] : null
    // 显式给了 provider/adapter 但解析不到 → 未知（404）；完全没给 → 默认 usage-percent
    const id = adapter || mapped || (provider || adapter ? null : 'usage-percent')
    const rawLabel = adapter || provider || DEFAULT_PROVIDER_ID
    const cfg = ADAPTERS.find((a) => a.id === id)
    if (!cfg) {
      return {
        ok: false, providerId: rawLabel, displayName: null, valid: null, planName: null,
        remaining: null, unit: '%', extra: null, windows: null, cards: null,
        isValid: false, invalidMessage: null, fetchedAt: null, cached: false, stale: false,
        error: { type: 'unknown-provider', message: '未知供应商：' + rawLabel, httpStatus: 404 },
        credential: null, snapshots: [], parseVersion: PARSE_VERSION,
        config: { baseUrl: null, timeoutMs: config.timeoutMs, provider: rawLabel },
      }
    }
    const ref = (typeof (params && params.ref) === 'string' && params.ref.trim() !== '') ? params.ref.trim() : cfg.defaultCredentialRef
    const fromVault = !!(params && params.source === 'vault')
    const force = !!(params && (params.noCache === '1' || params.noCache === 'true'))
    const key = id + '|' + ref + '|' + (fromVault ? 'vault' : 'dsh')
    const state = stateOf(key)
    // 30s 新鲜窗口内直接返回缓存（noCache=1 跳过：改 Key 后强制刷新）
    if (!force && state.lastGood && Date.now() - state.lastGood.queriedAt < CACHE_FRESH_MS) {
      const prev = state.lastGood
      return { ...okResponse(cfg, prev.parsed, state, { fetchedAt: prev.queriedAt, credential: prev.credential }), cached: true }
    }
    if (!force && state.fetching) return state.fetching
    state.fetching = doQuery(cfg, ref, fromVault)
      .catch((e) => failTransient(cfg, state, 'internal', String((e && e.message) || e)))
      .finally(() => { state.fetching = null })
    return state.fetching
  }

  // ── 本地 Token 统计（DSH 会话日志，按天物化存储；历史天封存，只算今天）──
  function localFail(state, type, message) {
    if (state.lastGood) {
      return { ...state.lastGood.payload, cached: true, stale: true, ok: false, error: { type, message, httpStatus: null } }
    }
    return { ok: false, error: { type, message, httpStatus: null }, provider: null, detected: true, days: 0, scanned: 0, totals: null, byModel: null, providers: [], fetchedAt: null, cached: false, stale: false, snapshots: (state.snapshots || []).slice(), parseVersion: LOCAL_PARSE_VERSION }
  }

  /** 校验待查天的 deps：unique 路径并行 stat，按天判定 mtime 变化/缺失，必要时重算该天并刷新缓存。 */
  async function validateHistoryDeps(dayData, pending, state) {
    const uniquePaths = new Set()
    for (const day of pending) {
      for (const p of Object.keys(dayData[day].deps || {})) uniquePaths.add(p)
    }
    // path -> { currentMtime } | { missing: true }（只 stat 一次，按天各自比较）
    const current = new Map()
    await Promise.all([...uniquePaths].map(async (path) => {
      try {
        const st = await fsStat(path)
        current.set(path, { currentMtime: st.mtimeMs })
      } catch { current.set(path, { missing: true }) }
    }))
    for (const day of pending) {
      const data = dayData[day]
      const changed = []
      const missing = []
      for (const p of Object.keys(data.deps || {})) {
        const c = current.get(p)
        if (!c) continue
        if (c.missing) missing.push(p)
        else if (Math.abs(c.currentMtime - Number(data.deps[p])) > 1) changed.push(p)
      }
      if (changed.length > 0 || missing.length > 0) {
        const repaired = await recomputeDay(day, data.deps || {})
        data.byProvider = repaired.byProvider
        data.byModel = repaired.byModel
      }
      state.validatedDays.add(day)
    }
  }
  /** 重算某一天：读 deps 中仍存在的会话文件，fold 当天窗口，重新写回天文件。 */
  async function recomputeDay(day, deps) {
    const start = daily.dayStartMs(day)
    const end = daily.dayStartMs(daily.addDays(day, 1))
    const out = { byProvider: {}, byModel: {} }
    const newDeps = {}
    const paths = deps && Object.keys(deps).length > 0 ? Object.keys(deps) : null
    if (paths) {
      for (const p of paths) {
        let mtimeMs = null
        try { const st = await fsStat(p); mtimeMs = st.mtimeMs } catch { continue } // 会话已删：该天剔除其贡献
        const text = await daily.readSessionFile(p)
        if (!text) continue
        daily.mergeTotals(out, daily.foldEventsByDay(daily.parseEvents(text), start, end, null))
        newDeps[p] = mtimeMs
      }
    }
    const doc = { version: daily.DAILY_VERSION, date: day, deps: newDeps, byProvider: out.byProvider, byModel: out.byModel }
    await daily.writeDayFile(config.dailyDir, day, doc)
    rememberDay(day, doc)
    return out
  }

  /** 首次全量回填：并行解码全部会话文件，按事件时间分天落盘（含今天与 unknown 桶），一次性。 */
  async function backfillAll(nowMs) {
    const toDay = daily.dayKey(nowMs)
    const files = await daily.scanSessionFiles(config.sessionsDir, config.maxSessions, 0)
    const days = new Map()
    const cursors = await daily.loadCursors(config.dailyDir)
    await Promise.all(files.map(async (f) => {
      const text = await daily.readSessionFile(f.path)
      cursors[f.path] = { offset: f.size || 0, mtimeMs: f.mtimeMs }
      if (!text) return
      const folded = daily.foldEventsByDays(daily.parseEvents(text))
      for (const [day, fold] of Object.entries(folded)) {
        let bucket = days.get(day)
        if (!bucket) { bucket = { byProvider: {}, byModel: {}, deps: {} }; days.set(day, bucket) }
        daily.mergeTotals(bucket, fold)
        bucket.deps[f.path] = f.mtimeMs
      }
    }))
    await daily.saveCursors(config.dailyDir, cursors)
    for (const [day, bucket] of days.entries()) {
      const doc = {
        version: daily.DAILY_VERSION, date: day === 'unknown' ? 'unknown' : day,
        deps: bucket.deps, byProvider: bucket.byProvider, byModel: bucket.byModel,
      }
      await daily.writeDayFile(config.dailyDir, day, doc)
      rememberDay(day, doc)
    }
    if (days.has('unknown') && toDay && !days.has(toDay)) {
      // unknown 兜底：若没有任何可归天的数据也要让 listDayFiles 非空（避免反复回填）
      const doc = { version: daily.DAILY_VERSION, date: toDay, deps: {}, byProvider: {}, byModel: {} }
      await daily.writeDayFile(config.dailyDir, toDay, doc)
      rememberDay(toDay, doc)
    }
    return days.size
  }

  /** 计算今天的 totals：只扫描今天变过的会话文件（mtime >= 今天零点 - 1h 缓冲），
   * 增量解码——mtime 未变的文件跳过（零读取），mtime 变化的文件只解上次偏移之后的新帧。 */
  async function computeToday(nowMs) {
    const toDay = daily.dayKey(nowMs)
    const todayStart = daily.dayStartMs(toDay)
    const todayEnd = daily.dayStartMs(daily.addDays(toDay, 1))
    const files = await daily.scanSessionFiles(config.sessionsDir, config.maxSessions, todayStart - 3600000)
    const cursors = await daily.loadCursors(config.dailyDir)
    // 今天 totals = 上次累积的天文件 + 本轮新增帧（文件 mtime 未变则完全跳过）
    const prevDay = await cachedDay(toDay)
    const out = prevDay ? {
      byProvider: JSON.parse(JSON.stringify(prevDay.byProvider || {})),
      byModel: JSON.parse(JSON.stringify(prevDay.byModel || {})),
    } : { byProvider: {}, byModel: {} }
    const deps = prevDay && prevDay.deps ? { ...prevDay.deps } : {}
    let anyWork = false
    for (const f of files) {
      deps[f.path] = f.mtimeMs
      const cur = cursors[f.path]
      if (cur && cur.mtimeMs === f.mtimeMs) continue // 文件无新写入：本轮零成本跳过
      anyWork = true
      if (cur && typeof cur.offset === 'number') {
        const inc = await daily.readSessionFileFrom(f.path, cur.offset)
        if (inc.changed && inc.text) {
          daily.mergeTotals(out, daily.foldEventsByDay(daily.parseEvents(inc.text), todayStart, todayEnd, null))
          cursors[f.path] = { offset: inc.total, mtimeMs: f.mtimeMs }
          continue
        }
        if (inc.changed && !inc.text) {
          cursors[f.path] = { offset: inc.total, mtimeMs: f.mtimeMs }
          continue // 无新增内容
        }
        // 无法按偏移衔接 → 回退全量
      }
      const text2 = await daily.readSessionFile(f.path)
      if (text2) {
        daily.mergeTotals(out, daily.foldEventsByDay(daily.parseEvents(text2), todayStart, todayEnd, null))
      }
      cursors[f.path] = { offset: f.size || 0, mtimeMs: f.mtimeMs }
    }
    // 无任何文件变化 → 天文件与游标内容不变，跳过两次写盘
    if (anyWork) {
      await daily.saveCursors(config.dailyDir, cursors)
      const doc = { version: daily.DAILY_VERSION, date: toDay, deps, byProvider: out.byProvider, byModel: out.byModel }
      await daily.writeDayFile(config.dailyDir, toDay, doc)
      rememberDay(toDay, doc)
    }
    return { toDay, out, scanned: files.length }
  }

  async function doLocalUsage(target, since, key, state) {
    let st
    try { st = await fsStat(config.sessionsDir) } catch { return localFail(state, 'no-sessions', '未找到 DSH 会话目录：' + config.sessionsDir) }
    await daily.initDecoder() // 首次懒加载 zstd-wasm（测试注入 identity 时为 no-op）
    const nowMs = Date.now()
    // deps 周期校验：5 分钟内只验证一次，过期则清空已校验集合（下次请求重校验）
    if (!state.depsCheckAt || nowMs - state.depsCheckAt >= LOCAL_DEPS_CHECK_MS) {
      state.validatedDays = new Set()
      state.depsCheckAt = nowMs
    }
    const toDay = daily.dayKey(nowMs)
    // 回填触发：没有历史天文件（含旧版只写了今天的遗留）且未做过回填 → 全量扫历史按天落盘
    const existingDays = await daily.listDayFiles(config.dailyDir)
    const hasHist = existingDays.some((d) => d < toDay)
    if (!hasHist && !(await daily.hasBackfilled(config.dailyDir))) {
      await backfillAll(nowMs)
      await daily.writeBackfilled(config.dailyDir)
    }
    const agg = { byProvider: {}, byModel: {} }
    const dayCount = new Set()
    dayCount.add(toDay)
    // 今天：只算今天变过的文件
    const today = await computeToday(nowMs)
    daily.mergeTotals(agg, today.out)
    // 历史天：读天文件（内存缓存；5 分钟周期内只校验一次 deps；mtime 变化才重算该天）
    const existing = await daily.listDayFiles(config.dailyDir)
    const pending = []
    const dayData = {}
    for (const day of existing) {
      if (day >= toDay) continue
      if (since > 0 && daily.dayStartMs(day) < since) continue
      const data = await cachedDay(day)
      if (!data) continue
      dayData[day] = data
      if (!state.validatedDays || !state.validatedDays.has(day)) pending.push(day)
    }
    if (pending.length > 0) {
      state.validatedDays = state.validatedDays || new Set()
      await validateHistoryDeps(dayData, pending, state)
    }
    for (const day of Object.keys(dayData)) {
      const data = dayData[day]
      daily.mergeTotals(agg, { byProvider: data.byProvider || {}, byModel: data.byModel || {} })
      dayCount.add(day)
    }
    // unknown 桶（time 缺失事件）：并入聚合（不占天数）
    const unknownData = await cachedDay('unknown')
    if (unknownData) {
      daily.mergeTotals(agg, { byProvider: unknownData.byProvider || {}, byModel: unknownData.byModel || {} })
    }
    // 组装响应（chips 只过滤 totals；byModel 恒为全量）
    const providers = Object.keys(agg.byProvider).sort()
    const pick = target ? (agg.byProvider[target] || null) : null
    const t = pick || { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    if (!pick) {
      for (const k of providers) {
        t.requests += agg.byProvider[k].requests || 0
        t.inputTokens += agg.byProvider[k].inputTokens || 0
        t.outputTokens += agg.byProvider[k].outputTokens || 0
        t.cacheReadTokens += agg.byProvider[k].cacheReadTokens || 0
      }
    }
    const payload = {
      ok: true, error: null, message: null,
      provider: target || null, detected: true,
      days: dayCount.size,
      scanned: today.scanned,
      totals: {
        requests: t.requests,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheReadTokens: t.cacheReadTokens,
        realTotalTokens: t.inputTokens + t.outputTokens + t.cacheReadTokens,
        cacheHitRate: (t.inputTokens + t.cacheReadTokens) > 0
          ? t.cacheReadTokens / (t.inputTokens + t.cacheReadTokens)
          : 0,
      },
      byModel: agg.byModel || null,
      providers,
      fetchedAt: Date.now(), cached: false, stale: false,
      snapshots: (state.snapshots || []).slice(),
      parseVersion: LOCAL_PARSE_VERSION,
    }
    recordSnapshot(key, { attemptAt: Date.now(), httpStatus: null, error: null })
    state.lastGood = { queriedAt: Date.now(), payload }
    return payload
  }

  async function localUsage(params) {
    const target = (params && typeof params.provider === 'string' && params.provider.trim() !== '') ? params.provider.trim() : null
    const since = (params && typeof params.since === 'string' && Number(params.since) > 0) ? Number(params.since) : 0
    const force = !!(params && (params.noCache === '1' || params.noCache === 'true'))
    const key = 'local|' + (target || '*') + '|' + since
    const state = stateOf(key)
    if (!force && state.lastGood && Date.now() - state.lastGood.queriedAt < CACHE_FRESH_MS) {
      return { ...state.lastGood.payload, cached: true }
    }
    if (!force && state.fetching) return state.fetching
    state.fetching = doLocalUsage(target, since, key, state)
      .catch((e) => localFail(state, 'internal', String((e && e.message) || e)))
      .finally(() => { state.fetching = null })
    return state.fetching
  }


  function readBodyJson(req) {
    return new Promise((resolve) => {
      let raw = ''
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      try {
        req.on('data', (chunk) => { raw += String(chunk); if (raw.length > 8192) finish(null) })
        req.on('end', () => { try { finish(JSON.parse(raw || '{}')) } catch (e) { finish(null) } })
        req.on('error', () => finish(null))
      } catch (e) { finish(null) }
    })
  }

  const jsonRoute = (handler, allowPost) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && (!allowPost || req.method !== 'POST')) {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method not allowed' }))
      return
    }
    try {
      const body = req.method === 'POST' ? await readBodyJson(req) : undefined
      const result = await handler(req, body)
      res.writeHead(result.error && result.error.httpStatus ? result.error.httpStatus : 200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { type: 'internal', message: String((e && e.message) || e) } }))
    }
  }

  /** 从 URL 提取查询参数：adapter / provider（旧兼容）/ ref（key 引用）。 */
  const queryParamsFromUrl = (req) => {
    try {
      if (!req.url) return {}
      const u = new URL(req.url, 'http://localhost')
      const out = {}
      const p = u.searchParams.get('provider'); if (p && p.trim()) out.provider = p.trim()
      const a = u.searchParams.get('adapter'); if (a && a.trim()) out.adapter = a.trim()
      const r = u.searchParams.get('ref'); if (r && r.trim()) out.ref = r.trim()
      const s = u.searchParams.get('source'); if (s && s.trim()) out.source = s.trim()
      const n = u.searchParams.get('noCache'); if (n && (n === '1' || n === 'true')) out.noCache = '1'
      const t = u.searchParams.get('since'); if (t && /^[0-9]+$/.test(t)) out.since = t
      return out
    } catch (e) {
      return {}
    }
  }

  ctx.effect(() => {
    const disposers = [
      // 兼容旧版：固定 opencode-go → usage-percent 适配器
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/opencode-go',
        handler: jsonRoute(() => query({})),
      }),
      // 多实例查询：/api/provider-usage/query?adapter=<id>&ref=<credentialRef>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/query',
        handler: jsonRoute((req) => query(queryParamsFromUrl(req))),
      }),
      // 本地 Token 统计（DSH 会话日志，只读、不联网、与实例/Key 解耦）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/local-usage',
        handler: jsonRoute((req) => localUsage(queryParamsFromUrl(req))),
      }),

      // 适配器清单（不含任何 secret；客户端据此渲染"添加供应商"选项）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/templates',
        handler: jsonRoute(() => ({
          ok: true,
          items: ADAPTERS.map((a) => ({ id: a.id, displayName: a.displayName, description: a.description })),
        })),
      }),
      // 手动 Key 写入/删除：值加密进 $DSH_HOME/provider-usage（方案 B，不落明文、不进 DSH 凭证）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/credentials',
        handler: jsonRoute(async (req, body) => {
          // 私有库键独立命名空间（非 DSH 引用名）：允许字母/数字/下划线/连字符
          const keyOk = (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(k)
          if (req.method === 'POST') {
            const ref = body && typeof body.ref === 'string' ? body.ref.trim() : ''
            const value = body && typeof body.value === 'string' ? body.value : ''
            if (!keyOk(ref)) return { ok: false, error: { type: 'bad-ref', message: 'Key 标识不合法（仅限字母/数字/下划线/连字符）', httpStatus: 400 } }
            if (!value) return { ok: false, error: { type: 'bad-value', message: 'Key 值不能为空', httpStatus: 400 } }
            await (await secureStore()).set(ref, value)
            return { ok: true, ref }
          }
          const ref = typeof req.url === 'string' ? (new URL(req.url, 'http://localhost').searchParams.get('ref') || '') : ''
          if (!keyOk(ref)) return { ok: false, error: { type: 'bad-ref', message: 'Key 标识不合法', httpStatus: 400 } }
          await (await secureStore()).remove(ref)
          return { ok: true, ref }
        }, true),
      }),
      // 可从 DSH 导入的供应商（仅我们适配：OpenCode Go 订阅 / DeepSeek 余额）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/dsh-providers',
        handler: jsonRoute(async () => {
          let settingsCfg = null
          try { settingsCfg = ctx.settings.get('llm-pi-ai') } catch (e) { /* ignore */ }
          if (!settingsCfg) { try { settingsCfg = ctx.settings.get('settings.llm-pi-ai') } catch (e) { /* ignore */ } }
          const IMPORTABLE = [
            { route: 'opencode-go', displayName: 'OpenCode Go', adapter: 'usage-percent', ref: 'OPENCODE_GO_API_KEY', settingsKey: 'opencode-go' },
            { route: 'deepseek-official', displayName: 'DeepSeek', adapter: 'balance-json', ref: 'DEEPSEEK_API_KEY', settingsKey: 'deepseek' },
          ]
          const items = []
          for (const imp of IMPORTABLE) {
            const prov = settingsCfg && settingsCfg.providers && settingsCfg.providers[imp.settingsKey]
            const ref = prov && typeof prov.apiKeyEnv === 'string' && prov.apiKeyEnv.trim() !== '' ? prov.apiKeyEnv.trim() : imp.ref
            const displayName = prov && typeof prov.displayName === 'string' && prov.displayName ? prov.displayName : imp.displayName
            items.push({ route: imp.route, displayName, adapter: imp.adapter, ref, configured: await refConfigured(ref) })
          }
          return { ok: true, items }
        }),
      }),
      // 按需检查 Key 引用的配置状态（不含值；官方 Models 页同款的 credentials.describe）
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/provider-usage/credential-refs',
        handler: jsonRoute(async (req) => {
          const list = []
          try {
            if (req.url) {
              const u = new URL(req.url, 'http://localhost')
              const raw = u.searchParams.get('refs')
              if (raw) {
                for (const part of raw.split(',')) {
                  const name = part.trim()
                  // 宽松校验：兼容 DSH 引用名与私有库键（实例 id 含连字符）
                  if (name && /^[A-Za-z0-9_-]{1,64}$/.test(name) && list.length < 24) list.push(name)
                }
              }
            }
          } catch (e) { /* ignore */ }
          const refs = []
          for (const name of list) {
            const store = await refStoreOf(name)
            refs.push({ name, configured: store !== null, store })
          }
          return { ok: true, refs }
        }),
      }),
    ]
    return () => { for (const dispose of disposers) { if (typeof dispose === 'function') dispose() } }
  }, 'provider-usage: routes')
}

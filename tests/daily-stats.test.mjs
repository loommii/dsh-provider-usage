// daily-stats 模块单测：日期键/范围、按天折叠、扫描过滤、天文件读写/损坏恢复、deps 校验。
import { dayKey, dayStartMs, addDays, dayRange, foldEventsByDay, foldEventsByDays, mergeTotals, scanSessionFiles, readSessionFile, parseEvents, readDayFile, writeDayFile, validateDeps, listDayFiles, hasBackfilled, writeBackfilled, resetDailyStats, _setDecoderForTests } from '../lib/daily-stats.js'
import { mkdtemp, writeFile, readdir, mkdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function assert(cond, name, extra) {
  if (cond) { passed++; console.log("  ✓ " + name) }
  else { failed++; console.error("  ✗ " + name + (extra ? " → " + JSON.stringify(extra) : "")) }
}

console.log("daily-stats：日期工具")
{
  const ms = new Date(2026, 7, 26, 15, 30, 0).getTime()
  assert(dayKey(ms) === "2026-08-26", "dayKey 本地时区")
  assert(dayStartMs("2026-08-26") === new Date(2026, 7, 26, 0, 0, 0).getTime(), "dayStartMs 当天零点")
  assert(addDays("2026-08-31", 1) === "2026-09-01" && addDays("2026-03-01", -1) === "2026-02-28", "addDays 跨月/跨年负向")
  assert(dayRange("2026-08-30", "2026-09-01").join(",") === "2026-08-30,2026-08-31,2026-09-01", "dayRange 含端点")
}

console.log("daily-stats：按天折叠（归属/回退/时间窗口/chunk 忽略）")
{
  const start = new Date(2026, 7, 26, 0, 0, 0).getTime()
  const end = start + 86400000
  const evs = [
    { type: "request/header", time: start + 1, data: { header: { config: { provider: "opencode-go", model: "fm" } } } },
    { type: "assistant/message", time: start + 1000, data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 }, message: { source: { provider: "opencode-go", model: "m1" } } } },
    { type: "assistant/message", time: start + 2000, data: { turn: 1, step: 2, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } } },
    { type: "assistant/chunk", time: start + 2000, data: { turn: 1, step: 2, chunk: { type: "usage", usage: { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 } } } },
    { type: "assistant/message", time: start + 86400000 + 1000, data: { turn: 2, step: 1, usage: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 50 }, message: { source: { provider: "opencode-go", model: "m1" } } } },
  ]
  const f = foldEventsByDay(evs, start, end, null)
  assert(f.byProvider["opencode-go"].requests === 2 && f.byProvider["opencode-go"].inputTokens === 11, "provider 聚合（chunk 不计/窗口外不计）")
  assert(f.byModel["opencode-go"].fm.inputTokens === 1 && f.byModel["opencode-go"].m1.inputTokens === 10, "模型回退 header / 显式 source（byModel 按提供方嵌套）")
  const byDays = foldEventsByDays(evs, null)
  const keys = Object.keys(byDays)
  assert(keys.length === 2, "foldEventsByDays 按天分组（两天）")
  assert(byDays[keys[0]].byProvider["opencode-go"].requests === 2 && byDays[keys[1]].byProvider["opencode-go"].requests === 1, "各天 message 计数（chunk 不计）")
  const noTimeDays = foldEventsByDays([{ type: "assistant/message", data: { usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 5 }, message: { source: { provider: "p", model: "m" } } } }], null)
  assert(noTimeDays.unknown && noTimeDays.unknown.byProvider.p.requests === 1, "time 缺失归 unknown 桶")
  const g = foldEventsByDay(evs, start, end, "opencode")
  assert(Object.keys(g.byProvider).length === 0 && Object.keys(g.byModel).length === 0, "target 过滤其它 provider")
  const noTime = foldEventsByDay([{ type: "assistant/message", data: { usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 5 }, message: { source: { provider: "p", model: "m" } } } }], start, end, null)
  assert(noTime.byProvider.p.requests === 1, "time 缺失按当天计入")
}

console.log("daily-stats：mergeTotals 同键累加（含 v0.6.1 扁平 byModel 双向迁移）")
{
  const dst = { byProvider: {}, byModel: {} }
  mergeTotals(dst, { byProvider: { a: { requests: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } }, byModel: { m: { requests: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 } } })
  mergeTotals(dst, { byProvider: { a: { requests: 2, inputTokens: 20, outputTokens: 2, cacheReadTokens: 1 } }, byModel: { m: { requests: 2, inputTokens: 20, outputTokens: 2, cacheReadTokens: 1 } } })
  assert(dst.byProvider.a.requests === 3 && dst.byProvider.a.inputTokens === 30 && dst.byProvider.a.cacheReadTokens === 1, "byProvider 累加")
  assert(dst.byModel.unknown.m.outputTokens === 3, "v1 扁平 byModel 归 unknown 提供方桶累加")
  const dst2 = { byProvider: {}, byModel: { p1: { mA: { requests: 1, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 } } } }
  mergeTotals(dst2, { byProvider: {}, byModel: { p1: { mA: { requests: 1, inputTokens: 2, outputTokens: 0, cacheReadTokens: 0 }, mB: { requests: 1, inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 } }, p2: { mC: { requests: 1, inputTokens: 7, outputTokens: 0, cacheReadTokens: 0 } } } })
  assert(dst2.byModel.p1.mA.inputTokens === 3 && dst2.byModel.p1.mB.inputTokens === 5 && dst2.byModel.p2.mC.inputTokens === 7, "嵌套 byModel 按提供方分桶累加")
}

console.log("daily-stats：天文件写入/读取（原子）/损坏恢复/列举")
{
  const dir = await mkdtemp(join(tmpdir(), "pu-ds-"))
  const day = "2026-08-26"
  await writeDayFile(dir, day, { version: 1, date: day, deps: {}, byProvider: { a: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 4 } }, byModel: {} })
  const data = await readDayFile(dir, day)
  assert(data && data.byProvider.a.requests === 1, "写入后可读")
  const files = await readdir(dir)
  assert(files.length === 1 && !files[0].startsWith("."), "原子写：无 tmp 残留")
  await writeFile(join(dir, "2026-08-25.json"), "{broken json", "utf8")
  assert(await readDayFile(dir, "2026-08-25") === null, "损坏文件 → null")
  const days = await listDayFiles(dir)
  assert(days.join(",") === "2026-08-25,2026-08-26", "listDayFiles 按日期升序（含损坏文件）")
}

console.log("daily-stats：scanSessionFiles 过滤与排序 + deps 校验")
{
  const sessions = await mkdtemp(join(tmpdir(), "pu-scan-"))
  const t1 = new Date(2026, 7, 25, 10, 0, 0).getTime()
  const t2 = t1 + 86400000
  await mkdir(join(sessions, "a"), { recursive: true })
  await mkdir(join(sessions, "b"), { recursive: true })
  const fa = join(sessions, "a", "session.jsonl.zstd")
  const fb = join(sessions, "b", "session.jsonl.zstd")
  await writeFile(fa, "{}\\n")
  await writeFile(fb, "{}\\n")
  await utimes(fa, new Date(t1), new Date(t1))
  await utimes(fb, new Date(t2), new Date(t2))
  const all = await scanSessionFiles(sessions, 0, 0)
  assert(all.length === 2 && all[0].path === fb && all[1].path === fa, "全量扫描按 mtime 降序")
  const today = await scanSessionFiles(sessions, 0, t2 - 3600000)
  assert(today.length === 1 && today[0].path === fb, "minMtime 过滤（只收今天变过的）")
  const limit = await scanSessionFiles(sessions, 1, 0)
  assert(limit.length === 1, "limit 生效")
  const { changed, missing } = await validateDeps({ [fb]: t2, [fa]: t1, [join(sessions, "gone", "session.jsonl.zstd")]: t1 })
  assert(changed.length === 0 && missing.length === 1, "deps 校验：存在未变 / 缺失识别")
  await utimes(fb, new Date(t2 + 5000), new Date(t2 + 5000))
  const v2 = await validateDeps({ [fb]: t2 })
  assert(v2.changed.length === 1, "deps 校验：mtime 变化识别")
}

console.log("daily-stats：回填哨兵版本判定 + resetDailyStats 重置")
{
  const dir = await mkdtemp(join(tmpdir(), "pu-reset-"))
  assert(await hasBackfilled(dir) === false, "无哨兵 → 未回填")
  await writeBackfilled(dir) // 当前版本（2）
  assert(await hasBackfilled(dir) === true, "v2 哨兵 → 已回填")
  await writeFile(join(dir, ".backfilled"), JSON.stringify({ version: 1, at: 0 }), "utf8")
  assert(await hasBackfilled(dir) === false, "v1 哨兵（v0.6.1 所写）→ 视为未回填，触发重折")
  // resetDailyStats：只删派生文件
  await writeDayFile(dir, "2026-08-26", { version: 2, date: "2026-08-26", deps: {}, byProvider: {}, byModel: {} })
  await writeFile(join(dir, "cursors.json"), JSON.stringify({ version: 1, files: {} }), "utf8")
  await writeFile(join(dir, "keep-me.txt"), "not-stats", "utf8")
  const removed = await resetDailyStats(dir)
  assert(removed === 3, "清除 天文件+cursors+哨兵（" + removed + "）")
  const files = await readdir(dir)
  assert(files.length === 1 && files[0] === "keep-me.txt", "目录内非统计文件保留")
  assert(await resetDailyStats(dir) === 0, "目录不存在时返回 0（幂等）")
  assert(await resetDailyStats(join(dir, "no-such-dir")) === 0, "空目录重置为 0")
}

console.log("daily-stats：identity 解码（测试注入）")
{
  _setDecoderForTests((b) => Buffer.from(b))
  const dir = await mkdtemp(join(tmpdir(), "pu-dec-"))
  const file = join(dir, "session.jsonl.zstd")
  await writeFile(file, "{\"a\":1}\n{\"b\":2}\n", "utf8")
  const text = await readSessionFile(file)
  assert(text && parseEvents(text).length === 2, "identity 解码 + 解析")
}

if (failed > 0) { console.error("\nFAILED: " + failed + " 项"); process.exit(1) }
console.log("\nPASSED: " + passed + " 项全部通过")

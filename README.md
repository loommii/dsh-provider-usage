# dsh-provider-usage (M1)

DSH Web GUI 插件 · **最简版**：右下角悬浮鲸鱼 🐳，点击弹出「OpenCode Go 用量」对话框。

- 查询语义对齐 cc-switch 的使用量查询脚本（`{{baseUrl}}/v1/usage` + Bearer key）
- 悬浮鲸鱼为 **鲸鱼娘（精致版）** 精灵动画（idle 循环 + 点击挥手），资产来自 dsh-pet（MIT，见 ASSETS-NOTICE.md）
- 点击时查询，Host 侧 30 秒缓存复用；面板打开期间每 30 秒自动刷新
- 显示：每月剩余 %（大数字）+ 5小时/7天/每月三窗口进度条 + 重置倒计时 + cc-switch 同款 summary 文案
- 回环路由防护、凭证只经 DSH 凭证层解析（不落副本）、key 掩码展示

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:loommii/dsh-provider-usage

# 或从本地源码目录安装
dsh plugin --profile web add file:/path/to/dsh-provider-usage
```

然后重启 `dsh web`。

## 版本规范（自 v0.2.0 起）

- 语义化版本 `MAJOR.MINOR.PATCH`：
  - **PATCH**：缺陷修复（悬空、越界、遮挡等）
  - **MINOR**：新功能（设置页、精灵动画、挂载方式、样式重构等）
  - **MAJOR**：破坏性变更 / 里程碑发布
- 发布流程：本地开发 → 本地验收 → 提交推送 → 打 tag（`vMAJOR.MINOR.PATCH`）
- 安装指定版本：`dsh plugin --profile web add github:loommii/dsh-provider-usage#v0.2.0`
- 历史说明：0.1.0–0.1.7 为早期逐批递增（见 CHANGELOG.md），0.2.0 起按本规范执行

## 设置（设置 → 「OpenCode Go 用量」）

| 设置项 | 说明 | 生效方式 |
|---|---|---|
| 显示悬浮鲸鱼 | 显示/隐藏 🐳 | 即时 |
| 鲸鱼尺寸 | 32–512px（默认 160，与 dsh-pet 一致） | 即时 |
| 面板自动刷新间隔 | 15s / 30s / 60s / 2min | 即时 |
| 重置到右下角 | 清除位置记忆，回到默认（right:24 / bottom:20，与 dsh-pet 一致） | 即时 |
| 恢复默认设置 | 全部恢复 + 位置重置 | 即时 |
| 当前状态 | 数据源、凭证来源（掩码）、最近 HTTP 状态、更新时间 | 即时 |

设置保存在**本机浏览器 localStorage**（`dsh-provider-usage.settings`），改动即时生效、无需重启。
`baseUrl` / `timeoutMs` 仍属于 Host 配置，需改 `cordis.patch.yml` 并重启。

## 密钥来源（按序）

1. DSH 设置 → `llm-pi-ai.providers['opencode-go'].apiKeyEnv` 声明的凭证引用（默认 `OPENCODE_GO_API_KEY`）
2. DSH 凭据服务 / 环境变量 `OPENCODE_GO_API_KEY`

## 配置（cordis.patch.yml 插件行覆盖）

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `https://opencode.ai/zen/go` | 实际请求 `<baseUrl>/v1/usage` |
| `timeoutMs` | `15000` | 请求超时（上限 30000） |

## 路由

- `GET /api/provider-usage/opencode-go`（仅回环，403 防护）

## 已知限制（M1）

- 仅内置 OpenCode Go 一个供应商；无模板注册表/声明式模板引擎（M2 从 `方案.md` 扩展）
- 无设置页/无拖拽/无悬浮面板之外的视图
- 无 i18n 注册（文案固定中文；M2 补 `dsh-client-locale`）
- key 不支持 `auth.json` 兜底（M1 刻意简化，只走 DSH 凭证/环境变量）

参考：`docs/opencode-go-ccswitch-script.md`（cc-switch 原脚本，语义来源）。

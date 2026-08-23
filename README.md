# dsh-provider-usage (M1)

DSH Web GUI 插件 · **最简版**：右下角悬浮鲸鱼 🐳，点击弹出「OpenCode Go 用量」对话框。

- 查询语义对齐 cc-switch 的使用量查询脚本（`{{baseUrl}}/v1/usage` + Bearer key）
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

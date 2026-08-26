# dsh-provider-usage — DSH「用量中心」

> 当前版本 **v0.4.2** · [更新历史](docs/CHANGELOG.md)

DSH Web GUI 插件 **「用量中心」**：一个常驻右下角的用量卡片，实时显示你的 AI 服务用量 / 余额，不用再打开网页查。

## 支持的提供方

| 提供方 | 显示内容 |
|---|---|
| OpenCode Go（订阅） | 5 小时 / 7 天 / 月度三个窗口的已用百分比 + 进度条 + 重置倒计时 |
| DeepSeek（余额） | 账户余额（CNY） |

## 功能

- **常驻用量卡片**：右下角悬浮，一眼看到剩余量；可随意拖动，位置自动记住
- **自动刷新**：每 30s 自动更新；想看最新数据点卡片上的 ↻ 立即重新查询
- **多实例**：可以同时配置多个提供方（如多个 OpenCode Go 账号），点卡片 logo / 名称切换查看
- **状态提示**：正常 / 未更新 / 注意 / 错误，请求中显示「查询中」动画
- **Key 安全**：密钥只在 DSH 进程内解析使用，界面上一律打码显示；自定义 Key 可加密保存在本机（AES-256 加密），不落明文

## 安装

```sh
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:loommii/dsh-provider-usage

# 安装指定版本（可选）
dsh plugin --profile web add github:loommii/dsh-provider-usage#v0.4.2
```

安装后重启 `dsh web` 即可在设置页看到「用量中心」。

## 快速开始

1. 打开 DSH 设置 → **用量中心** → 「提供方」
2. 添加一个实例：
   - **OpenCode Go 订阅**：需要 OpenCode Go 的 API Key（默认读取 `OPENCODE_GO_API_KEY`）
   - **DeepSeek 余额**：需要 DeepSeek 开放平台的 API Key（默认读取 `DEEPSEEK_API_KEY`）
   - Key 也可以直接填进本插件保存（加密存储，不进 DSH 凭证）
3. 回到主界面，右下角就会出现用量卡片，每 30s 自动刷新

## 使用说明

- 提供方实例的增删改、Key 设置都在 **设置 → 用量中心** 里完成，改动即时生效，无需重启
- 设置保存在本机浏览器中；删掉实例不会上传或泄露任何 Key
- 卡片拖动后的位置会自动保存，下次打开还是老位置

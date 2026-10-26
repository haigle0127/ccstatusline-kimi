<p align="center">
  <img src="icon.png" width="128" alt="ccstatusline-kimi icon">
</p>

<h1 align="center">ccstatusline-kimi</h1>

<p align="center">在 VSCode 底部状态栏显示 Claude Code + Kimi 实时状态：模型、Git 分支、Token、费用、上下文等。</p>

<p align="center">
  专为 <strong>Claude Code for VSCode + CcSwitch/Kimi</strong> 设计<br>
  开发者：haigle<br>
  GitHub：<a href="https://github.com/haigle0127/ccstatusline-kimi">https://github.com/haigle0127/ccstatusline-kimi</a>
</p>

## 数据来源

本扩展直接读取本机数据，不需要执行 Claude Code CLI：

- `~/.claude/sessions/*.json` — 活跃会话与当前工作目录
- `~/.claude/projects/<项目>/<会话>.jsonl` — 主会话、子代理和 workflow transcript；兼容旧版 `~/.claude/transcripts/*.jsonl`
- `~/.claude/settings.json` — 当前模型、思考力度等设置
- `~/.cc-switch/cc-switch.db` — 只读查询当前供应商、请求日志、每日汇总和模型定价
- `~/.cc-switch/settings.json` — 当前供应商与自定义 `claudeConfigDir`
- VSCode 内置 Git API — 当前分支、变更状态

SQLite 优先通过 `sqlite3 -readonly` 查询以读取 WAL 中已提交的数据；没有可用的 sqlite3 时自动使用内置的 `sql.js`。供应商 API Key、认证令牌等敏感配置不会进入状态 JSON 或 Webview。

## 安装

1. 在 VSCode 中按 `Ctrl+Shift+X`（或 `Cmd+Shift+X`）打开扩展面板。
2. 搜索 `ccstatusline-kimi` 并安装。
3. 安装完成后，底部状态栏会自动出现 Claude + Kimi 状态。

> 也可以打包成本地 `.vsix` 安装：
> ```bash
> npm install -g @vscode/vsce
> vsce package
> # 然后在 VSCode 中 "从 VSIX 安装"
> ```

## 使用

安装后扩展会自动启动，默认显示格式为：

```
$(comment-discussion) Kimi For Coding | main | ↑1.2K ↓3.4K | $0.015 | 已用45.2K
```

### 可自定义的占位符

在 VSCode 设置中搜索 `ccstatusline.format`，使用以下占位符：

| 占位符 | 说明 |
|--------|------|
| `{model}` | 最近一次主链响应的实际模型；尚无响应时回退到供应商 `ANTHROPIC_MODEL` 或 Claude 配置 |
| `{provider}` | 当前 CcSwitch 供应商名称（未使用 CcSwitch 时不显示） |
| `{thinking-effort}` | 思考力度设置 |
| `{git-branch}` | 当前 Git 分支 |
| `{git-status}` | Git 状态摘要（↑↓ +*?!） |
| `{tokens-input}` | 输入 Token 数 |
| `{tokens-output}` | 输出 Token 数 |
| `{tokens-cached}` | 缓存 Token 数 |
| `{tokens-total}` | 总 Token 数 |
| `{cost}` | 预估会话费用（按 CC Switch 模型定价；缺定价时显示 `—`，部分缺失时显示 `*`） |
| `{session-duration}` | 当前会话持续时间 |
| `{context-length}` | 当前上下文长度 |
| `{context-pct}` | 上下文窗口使用百分比（估算） |
| `{session-id}` | 当前会话 ID 前 8 位 |
| `{cwd}` | 当前工作目录 |
| `{claude-version}` | Claude Code 扩展版本 |

### 用量统计面板

点击状态栏，或执行 `ccstatusline.showHistory` 打开统计面板：

- 今日、昨日、近 7 天、本周、近 30 天、本月筛选
- 总 Token、估算成本、请求数、缓存命中率四项核心指标
- 可切换指标的小时／每日趋势图，以及 Token 构成和缓存效率
- 每日、模型、供应商明细；图表支持悬停和键盘查看，表格展示完整数值
- 适配 VSCode 深浅主题与窄面板，保留可互动的小章鱼

面板优先使用 CC Switch 请求记录；当前范围没有数据库记录时回退到 Claude transcript。不会把同一范围的两个来源相加。流式 transcript 按 `message.id` 去重，CC Switch 会话／代理重复记录也会按相同指纹过滤。

### 配置项

| 配置项 | 说明 |
|--------|------|
| `ccstatusline.enabled` | 是否启用状态栏 |
| `ccstatusline.refreshInterval` | 刷新间隔（毫秒，默认 2000） |
| `ccstatusline.format` | 状态栏显示格式 |
| `ccstatusline.showWhenIdle` | 无活跃会话时是否显示最后状态 |
| `ccstatusline.hideAfterMs` | 多久无更新后隐藏（0 表示不隐藏） |

### 命令

- `ccstatusline.showHistory` — 打开 Claude Code 用量统计面板
- `ccstatusline.refresh` — 手动刷新状态栏
- `ccstatusline.openSettings` — 打开设置
- `ccstatusline.copyStatusJson` — 复制当前状态 JSON 到剪贴板

## 示例格式

```text
$(comment-discussion) {model} | {git-branch} {git-status} | {tokens-input} {tokens-output} | {cost}
```

```text
{model} [{thinking-effort}] | {git-branch} | 已用{context-length} | {session-duration}
```

## 数据口径与限制

- **Token 总量**：新增输入 + 模型输出 + 缓存写入 + 缓存读取；缓存命中率 = 缓存读取 ÷（新增输入 + 缓存写入 + 缓存读取）。
- **费用为估算值**：按 CC Switch 的 `model_pricing` 和供应商成本倍率计算，不等于供应商账单。已有非零成本会保留；缺少模型价格时明确显示“未定价”，不会伪装成 `$0`。一小时缓存写入按五分钟缓存写入价格的 1.6 倍估算。
- **上下文为估算值**：取主链最近一次请求的输入、缓存与本轮输出；优先使用供应商配置的上下文窗口，未配置时再按模型推断。
- **成功率仅来自请求日志**：纯 transcript 数据没有 HTTP 状态，因此不显示成功率。
- **本地读取**：统计来自本机 Claude/CC Switch 数据；历史明细是否完整取决于本地记录和 CC Switch 的保留策略。

## 许可证

MIT

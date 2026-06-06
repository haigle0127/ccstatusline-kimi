# ccstatusline-kimi

在 VSCode 底部状态栏显示 Claude Code + Kimi 实时状态：模型、Git 分支、Token、费用、上下文等。

> 专为 **Claude Code for VSCode + CcSwitch/Kimi** 设计。
>
> 开发者：haigle  
> GitHub：[https://github.com/haigle0127/ccstatusline-kimi](https://github.com/haigle0127/ccstatusline-kimi)

## 数据来源

本扩展**不依赖 Claude Code CLI**，而是直接读取 Claude Code for VSCode 扩展在本地的状态文件：

- `~/.claude/sessions/*.json` — 活跃会话信息
- `~/.claude/transcripts/*.jsonl` — 会话 transcript（用于计算 Token、费用、持续时间）
- `~/.claude/settings.json` — 当前模型、思考力度等设置
- `~/.cc-switch/cc-switch.db` + `~/.cc-switch/settings.json` — CcSwitch 当前供应商与模型（如果你使用 CcSwitch 中转）
- VSCode 内置 Git API — 当前分支、变更状态

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
| `{model}` | 当前模型。CcSwitch 用户显示供应商名；如果 provider 设置了 `ANTHROPIC_MODEL` 则显示具体模型 |
| `{provider}` | 当前 CcSwitch 供应商名称（未使用 CcSwitch 时不显示） |
| `{thinking-effort}` | 思考力度设置 |
| `{git-branch}` | 当前 Git 分支 |
| `{git-status}` | Git 状态摘要（↑↓ +*?!） |
| `{tokens-input}` | 输入 Token 数 |
| `{tokens-output}` | 输出 Token 数 |
| `{tokens-cached}` | 缓存 Token 数 |
| `{tokens-total}` | 总 Token 数 |
| `{cost}` | 预估会话费用（按当前模型费率估算） |
| `{session-duration}` | 当前会话持续时间 |
| `{context-length}` | 当前上下文长度 |
| `{context-pct}` | 上下文窗口使用百分比（估算） |
| `{session-id}` | 当前会话 ID 前 8 位 |
| `{cwd}` | 当前工作目录 |
| `{claude-version}` | Claude Code 扩展版本 |

### 配置项

| 配置项 | 说明 |
|--------|------|
| `ccstatusline.enabled` | 是否启用状态栏 |
| `ccstatusline.refreshInterval` | 刷新间隔（毫秒，默认 2000） |
| `ccstatusline.format` | 状态栏显示格式 |
| `ccstatusline.showWhenIdle` | 无活跃会话时是否显示最后状态 |
| `ccstatusline.hideAfterMs` | 多久无更新后隐藏（0 表示不隐藏） |

### 命令

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

## 已知限制

- **费用为估算值**：Claude Code 本地 transcript 不直接包含费用，本扩展按当前模型公开费率从 Token 数估算。第三方供应商（CcSwitch）的价格可能与估算不同。
- **上下文百分比为估算**：按模型默认窗口（Sonnet 200K / 1M）估算，实际窗口可能因会话而异。
- **仅支持 Claude Code for VSCode**：不支持 Claude Code CLI 或 Claude Web。
- **CcSwitch 模型显示**：当 CcSwitch provider 未设置 `ANTHROPIC_MODEL` 时，只能显示 Claude settings 中的 family 名（如 `sonnet`），不一定等于中转后实际调用的模型。

## 许可证

MIT

# agent-bridge

零依赖的本地 AI 编程代理互调桥：同时提供 **STDIO MCP Server** 与 **CLI** 入口，支持将 **Codex CLI**、**Claude Code**、**Command Code**、**DeepSeek Harness (DSH)** 和 **Antigravity CLI** 统一封装为可被任意 MCP 客户端或脚本调度的代理工具。

```text
agent-bridge/
├─ agent-bridge.mjs        MCP Server 与 CLI 派发入口
├─ agents.example.json     能力清单模板（复制为 agents.json 使用）
├─ dsh-jsonrpc.mjs         DSH SDK JSON-RPC 启动器（支持多轮 session/resume 与进度快照）
├─ dsh-file-tools.mjs      DSH 受限文件工具插件
├─ agy-runner.mjs          Antigravity CLI 启动器
├─ workspace-files.mjs     写边界与原子落盘安全校验
├─ workspace-files-mcp.mjs Antigravity 写模式专用受限文件 MCP 服务
├─ register.ps1            快速注册/卸载到 Codex / Claude Code 的 PowerShell 脚本
└─ LICENSE                 MIT 许可证
```

---

## 一、快速开始

### 1. 生成本地配置

将模板复制为 `agents.json`（已由 `.gitignore` 忽略，不会被提交）：

```powershell
Copy-Item agents.example.json agents.json
```

按本机环境编辑 `agents.json`：
- 将各 agent 的 `launcher.win` / `launcher.posix` 改为本机实际命令或脚本路径（例如 `dsh-jsonrpc.mjs` 与 `agy-runner.mjs` 的绝对路径）；
- 将 `dsh.writeRoots` 与 `antigravity.writeRoots` 设为允许在 `write` 模式下修改的根目录列表。

> 如不想修改默认文件名，也可通过环境变量 `AGENT_BRIDGE_CONFIG` 指定配置文件路径。

### 2. DSH 环境变量（可选）

`dsh-jsonrpc.mjs` 与 `dsh-file-tools.mjs` 默认从 `C:\Program Files\DeepSeek Harness` 查找 DeepSeek Harness 桌面版；若安装目录或目标模型路由不同，可按需配置以下环境变量：

| 环境变量 | 说明 | 默认值 |
|---|---|---|
| `DSH_INSTALL_DIR` | DeepSeek Harness 桌面端安装目录 | `C:\Program Files\DeepSeek Harness` |
| `DSH_BRIDGE_PROVIDER` | DSH 桌面配置中的 provider 名称 | `cmdc` |
| `DSH_BRIDGE_MODEL` | 模型 ID | `deepseek/deepseek-v4.1-flash` |
| `DSH_BRIDGE_REASONING_EFFORT` | 推理强度键名 | `high` |
| `DSH_BRIDGE_API_KEY_ENV` | 校验路由配置时预期的 `apiKeyEnv` 字段值 | `CMDC_API_KEY` |

### 3. 注册为 STDIO MCP 服务

通用 `mcpServers` JSON 配置示例（适用于支持 STDIO MCP 的任意客户端）：

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": [
        "C:\\path\\to\\agent-bridge\\agent-bridge.mjs",
        "serve"
      ]
    }
  }
}
```

也可按客户端 CLI 手动注册（或直接运行随附的 `.\register.ps1` 注册到 Codex / Claude Code）：

```powershell
$bridge = 'C:\path\to\agent-bridge\agent-bridge.mjs'

codex mcp add agent-bridge -- node $bridge serve
claude mcp add --scope user agent-bridge -- node $bridge serve
agy mcp add --type stdio agent-bridge node $bridge serve
```

---

## 二、MCP 工具说明

服务启动后暴露 5 个工具（协议版本默认回显客户端请求值，fallback 为 `2025-06-18`）：

| 工具 | 参数 | 作用 |
|---|---|---|
| `list_agents` | `{}` | 返回所有已配置 agent 的能力清单（`label`、`desc`、`edits`、`cost`、`avgMinutes`、`timeoutSec`、`noHardTimeout`、`idleTimeoutSec`、`supportsSession`） |
| `ask_agent` | `{ agent, task, mode?, cwd?, sessionId?, timeoutSec?, idleTimeoutSec? }` | 同步委派给目标 agent 运行一轮并等待最终结果 |
| `start_agent` | `{ agent, task, mode?, cwd?, sessionId?, timeoutSec?, idleTimeoutSec? }` | 异步启动独立后台任务，立即返回 `jobId`（及适用时的 `sessionId`） |
| `check_agent` | `{ jobId, tailEvents? }` | 巡检异步任务状态、已运行与空闲秒数、当前活动工具及最近事件摘要；任务结束后返回完整输出 |
| `cancel_agent` | `{ jobId }` | 将任务标记为 `cancelled` 并强制终止关联进程树 |

`mode` 支持两档：`read`（默认，只读分析）与 `write`（允许修改文件）。

### DSH 长任务超时与多轮上下文接力

- **空闲看门狗替代 5 分钟硬超时**：`agents.example.json` 中 `dsh` 配置了 `noHardTimeout: true` 与 `idleTimeoutSec: 900`（`timeoutSec: 7200` 仅在显式覆写或未关闭硬超时时作为上限），即取消 5 分钟总时长硬超时，改为**连续 15 分钟（900 秒）无新事件或输出时判定卡死并终止**。
- **原生 `session/resume` 多轮接力**：首次调用 `dsh`（`ask_agent` 或 `start_agent`）会分配并持久化一个 `sessionId`；后续在相同 `cwd` 与相同 `mode` 下传入该 `sessionId`，`dsh-jsonrpc.mjs` 会先通过 DSH SDK 的 `session/resume` 恢复上下文，再发送新一轮 `session/prompt` 实现多轮对话接力。
- **工具级实时进度**：异步运行 `dsh` 时会实时刷新 `.progress.json` 快照，通过 `check_agent` 可直接观测 `toolCallCount`、`activeTool`、`calledTools`、`recentEvents` 与 `lastAssistantPreview`。

---

## 三、CLI 用法

不通过 MCP 时，可直接以 CLI 模式运行：

```powershell
$bridge = 'C:\path\to\agent-bridge\agent-bridge.mjs'

# 查看能力清单
node $bridge list

# 同步调用（只读）
node $bridge ask dsh "分析当前目录结构并输出总结。" --mode read --cwd "C:\path\to\your-workspace" --timeout 120

# 使用上一轮返回的 sessionId 进行多轮续聊
node $bridge ask dsh "补充列出关键入口文件。" --mode read --cwd "C:\path\to\your-workspace" --session-id "<sessionId>"

# 异步启动、巡检与取消
node $bridge start dsh "执行完整只读代码审查。" --mode read --cwd "C:\path\to\your-workspace" --idle-timeout 900
node $bridge check "<jobId>" --tail 10
node $bridge cancel "<jobId>"
```

---

## 四、安全护栏

| 机制 | 说明 |
|---|---|
| `AGENT_DEPTH` 防递归 | bridge 会向子进程注入 `AGENT_DEPTH + 1`；达到 `AGENT_BRIDGE_MAX_DEPTH`（默认 `1`）时拒绝继续委派，防止 `A → B → A` 死循环 |
| `AGENT_BRIDGE_ALLOW` | 可选的允许工作目录根列表（系统路径分隔符分隔，Windows 为 `;`）；未设置时不限制 |
| `writeRoots` 真实路径防越界 | `workspace-files.mjs` 会逐级检查普通目录与 `realpathSync.native`，拒绝符号链接、目录联接点（junction）、多重硬链接、UNC/设备路径及 `.git`/`.agents`/`.codex`/`.aws` 等保护目录，并在写入前后双重校验文件未篡改后原子落盘 |
| `session.lock` 并发互斥 | `dsh` 会话状态保存在 `%LOCALAPPDATA%\agent-bridge\dsh-sessions\<sessionId>\`（默认保留 7 天自动清理），通过 `session.lock`（`wx` 排他锁 + PID 存活检测）禁止同一会话并发续聊 |
| 禁止 `read` 续聊提权为 `write` | `dsh-jsonrpc.mjs` 恢复会话时强制校验 `cwd`、`mode` 与 `writeRoot` 与原会话一致，严禁跨目录或从 `read` 提权为 `write` 续聊 |
| 进程树清理与日志脱敏 | 超时或取消时在 Windows 通过 `taskkill /PID ... /T /F` 清理整棵进程树；错误摘要会脱敏 `Bearer` 凭据，运行日志与异步任务状态存放在系统临时目录 `%TEMP%\agent-bridge\` |

---

## 五、前置依赖

1. **Node.js**：建议使用 Node.js 20+（零第三方 npm 依赖，仅使用 Node 内置模块）。
2. **目标 CLI**：按需在本地安装并登录对应工具（`codex`、`claude`、`cmdc`）。
3. **DeepSeek Harness (DSH)**：使用 `dsh` 目标需本机已安装 DeepSeek Harness 桌面版，并在桌面配置中存在对应 provider/model 路由与凭据引用。
4. **Antigravity CLI (`agy`)**：使用 `antigravity` 目标需本机安装 `agy.exe`（`%LOCALAPPDATA%\agy\bin\agy.exe`）；若启用 `write` 模式，需在 `%USERPROFILE%\.gemini\config\agents\bridge-file-editor.md` 配置专用角色并确保其 SHA-256 校验与 `agy-runner.mjs` 及 `workspace-files` 工具清单一致。

---

## 六、许可证

本项目基于 [MIT License](LICENSE) 开源。

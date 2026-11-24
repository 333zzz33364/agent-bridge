import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileOperations, parseWriteArguments } from './workspace-files.mjs';

const model = 'gemini-3.8-flash-medium';
const fileServer = 'workspace-files';
const agent = 'bridge-file-editor';
const agentHash = '85b0dcc71c7be34484dcb0658eed50c5b7fc796b7b2995dc31445951c0f67683';
const permitted = new Set(['view_file', 'read_file', 'list_dir', 'grep_search', 'finish', 'call_mcp_tool']);

async function run(task, writeRoot) {
  const profile = await readFile(join(homedir(), '.gemini', 'config', 'agents', `${agent}.md`));
  if (createHash('sha256').update(profile).digest('hex') !== agentHash) {
    throw new Error('Antigravity 专用角色与已核对的工具清单不一致');
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const agents = join(dir, '.agents', 'agents');
    if (existsSync(join(agents, `${agent}.md`)) || existsSync(join(agents, agent, 'agent.md'))) {
      throw new Error('工作区存在同名 Antigravity 角色');
    }
    if (dirname(dir) === dir) break;
  }
  const executable = join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  const settings = {
    allowNonWorkspaceAccess: false,
    toolPermission: 'request-review',
    permissions: {
      allow: writeRoot ? Object.keys(fileOperations).map((name) => `mcp(${fileServer}/${name})`) : [],
      deny: ['write_file(*)', 'command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', writeRoot ? 'mcp(agent-bridge/*)' : 'mcp(*)'],
    },
  };
  const child = spawn(executable, [
    '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--model', model, '--agent', agent, '--settings', JSON.stringify(settings),
    '--disable-slash-commands', '--print-timeout', '135s',
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_BRIDGE_WRITE_ROOT: writeRoot ?? '' },
  });

  let init;
  let result;
  let failure;
  let loginRequired = false;
  const completedTools = new Set();
  let boundaryDenials = 0;

  function reject(message) {
    failure ??= new Error(message);
    child.kill();
  }

  const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
  output.on('line', (line) => {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      failure ??= new Error('agy stdout 包含无法解析的事件');
      child.kill();
      return;
    }
    if (frame.event === 'init') {
      init = frame.init;
    }
    if (frame.event === 'step_update' && frame.step_update?.tool_name) {
      const step = frame.step_update;
      let name = step.tool_name;
      if (!permitted.has(name)) reject(`agy 请求了权限范围外的工具 ${name}`);
      if (name === 'call_mcp_tool') {
        const params = step.tool_info?.parameters;
        if (params) {
          if (!writeRoot || params.ServerName !== fileServer || !Object.hasOwn(fileOperations, params.ToolName)) {
            reject('agy 请求了本次未授权的 MCP 工具');
          }
          name = `${params.ServerName}/${params.ToolName}`;
        }
        if (JSON.stringify(step.tool_info ?? {}).includes('写入边界拒绝')) boundaryDenials++;
      }
      if (step.state === 'DONE') completedTools.add(name);
    }
    if (frame.event === 'result') result = frame.result;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    loginRequired ||= /please sign in|authentication required|not authenticated/i.test(chunk);
  });
  child.on('error', (error) => { failure ??= error; });
  child.stdin.on('error', (error) => { failure ??= error; });
  const exited = new Promise((done) => child.once('close', done));
  child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: task } })}\n`);
  const timer = setTimeout(() => {
    failure ??= new Error('agy 运行超时');
    child.kill();
  }, 155_000);
  const exitCode = await exited.finally(() => {
    clearTimeout(timer);
    output.close();
  });

  if (loginRequired) throw new Error('agy 需要登录 Google');
  if (failure) throw failure;
  if (/eligibility check failed|verify your account|not eligible/i.test(result?.error ?? '')) {
    throw new Error('Google 要求完成 Antigravity 账号资格验证');
  }
  if (exitCode !== 0 || result?.status !== 'SUCCESS' || !result.response?.trim()) {
    throw new Error(`agy 未返回成功结果（退出码 ${exitCode}，状态 ${result?.status ?? '缺失'}）`);
  }
  if (init?.permission_mode !== 'request-review') {
    throw new Error('agy 未报告已应用会话权限模式 request-review');
  }
  if (init.model !== model) {
    throw new Error('agy 初始化事件缺少指定的模型 ID，或报告了其他模型');
  }

  console.log(`Antigravity 模型 ${init.model}（本次 CLI 初始化事件）`);
  console.log(`Antigravity 权限 ${init.permission_mode}，结果 ${result.status}`);
  if (writeRoot) console.log(`Antigravity 写入边界拒绝 ${boundaryDenials} 次`);
  console.log(`Antigravity 实际完成的工具 ${[...completedTools].join(', ') || '无'}\n\n${result.response.trim()}`);
}

async function main() {
  const args = process.argv.slice(2);
  const base = ['--model', model];
  const config = process.env.AGENT_BRIDGE_CONFIG || new URL('./agents.json', import.meta.url);
  const roots = args.length > base.length ? JSON.parse(await readFile(config, 'utf8')).antigravity?.writeRoots : [];
  const writeRoot = parseWriteArguments(args, base, roots);
  let task = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) task += chunk;
  if (!task.trim()) throw new Error('Antigravity 子代理任务为空');
  await run(task, writeRoot);
}

main().catch((error) => {
  console.error(`Antigravity CLI: ${error.message}`);
  process.exitCode = 1;
});

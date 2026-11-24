import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fileOperations, parseWriteArguments } from './workspace-files.mjs';

const install = process.env.DSH_INSTALL_DIR || 'C:\\Program Files\\DeepSeek Harness';
const runtime = existsSync(join(install, 'resources', 'app', 'dsh', 'package.json'))
  ? join(install, 'resources', 'app', 'dsh')
  : join(install, 'resources', 'app.asar', 'dsh');
const desktopHome = join(homedir(), '.dsh');
const provider = process.env.DSH_BRIDGE_PROVIDER || 'cmdc';
const model = process.env.DSH_BRIDGE_MODEL || 'deepseek/deepseek-v4.1-flash';
const reasoningEffort = process.env.DSH_BRIDGE_REASONING_EFFORT || 'high';
const expectedApiKeyEnv = process.env.DSH_BRIDGE_API_KEY_ENV || 'CMDC_API_KEY';

const DEFAULT_IDLE_TIMEOUT_MS = 900_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 0;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ROOT = join(process.env.LOCALAPPDATA || tmpdir(), 'agent-bridge', 'dsh-sessions');
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const disabledPlugins = [
  'tool-plugin-manager', 'tool-working-directory', 'tool-bash',
  'tool-jobs', 'tool-skill', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
  'tool-workflow', 'tool-todo', 'tool-goal', 'tool-web', 'plan-mode',
];

function canonicalPath(value) {
  const abs = resolve(value);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function samePath(a, b) {
  return relative(canonicalPath(a), canonicalPath(b)) === '';
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parseNonNegativeInt(raw, flag) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(`参数 ${flag} 必须是非负整数，收到: ${String(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`参数 ${flag} 超出安全整数范围`);
  }
  return value;
}

function parseCliOptions(args) {
  const opts = {
    sessionId: undefined,
    resume: false,
    progressFile: undefined,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
  };
  const writeArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--resume') {
      opts.resume = true;
      continue;
    }
    if (arg === '--session-id') {
      const value = args[++i];
      if (!value || !SESSION_ID_RE.test(value)) {
        throw new Error('--session-id 格式无效（须为 8-64 位字母、数字、下划线或连字符）');
      }
      opts.sessionId = value;
      continue;
    }
    if (arg === '--progress-file') {
      const value = args[++i];
      if (!value || !value.trim()) {
        throw new Error('--progress-file 缺少有效路径');
      }
      opts.progressFile = resolve(value);
      continue;
    }
    if (arg === '--idle-timeout-ms') {
      if (i + 1 >= args.length) throw new Error('--idle-timeout-ms 缺少数值');
      opts.idleTimeoutMs = parseNonNegativeInt(args[++i], '--idle-timeout-ms');
      continue;
    }
    if (arg === '--timeout-ms') {
      if (i + 1 >= args.length) throw new Error('--timeout-ms 缺少数值');
      opts.totalTimeoutMs = parseNonNegativeInt(args[++i], '--timeout-ms');
      continue;
    }
    writeArgs.push(arg);
  }

  if (opts.resume && !opts.sessionId) {
    throw new Error('--resume 必须与 --session-id 同时提供');
  }
  return { opts, writeArgs };
}

function generateSessionId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const hex = randomBytes(3).toString('hex');
  return `dsh-${stamp}-${hex}`;
}

function acquireSessionLock(lockFile) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockFile);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let existing = null;
      try {
        existing = JSON.parse(readFileSync(lockFile, 'utf8'));
      } catch {}
      if (existing && isPidAlive(existing.pid)) {
        throw new Error(`该 DSH 会话正在运行中（pid=${existing.pid}），禁止并发续聊`);
      }
      try {
        rmSync(lockFile, { force: true });
      } catch {}
    }
  }
  throw new Error('无法获取 DSH 会话并发锁');
}

function cleanupExpiredSessions(currentSessionId) {
  try {
    if (!existsSync(SESSION_ROOT)) return;
    const now = Date.now();
    for (const entry of readdirSync(SESSION_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentSessionId) continue;
      const dir = join(SESSION_ROOT, entry.name);
      try {
        const lockFile = join(dir, 'session.lock');
        if (existsSync(lockFile)) {
          let lockData = null;
          try {
            lockData = JSON.parse(readFileSync(lockFile, 'utf8'));
          } catch {}
          if (lockData && isPidAlive(lockData.pid)) continue;
        }
        let lastTime = statSync(dir).mtimeMs;
        const metaFile = join(dir, 'meta.json');
        if (existsSync(metaFile)) {
          try {
            const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
            const parsed = Date.parse(meta.updatedAt || meta.createdAt || '');
            if (Number.isFinite(parsed)) lastTime = Math.max(lastTime, parsed);
          } catch {}
        }
        if (now - lastTime > SESSION_TTL_MS) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

function killTree(pid, child) {
  if (process.platform === 'win32' && Number.isInteger(pid) && pid > 0) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {}
  }
  try {
    child?.kill();
  } catch {}
}

async function readSelectedRoute() {
  const profile = join(desktopHome, 'profiles', 'desktop', 'cordis.patch.yml');
  let parseDocument;
  try {
    ({ parseDocument } = createRequire(join(runtime, 'package.json'))('yaml'));
  } catch {
    const raw = execFileSync(join(install, 'DeepSeek Harness.exe'), [fileURLToPath(import.meta.url), '--dump-route'], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    return JSON.parse(raw);
  }
  const document = parseDocument(await readFile(profile, 'utf8'));
  if (document.errors.length) throw new Error('DSH 桌面配置的 YAML 无法解析');
  const row = document.toJS().find((entry) => entry?.id === 'llm-pi-ai');
  const route = row?.config?.providers?.[provider];
  const selectedModel = route?.models?.find((entry) => entry?.id === model);
  if (route?.apiKeyEnv !== expectedApiKeyEnv || !selectedModel?.reasoningEfforts?.[reasoningEffort]) {
    throw new Error('DSH 桌面配置缺少指定的 cmdc Flash 模型、推理强度或凭据引用');
  }
  const endpoint = new URL(route.baseURL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('DSH 模型端点应是纯 HTTPS 地址');
  }
  const sessionHeader = route.headers?.['x-opencode-session'];
  return {
    api: route.api,
    apiKeyEnv: route.apiKeyEnv,
    baseURL: route.baseURL,
    ...(typeof sessionHeader === 'string' ? { headers: { 'x-opencode-session': sessionHeader } } : {}),
    models: [selectedModel],
  };
}

async function sdkPatch(writeRoot) {
  const selectedRoute = await readSelectedRoute();
  return [
    { id: 'llm-pi-ai', config: { providers: { [provider]: selectedRoute } } },
    { id: 'credentials', config: { path: join(desktopHome, '.credentials.yaml'), watch: false } },
    { id: 'tool-fs', config: { read: true, readImage: true, write: false, edit: false } },
    { id: 'pwsh-sandbox', config: { timeoutMs: 600_000, maxTimeoutMs: 1_800_000 } },
    { id: 'tool-pwsh', config: { enableRunInBackground: false, promoteOnTimeout: false } },
    ...disabledPlugins.map((id) => ({ id, disabled: true })),
    ...(writeRoot ? [{ insert: [{ id: 'bridge-file-tools', name: new URL('./dsh-file-tools.mjs', import.meta.url).href, config: { root: writeRoot } }] }] : []),
  ];
}

function runSdk({
  workdir,
  home,
  patchFile,
  task,
  allowedTools,
  sessionId,
  resume,
  mode,
  progressFile,
  idleTimeoutMs,
  totalTimeoutMs,
}) {
  const executable = join(install, 'DeepSeek Harness.exe');
  const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const child = spawn(executable, ['--expose-internals', cli, '--profile', 'sdk', '--patch', patchFile], {
    cwd: workdir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_MAX_TOKENS_AS_SUCCESS: 'false',
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  const pending = new Map();
  const calledTools = new Set();
  let boundaryDenials = 0;
  let requestId = 0;
  let actualRoute;
  let advertisedTools;
  let completed;
  let turnError;
  let finalText = '';
  let failure;
  let closed = false;
  let cancelled = false;
  let promptSent = false;
  let startupError = '';
  let lastActivityAt = Date.now();

  const progress = {
    sessionId,
    resume,
    cwd: workdir,
    mode,
    status: 'starting',
    startedAt: new Date().toISOString(),
    lastActivityAt,
    toolCallCount: 0,
    activeTool: null,
    calledTools: [],
    recentEvents: [],
    lastAssistantPreview: '',
    error: null,
  };

  function pushRecentEvent(entry) {
    progress.recentEvents.push({ at: new Date().toISOString(), ...entry });
    if (progress.recentEvents.length > 30) {
      progress.recentEvents.splice(0, progress.recentEvents.length - 30);
    }
  }

  function flushProgress() {
    if (!progressFile) return;
    try {
      mkdirSync(dirname(progressFile), { recursive: true });
      const payload = JSON.stringify(progress, null, 2);
      const tmp = `${progressFile}.${process.pid}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      try {
        renameSync(tmp, progressFile);
      } catch {
        writeFileSync(progressFile, payload, 'utf8');
        try {
          unlinkSync(tmp);
        } catch {}
      }
    } catch {}
  }

  function touchActivity() {
    lastActivityAt = Date.now();
    progress.lastActivityAt = lastActivityAt;
  }

  flushProgress();

  const exit = new Promise((done) => child.once('close', (code, signal) => {
    closed = true;
    abort(new Error(`DSH SDK 进程退出（${code ?? signal}）${startupError ? `。${startupError}` : ''}`));
    done(code);
  }));

  function abort(error) {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  }

  function request(method, params = {}) {
    if (failure) return Promise.reject(failure);
    const id = ++requestId;
    return new Promise((accept, reject) => {
      pending.set(id, { accept, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function verifyRoute(source) {
    if (source?.provider !== provider || source?.model !== model) {
      throw new Error('DSH 实际会话路由与指定的 Flash 模型不一致');
    }
  }

  function onEvent(event) {
    if (!promptSent) return;
    const { type, data } = event;
    if (type === 'request/header' && data.header) {
      verifyRoute(data.header.config);
      advertisedTools = (data.header.tools ?? []).map(({ name }) => name);
      const advertisedSet = new Set(advertisedTools);
      const missing = [...allowedTools].filter((name) => !advertisedSet.has(name));
      const forbidden = advertisedTools.filter((name) => !allowedTools.has(name) && /^(bash|write|edit|web|subagent|workflow|plugin)/i.test(name));
      if (missing.length || forbidden.length) {
        throw new Error(`DSH 工具清单不符合权限配置（missing=${missing.join(',') || '无'}, forbidden=${forbidden.join(',') || '无'}）`);
      }
      pushRecentEvent({ type: 'request/header', tools: advertisedTools.length });
      flushProgress();
    }
    if (type === 'tool/call') {
      if (!allowedTools.has(data.name)) throw new Error(`DSH 请求了权限范围外的工具 ${data.name}`);
      calledTools.add(data.name);
      progress.toolCallCount += 1;
      progress.activeTool = data.name;
      progress.calledTools = [...calledTools];
      pushRecentEvent({ type: 'tool/call', tool: data.name });
      flushProgress();
    }
    if (type === 'tool/result') {
      if (data.message?.isError && JSON.stringify(data.message).includes('写入边界拒绝')) {
        boundaryDenials++;
      }
      progress.activeTool = null;
      pushRecentEvent({ type: 'tool/result', tool: data.name ?? null, isError: Boolean(data.message?.isError) });
      flushProgress();
    }
    if (type === 'assistant/message') {
      const { source, content } = data.message;
      verifyRoute(source);
      const text = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
      if (text) progress.lastAssistantPreview = text.slice(0, 500);
      const hasToolCall = content.some((block) => block.type === 'tool-call');
      if (!data.interrupted && !hasToolCall) {
        finalText = text;
        actualRoute = `${source.provider} / ${source.model}`;
      }
      pushRecentEvent({ type: 'assistant/message', hasToolCall });
      flushProgress();
    }
    if (type === 'turn/end') {
      completed = data.reason.kind;
      if (completed === 'error') turnError = data.reason.error;
      progress.activeTool = null;
      pushRecentEvent({ type: 'turn/end', kind: completed });
      flushProgress();
    }
    if (type === 'session.status') {
      pushRecentEvent({ type: 'session.status', data });
      flushProgress();
    }
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (chunk && chunk.length > 0) touchActivity();
    const headline = chunk.split(/\r?\n/).find((line) => /^(?:DSH|dsh:|Error:|TypeError:|node:internal)/.test(line));
    if (headline && !/credential|secret|token|api.?key|authorization/i.test(headline)) startupError = headline.slice(0, 400);
  });
  child.once('error', (error) => abort(error));
  child.stdin.on('error', (error) => abort(error));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (failure || !line.trim()) return;
    try {
      const frame = JSON.parse(line);
      touchActivity();
      if (pending.has(frame.id)) {
        const waiter = pending.get(frame.id);
        pending.delete(frame.id);
        if (frame.error) waiter.reject(new Error(frame.error.message));
        else waiter.accept(frame.result);
      } else if (frame.method === 'session.event' && frame.params?.sessionId === sessionId) {
        onEvent(frame.params.event);
      } else if (frame.method === 'session.status' && (!frame.params?.sessionId || frame.params.sessionId === sessionId)) {
        if (promptSent) {
          pushRecentEvent({ type: 'session.status', status: frame.params?.status ?? frame.params });
          flushProgress();
        }
      }
    } catch (error) {
      abort(error);
      killTree(child.pid, child);
    }
  });

  const idleTimer = idleTimeoutMs > 0
    ? setInterval(() => {
        if (Date.now() - lastActivityAt >= idleTimeoutMs) {
          const error = new Error(`DSH SDK 连续 ${Math.round(idleTimeoutMs / 1000)} 秒无新事件/输出，判定卡死终止`);
          progress.status = 'failed';
          progress.activeTool = null;
          progress.error = error.message;
          flushProgress();
          abort(error);
          killTree(child.pid, child);
        }
      }, 5000)
    : null;

  const totalTimer = totalTimeoutMs > 0
    ? setTimeout(() => {
        const error = new Error(`DSH SDK 超时（${Math.round(totalTimeoutMs / 1000)} 秒）`);
        progress.status = 'failed';
        progress.activeTool = null;
        progress.error = error.message;
        flushProgress();
        abort(error);
        killTree(child.pid, child);
      }, totalTimeoutMs)
    : null;

  const onSignal = (sig) => {
    cancelled = true;
    const error = new Error(`DSH SDK 收到信号 ${sig}，已取消`);
    progress.status = 'cancelled';
    progress.activeTool = null;
    progress.error = error.message;
    flushProgress();
    abort(error);
    killTree(child.pid, child);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return (async () => {
    try {
      const init = await request('initialize', { cwd: workdir, provider, model, reasoningEffort });
      if (init?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('DSH SDK 握手返回了未知运行时');
      if (resume) {
        progress.status = 'resuming';
        pushRecentEvent({ type: 'session/resume' });
        flushProgress();
        await request('session/resume', { sessionId });
      }
      promptSent = true;
      progress.status = 'running';
      pushRecentEvent({ type: 'session/prompt' });
      flushProgress();
      await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: task }] });
      await request('session/wait', { sessionId });
      if (turnError) {
        const code = /^[A-Z0-9_-]+$/.test(turnError.code) ? turnError.code : 'UNKNOWN';
        const detail = String(turnError.message ?? '');
        const signal = detail.match(/(?:HTTP\s*(?:status\s*)?[1-5]\d\d|(?:ECONN|ENET|EHOST|EAI|ETIMEDOUT|UND_ERR_)[A-Z_]+|fetch failed|no credential|network connection)/i)?.[0];
        throw new Error(`DSH 模型请求失败（${code}${signal ? `，${signal}` : ''}）`);
      }
      if (completed !== 'completed' || !finalText || !actualRoute || !advertisedTools) {
        throw new Error(`DSH 没有正常返回最终文本（turn/end=${completed ?? '缺失'}）`);
      }
      await request('shutdown');
      if (await exit !== 0) throw failure;
      progress.status = 'completed';
      progress.activeTool = null;
      flushProgress();
      return { actualRoute, advertisedTools, calledTools: [...calledTools], boundaryDenials, completed, finalText };
    } catch (error) {
      if (!cancelled) {
        progress.status = 'failed';
        progress.activeTool = null;
        progress.error = error?.message || String(error);
        flushProgress();
      }
      throw error;
    } finally {
      if (idleTimer) clearInterval(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      lines.close();
      if (!closed) killTree(child.pid, child);
      await exit;
    }
  })();
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--dump-route') {
    process.stdout.write(JSON.stringify(await readSelectedRoute()));
    return;
  }
  const { opts, writeArgs } = parseCliOptions(args);
  const base = ['--provider', provider, '--model', model];
  const config = process.env.AGENT_BRIDGE_CONFIG || new URL('./agents.json', import.meta.url);
  const roots = writeArgs.length > base.length ? JSON.parse(await readFile(config, 'utf8')).dsh?.writeRoots : [];
  const writeRoot = parseWriteArguments(writeArgs, base, roots);
  const mode = writeRoot ? 'write' : 'read';

  process.stdin.setEncoding('utf8');
  let task = '';
  for await (const chunk of process.stdin) task += chunk;
  if (!task.trim()) throw new Error('DSH 子代理任务为空');

  const workdir = canonicalPath(process.cwd());
  const sessionId = opts.sessionId || generateSessionId();
  cleanupExpiredSessions(sessionId);

  const sessionDir = join(SESSION_ROOT, sessionId);
  const home = join(sessionDir, 'dsh-home');
  const metaFile = join(sessionDir, 'meta.json');
  const lockFile = join(sessionDir, 'session.lock');

  if (opts.resume) {
    if (!existsSync(metaFile)) {
      throw new Error(`找不到可恢复的 DSH 会话: ${sessionId}`);
    }
    const existingMeta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (!existingMeta.cwd || !samePath(existingMeta.cwd, workdir)) {
      throw new Error(`DSH 续聊工作目录与原会话不一致（原: ${existingMeta.cwd}，当前: ${workdir}）`);
    }
    if (existingMeta.mode !== mode) {
      throw new Error(`DSH 会话模式不一致：原会话为 ${existingMeta.mode}，当前为 ${mode}（禁止跨模式续聊）`);
    }
    if (mode === 'write' && (!existingMeta.writeRoot || !samePath(existingMeta.writeRoot, writeRoot))) {
      throw new Error('DSH 写模式续聊的授权目录与原会话不一致');
    }
  } else if (existsSync(metaFile)) {
    throw new Error(`DSH 会话已存在: ${sessionId}（如需续聊请传 --resume）`);
  }

  mkdirSync(home, { recursive: true });
  const releaseLock = acquireSessionLock(lockFile);
  try {
    let meta;
    if (opts.resume) {
      if (!existsSync(metaFile)) {
        throw new Error(`找不到可恢复的 DSH 会话: ${sessionId}`);
      }
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } else {
      if (existsSync(metaFile)) {
        throw new Error(`DSH 会话已存在: ${sessionId}（如需续聊请传 --resume）`);
      }
      const nowIso = new Date().toISOString();
      meta = {
        sessionId,
        createdAt: nowIso,
        updatedAt: nowIso,
        cwd: workdir,
        mode,
        writeRoot: writeRoot ? canonicalPath(writeRoot) : null,
        turns: 0,
        provider,
        model,
      };
      writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
    }

    const patch = await sdkPatch(writeRoot);
    const patchFile = join(home, 'bridge.patch.yml');
    await writeFile(patchFile, JSON.stringify(patch), { mode: 0o600 });
    const allowedTools = new Set(['read', 'read_image', 'glob', 'grep', 'pwsh', ...(writeRoot ? Object.keys(fileOperations) : [])]);
    const result = await runSdk({
      workdir,
      home,
      patchFile,
      task,
      allowedTools,
      sessionId,
      resume: opts.resume,
      mode,
      progressFile: opts.progressFile,
      idleTimeoutMs: opts.idleTimeoutMs,
      totalTimeoutMs: opts.totalTimeoutMs,
    });

    meta.turns = (Number(meta.turns) || 0) + 1;
    meta.updatedAt = new Date().toISOString();
    writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');

    console.log(`DSH 会话ID ${sessionId}（模式: ${mode}，续聊: ${opts.resume ? '是' : '否'}）`);
    console.log(`DSH 模型路由（会话事件） ${result.actualRoute}`);
    console.log(`DSH 工具 ${result.advertisedTools.join(', ')}，实际调用 ${result.calledTools.join(', ') || '无'}`);
    if (writeRoot) console.log(`DSH 写入边界拒绝 ${result.boundaryDenials} 次`);
    console.log(`DSH turn/end ${result.completed}\n\n${result.finalText}`);
  } finally {
    releaseLock();
  }
}

main().catch((error) => {
  const message = String(error.message).replace(/(Bearer\s+)[^\s,]+/gi, '$1[redacted]');
  console.error(`DSH JSON-RPC: ${message.slice(0, 800)}`);
  process.exitCode = 1;
});

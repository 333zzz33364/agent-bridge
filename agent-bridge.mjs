#!/usr/bin/env node
/**
 * agent-bridge —— 零依赖的 agent 互调桥
 *
 * 把 codex / claude / cmdc / dsh / antigravity 变成"工具"，任何 MCP 客户端都能调用；
 * 同时提供 CLI（含同步 ask、异步 start/check/cancel）。
 *
 * 用法:
 *   node agent-bridge.mjs serve                     # stdio MCP server（给客户端挂）
 *   node agent-bridge.mjs list                      # 打印能力清单
 *   node agent-bridge.mjs ask <agent> "任务" [--mode read|write] [--cwd DIR] [--session-id ID] [--timeout SEC] [--idle-timeout SEC]
 *   node agent-bridge.mjs start <agent> "任务" [--mode read|write] [--cwd DIR] [--session-id ID] [--timeout SEC] [--idle-timeout SEC]
 *   node agent-bridge.mjs check <jobId> [--tail N]
 *   node agent-bridge.mjs cancel <jobId>
 *
 * 环境变量:
 *   AGENT_BRIDGE_CONFIG     能力清单路径（默认同目录 agents.json）
 *   AGENT_BRIDGE_ALLOW      允许的工作目录根，分号分隔；不设则不限制
 *   AGENT_DEPTH             当前委派深度（由 bridge 自己传给子进程）
 *   AGENT_BRIDGE_MAX_DEPTH  最大委派深度，默认 1
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { authorizeWriteDirectory } from "./workspace-files.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const CFG_PATH = process.env.AGENT_BRIDGE_CONFIG || path.join(HERE, "agents.json");
const DEPTH = Number(process.env.AGENT_DEPTH || 0);
const MAX_DEPTH = Number(process.env.AGENT_BRIDGE_MAX_DEPTH || 1);
const LOG_DIR = path.join(os.tmpdir(), "agent-bridge");
const JOBS_DIR = path.join(LOG_DIR, "jobs");
const SERVER_INFO = { name: "agent-bridge", version: "1.1.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const JOB_ID_RE = /^[a-zA-Z0-9_-]{8,80}$/;

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

function loadAgents() {
  const agents = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  const names = Object.keys(agents).filter((k) => !k.startsWith("_"));
  return { agents, names };
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = JSON.stringify(obj, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, payload, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    fs.writeFileSync(filePath, payload, "utf8");
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function killProcessTree(pid, child) {
  if (IS_WIN && Number.isInteger(pid) && pid > 0) {
    try {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => {});
    } catch {}
  }
  try {
    if (child) child.kill();
    else if (!IS_WIN && Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL");
  } catch {}
}

/* ─────────────── 执行层 ─────────────── */

function pickLauncher(cfg) {
  const L = cfg.launcher || {};
  const raw = IS_WIN ? (L.win || L.posix) : (L.posix || L.win);
  if (!raw) throw new Error("launcher 未配置");
  const spec = typeof raw === "string"
    ? { kind: raw.endsWith(".ps1") ? "ps1" : /\.(mjs|cjs|js)$/.test(raw) ? "node" : "cmd", path: raw }
    : raw;
  const { kind = "cmd", path: p } = spec;
  if (!p) throw new Error("launcher.path 为空");
  if (kind === "cmd") return { cmd: p, prefix: [] };
  if (!fs.existsSync(p)) throw new Error(`找不到启动器: ${p}`);
  switch (kind) {
    case "exe": return { cmd: p, prefix: [] };
    case "node": return { cmd: process.execPath, prefix: [p] };
    case "ps1": return { cmd: "powershell", prefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p] };
    default: throw new Error(`未知 launcher.kind: ${kind}`);
  }
}

function resolveCwd(input) {
  const cwd = path.resolve(input || process.cwd());
  if (!fs.existsSync(cwd)) throw new Error(`cwd 不存在: ${cwd}`);
  const allow = (process.env.AGENT_BRIDGE_ALLOW || "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
  if (allow.length && !allow.some((r) => cwd === r || cwd.startsWith(r + path.sep))) {
    throw new Error(`cwd 不在允许范围（AGENT_BRIDGE_ALLOW）: ${cwd}`);
  }
  return cwd;
}

function prepareInvocation({ agent, task, mode = "read", cwd, sessionId, timeoutSec, idleTimeoutSec }) {
  if (DEPTH >= MAX_DEPTH) {
    throw new Error(`AGENT_DEPTH=${DEPTH} 已达上限 ${MAX_DEPTH}：子代理禁止继续委派，请自己完成任务`);
  }
  const { agents, names } = loadAgents();
  const cfg = agents[agent];
  if (!cfg) throw new Error(`未知 agent: ${agent}（可选: ${names.join(", ")}）`);

  if (typeof task !== "string" || !task.trim()) {
    throw new Error("task 不能为空");
  }
  if (cfg.edits === false && mode !== "read") throw new Error(agent.toUpperCase() + " 子代理仅支持只读模式");
  if (mode !== "read" && mode !== "write") throw new Error("mode 只能是 read 或 write");

  if (timeoutSec !== undefined && (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec < 0)) {
    throw new Error("timeoutSec 必须是非负数字");
  }
  if (idleTimeoutSec !== undefined && (typeof idleTimeoutSec !== "number" || !Number.isInteger(idleTimeoutSec) || idleTimeoutSec < 0)) {
    throw new Error("idleTimeoutSec 必须是非负整数");
  }

  let cleanSessionId;
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== "string") throw new Error("sessionId 必须是字符串");
    const trimmed = sessionId.trim();
    if (trimmed) {
      if (!SESSION_ID_RE.test(trimmed)) {
        throw new Error("sessionId 格式无效（须为 8-64 位字母、数字、下划线或连字符）");
      }
      if (cfg.supportsSession !== true) {
        throw new Error("目前仅 dsh 支持 sessionId 多轮上下文接力");
      }
      cleanSessionId = trimmed;
    }
  }

  const scopedWrite = mode === "write" && cfg.writeRoots !== undefined;
  if (scopedWrite && !cfg.argv.write) throw new Error("缺少已授权的写模式启动配置");
  const workdir = resolveCwd(scopedWrite ? authorizeWriteDirectory(cwd, cfg.writeRoots) : cwd);

  const now = new Date();
  const isoStamp = now.toISOString().replace(/[:.]/g, "-");
  const compactStamp = now.toISOString().replace(/[-:.]/g, "");
  const stamp = `${agent}-${isoStamp}-${randomBytes(2).toString("hex")}`;
  const outFile = path.join(LOG_DIR, `${stamp}.last.md`);
  const logFile = path.join(LOG_DIR, `${stamp}.log`);
  const argvTpl = cfg.argv[mode] || cfg.argv.read;

  const args = argvTpl.map((a) => a.replace("{cwd}", () => workdir).replace("{out}", () => outFile));
  const useStdin = cfg.input !== "argv";
  if (!useStdin) args.push(task);

  let finalSessionId = null;
  let resumed = false;
  let progressFile = null;
  let totalTimeoutMs;
  let idleTimeoutMs;

  if (agent === "dsh") {
    finalSessionId = cleanSessionId || `dsh-${compactStamp}-${randomBytes(3).toString("hex")}`;
    resumed = Boolean(cleanSessionId);
    totalTimeoutMs = timeoutSec !== undefined && timeoutSec > 0
      ? Math.round(timeoutSec * 1000)
      : (cfg.noHardTimeout ? 0 : (cfg.timeoutSec || 300) * 1000);
    idleTimeoutMs = idleTimeoutSec !== undefined
      ? idleTimeoutSec * 1000
      : (cfg.idleTimeoutSec || 0) * 1000;
    progressFile = path.join(LOG_DIR, `${stamp}.progress.json`);
    args.push("--session-id", finalSessionId);
    if (resumed) args.push("--resume");
    args.push(
      "--progress-file", progressFile,
      "--idle-timeout-ms", String(idleTimeoutMs),
      "--timeout-ms", String(totalTimeoutMs),
    );
  } else {
    totalTimeoutMs = timeoutSec === undefined
      ? (cfg.noHardTimeout ? 0 : (cfg.timeoutSec || 300) * 1000)
      : Math.round(timeoutSec * 1000);
    idleTimeoutMs = idleTimeoutSec !== undefined
      ? idleTimeoutSec * 1000
      : (cfg.idleTimeoutSec || 0) * 1000;
  }

  return {
    agent,
    cfg,
    task,
    mode,
    workdir,
    stamp,
    compactStamp,
    outFile,
    logFile,
    progressFile,
    args,
    useStdin,
    sessionId: finalSessionId,
    resumed,
    totalTimeoutMs,
    idleTimeoutMs,
  };
}

/** 起子进程跑一轮，prompt 走 stdin 或 argv，带超时/空闲看门狗与日志 */
function execAgent(name, cfg, args, { cwd, task, timeoutMs, idleTimeoutMs = 0, progressFile = null, onSpawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let out = "";
    let err = "";
    let timedOut = false;
    let idleTimedOut = false;
    let settled = false;
    let lastActivityAt = started;

    const { cmd, prefix } = pickLauncher(cfg);
    const child = spawn(cmd, [...prefix, ...args], {
      cwd,
      windowsHide: true,
      env: { ...process.env, ...(cfg.env || {}), AGENT_DEPTH: String(DEPTH + 1) },
    });

    if (onSpawn) {
      try {
        onSpawn(child);
      } catch {}
    }

    let totalTimer = null;
    let idleTimer = null;

    const finish = (patch) => {
      if (settled) return;
      settled = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearInterval(idleTimer);
      resolve({ name, ms: Date.now() - started, out, err, timedOut, idleTimedOut, ...patch });
    };

    if (timeoutMs > 0) {
      totalTimer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid, child);
        setTimeout(() => killProcessTree(child.pid, child), 2000);
      }, timeoutMs);
    }

    if (idleTimeoutMs > 0) {
      const outerIdleMs = cfg.supportsSession ? idleTimeoutMs + 30_000 : idleTimeoutMs;
      idleTimer = setInterval(() => {
        let latest = lastActivityAt;
        if (progressFile) {
          try {
            if (fs.existsSync(progressFile)) {
              latest = Math.max(latest, fs.statSync(progressFile).mtimeMs);
            }
          } catch {}
          const prog = readJsonSafe(progressFile);
          if (typeof prog?.lastActivityAt === "number" && Number.isFinite(prog.lastActivityAt)) {
            latest = Math.max(latest, prog.lastActivityAt);
          } else if (typeof prog?.lastActivityAt === "string") {
            const parsed = Date.parse(prog.lastActivityAt);
            if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
          }
        }
        if (Date.now() - latest >= outerIdleMs) {
          idleTimedOut = true;
          killProcessTree(child.pid, child);
          setTimeout(() => killProcessTree(child.pid, child), 2000);
        }
      }, 10_000);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      if (d && d.length > 0) lastActivityAt = Date.now();
      out += d;
    });
    child.stderr.on("data", (d) => {
      if (d && d.length > 0) lastActivityAt = Date.now();
      err += d;
    });
    child.on("error", (e) => finish({ code: -1, err: err + "\n[spawn error] " + e.message }));
    child.on("close", (code) => finish({ code }));

    child.stdin.on("error", () => {}); // 子进程提前退出时别炸
    if (task != null) child.stdin.end(task);
    else child.stdin.end();
  });
}

/** codex exec 在模型 API 报错时仍可能 exit 0，必须看内容判断 */
function looksFailed(text) {
  if (!text) return false;
  return /\[ERROR\]|status=failed|turn\.failed|unsupported_model|"type"\s*:\s*"error"/i.test(text);
}

function finalizeInvocationResult(inv, r) {
  let body = "";
  if (inv.cfg.resultSource === "file" && fs.existsSync(inv.outFile)) {
    body = fs.readFileSync(inv.outFile, "utf8").trim();
  }
  if (!body) body = (r.out || "").trim();
  const tail = (r.err || "").trim();

  fs.writeFileSync(inv.logFile, [
    `# ${inv.agent}  ${new Date().toISOString()}`,
    `cwd: ${inv.workdir}`,
    `mode: ${inv.mode}`,
    ...(inv.sessionId ? [`sessionId: ${inv.sessionId}  resumed: ${inv.resumed}`] : []),
    `exit: ${r.code}  elapsed: ${r.ms}ms  timeout: ${r.timedOut}  idleTimeout: ${r.idleTimedOut}`,
    `argv: ${inv.args.join(" ")}`,
    "", "## stdout", r.out || "(empty)", "", "## stderr", r.err || "(empty)",
  ].join("\n"), "utf8");

  const failed = r.timedOut || r.idleTimedOut || r.code !== 0 || looksFailed(body) || !body;
  const head = `[${inv.agent}] exit=${r.code} ${(r.ms / 1000).toFixed(1)}s` +
    (inv.sessionId ? ` session=${inv.sessionId}` : "") +
    (r.timedOut ? " TIMEOUT" : "") +
    (r.idleTimedOut ? " IDLE_TIMEOUT" : "") +
    (failed ? " FAILED" : "");

  return {
    failed,
    body,
    tail,
    text: `${head}\nlog: ${inv.logFile}\n\n${body || tail || "(无输出)"}`,
  };
}

async function askAgent(params) {
  const inv = prepareInvocation(params);
  const r = await execAgent(inv.agent, inv.cfg, inv.args, {
    cwd: inv.workdir,
    task: inv.useStdin ? inv.task : null,
    timeoutMs: inv.totalTimeoutMs,
    idleTimeoutMs: inv.idleTimeoutMs,
    progressFile: inv.progressFile,
  });
  const res = finalizeInvocationResult(inv, r);
  return {
    failed: res.failed,
    sessionId: inv.sessionId,
    text: res.text,
  };
}

function validateJobId(jobId) {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) {
    throw new Error("jobId 格式无效");
  }
  return jobId;
}

function startAgent(params) {
  const inv = prepareInvocation(params);
  const jobId = `job-${inv.compactStamp}-${randomBytes(2).toString("hex")}`;
  const specFile = path.join(JOBS_DIR, `${jobId}.spec.json`);
  const statusFile = path.join(JOBS_DIR, `${jobId}.status.json`);
  const createdAt = new Date().toISOString();

  atomicWriteJson(specFile, {
    jobId,
    agent: inv.agent,
    sessionId: inv.sessionId,
    resumed: inv.resumed,
    mode: inv.mode,
    cwd: inv.workdir,
    task: inv.useStdin ? inv.task : null,
    args: inv.args,
    outFile: inv.outFile,
    logFile: inv.logFile,
    progressFile: inv.progressFile,
    timeoutMs: inv.totalTimeoutMs,
    idleTimeoutMs: inv.idleTimeoutMs,
    createdAt,
  });

  atomicWriteJson(statusFile, {
    jobId,
    agent: inv.agent,
    sessionId: inv.sessionId,
    resumed: inv.resumed,
    cwd: inv.workdir,
    mode: inv.mode,
    status: "starting",
    createdAt,
    startedAt: createdAt,
    runnerPid: null,
    childPid: null,
    idleTimeoutSec: Math.round(inv.idleTimeoutMs / 1000),
    totalTimeoutSec: Math.round(inv.totalTimeoutMs / 1000),
    progressFile: inv.progressFile,
    logFile: inv.logFile,
  });

  const runner = spawn(process.execPath, [fileURLToPath(import.meta.url), "_run-job", specFile], {
    cwd: inv.workdir,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  runner.unref();

  return {
    jobId,
    agent: inv.agent,
    sessionId: inv.sessionId,
    resumed: inv.resumed,
    status: "running",
    cwd: inv.workdir,
    mode: inv.mode,
    idleTimeoutSec: Math.round(inv.idleTimeoutMs / 1000),
    totalTimeoutSec: Math.round(inv.totalTimeoutMs / 1000),
    progressFile: inv.progressFile,
    logFile: inv.logFile,
    hint: `后台任务已启动，请用 check_agent(jobId="${jobId}") 巡检进度，或用 cancel_agent(jobId="${jobId}") 终止。`,
  };
}

async function runJob(specFile) {
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
  const statusFile = path.join(JOBS_DIR, `${spec.jobId}.status.json`);
  const existing = readJsonSafe(statusFile) || {};
  if (existing.status === "cancelled" || existing.cancelled) return;

  atomicWriteJson(statusFile, {
    ...existing,
    status: "running",
    runnerPid: process.pid,
    startedAt: existing.startedAt || new Date().toISOString(),
  });

  const { agents } = loadAgents();
  const cfg = agents[spec.agent];
  if (!cfg) {
    atomicWriteJson(statusFile, {
      ...existing,
      status: "failed",
      failed: true,
      runnerPid: process.pid,
      error: `未知 agent: ${spec.agent}`,
      finishedAt: new Date().toISOString(),
    });
    return;
  }

  const r = await execAgent(spec.agent, cfg, spec.args, {
    cwd: spec.cwd,
    task: spec.task,
    timeoutMs: spec.timeoutMs,
    idleTimeoutMs: spec.idleTimeoutMs,
    progressFile: spec.progressFile,
    onSpawn(child) {
      const cur = readJsonSafe(statusFile) || {};
      if (cur.status === "cancelled" || cur.cancelled) {
        killProcessTree(child.pid, child);
        return;
      }
      atomicWriteJson(statusFile, {
        ...cur,
        runnerPid: process.pid,
        childPid: child.pid ?? null,
      });
    },
  });

  const res = finalizeInvocationResult({
    agent: spec.agent,
    cfg,
    workdir: spec.cwd,
    mode: spec.mode,
    sessionId: spec.sessionId,
    outFile: spec.outFile,
    logFile: spec.logFile,
    args: spec.args,
  }, r);

  const latest = readJsonSafe(statusFile) || {};
  if (latest.status === "cancelled" || latest.cancelled) {
    atomicWriteJson(statusFile, {
      ...latest,
      status: "cancelled",
      cancelled: true,
      exitCode: r.code,
      elapsedMs: r.ms,
      finishedAt: latest.finishedAt || new Date().toISOString(),
    });
    return;
  }

  atomicWriteJson(statusFile, {
    ...latest,
    status: res.failed ? "failed" : "completed",
    failed: res.failed,
    exitCode: r.code,
    elapsedMs: r.ms,
    timedOut: r.timedOut,
    idleTimedOut: r.idleTimedOut,
    text: res.text,
    error: res.failed ? (res.body || res.tail || "执行失败") : null,
    finishedAt: new Date().toISOString(),
  });
}

function checkAgent({ jobId, tailEvents = 10 }) {
  validateJobId(jobId);
  if (typeof tailEvents !== "number" || !Number.isInteger(tailEvents) || tailEvents < 0) {
    throw new Error("tailEvents 必须是非负整数");
  }
  const statusFile = path.join(JOBS_DIR, `${jobId}.status.json`);
  let status = readJsonSafe(statusFile);
  if (!status) throw new Error(`找不到后台任务: ${jobId}`);

  if (status.status === "running" || status.status === "starting") {
    const runnerAlive = isPidAlive(status.runnerPid);
    const childAlive = isPidAlive(status.childPid);
    const createdMs = Date.parse(status.createdAt || "");
    const ageMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0;
    const lost = ((status.runnerPid || status.childPid) && !runnerAlive && !childAlive) ||
      (status.status === "starting" && ageMs > 10_000 && !runnerAlive && !childAlive);

    if (lost) {
      const fresh = readJsonSafe(statusFile);
      if (fresh) status = fresh;
      if ((status.status === "running" || status.status === "starting") && !isPidAlive(status.runnerPid) && !isPidAlive(status.childPid)) {
        status = {
          ...status,
          status: "failed",
          failed: true,
          error: "后台执行器进程已退出，未写入终态",
          finishedAt: new Date().toISOString(),
        };
        atomicWriteJson(statusFile, status);
      }
    }
  }

  const progress = status.progressFile ? readJsonSafe(status.progressFile) : null;
  const startMs = Date.parse(status.startedAt || status.createdAt || "");
  const endMs = status.finishedAt ? Date.parse(status.finishedAt) : Date.now();
  const elapsedSec = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : null;

  let lastAct = null;
  if (typeof progress?.lastActivityAt === "number" && Number.isFinite(progress.lastActivityAt)) {
    lastAct = progress.lastActivityAt;
  } else if (typeof progress?.lastActivityAt === "string") {
    const parsed = Date.parse(progress.lastActivityAt);
    if (Number.isFinite(parsed)) lastAct = parsed;
  }
  if (lastAct == null && status.progressFile) {
    try {
      if (fs.existsSync(status.progressFile)) lastAct = fs.statSync(status.progressFile).mtimeMs;
    } catch {}
  }
  if (lastAct == null && status.logFile) {
    try {
      if (fs.existsSync(status.logFile)) lastAct = fs.statSync(status.logFile).mtimeMs;
    } catch {}
  }
  if (lastAct == null && Number.isFinite(startMs)) lastAct = startMs;

  const refNow = status.finishedAt && Number.isFinite(endMs) ? endMs : Date.now();
  const idleSec = lastAct != null ? Math.max(0, Math.round((refNow - lastAct) / 1000)) : null;

  const allEvents = Array.isArray(progress?.recentEvents) ? progress.recentEvents : [];
  const summary = {
    jobId: status.jobId,
    agent: status.agent,
    sessionId: status.sessionId ?? null,
    resumed: Boolean(status.resumed),
    status: status.status,
    elapsedSec,
    idleSec,
    activeTool: progress?.activeTool ?? null,
    toolCallCount: progress?.toolCallCount ?? 0,
    calledTools: progress?.calledTools ?? [],
    recentEvents: tailEvents > 0 ? allEvents.slice(-tailEvents) : [],
    lastAssistantPreview: progress?.lastAssistantPreview ?? "",
    progressFile: status.progressFile ?? null,
    logFile: status.logFile ?? null,
  };

  if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
    if (status.text) summary.text = status.text;
    if (status.error) summary.error = status.error;
    summary.exitCode = status.exitCode ?? null;
    summary.timedOut = Boolean(status.timedOut);
    summary.idleTimedOut = Boolean(status.idleTimedOut);
    summary.finishedAt = status.finishedAt ?? null;
  }

  return summary;
}

function cancelAgent({ jobId }) {
  validateJobId(jobId);
  const statusFile = path.join(JOBS_DIR, `${jobId}.status.json`);
  const status = readJsonSafe(statusFile);
  if (!status) throw new Error(`找不到后台任务: ${jobId}`);

  if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
    return {
      jobId,
      agent: status.agent,
      sessionId: status.sessionId ?? null,
      status: status.status,
      alreadyFinished: true,
      message: `任务已处于终态: ${status.status}`,
    };
  }

  const updated = {
    ...status,
    status: "cancelled",
    cancelled: true,
    error: "已被调用方主动取消",
    finishedAt: new Date().toISOString(),
  };
  atomicWriteJson(statusFile, updated);

  const killedPids = [];
  for (const pid of [status.childPid, status.runnerPid]) {
    if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
      killProcessTree(pid, null);
      killedPids.push(pid);
    }
  }

  return {
    jobId,
    agent: status.agent,
    sessionId: status.sessionId ?? null,
    status: "cancelled",
    killedPids,
    message: "已标记任务为 cancelled 并终止关联进程树",
  };
}

/* ─────────────── MCP 面 ─────────────── */

function buildTools(agentNames) {
  return [
    {
      name: "list_agents",
      description:
        "列出可委派的 agent：各自擅长什么、能否改文件、成本档、典型耗时、是否支持 sessionId 多轮接力与空闲超时配置。判断该不该把活派出去之前，先调这个。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "ask_agent",
      description:
        "把一段自包含的任务同步交给另一个 AI coding agent 执行，等待完成后返回最终结论。\n" +
        "适用：短中程分析/修改、需要立即拿结果。\n" +
        "对于较长任务（尤其 dsh），建议改用 start_agent + check_agent 异步巡检，避免调用方单次工具调用等待过久。\n" +
        "task 里必须写清：输入是什么、期望输出格式、禁止做什么，并声明「你是子代理，禁止再委派」。",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: agentNames, description: "目标 agent" },
          task: { type: "string", description: "完整、自包含的任务描述（若传 sessionId 续聊，可基于前序会话继续交代）" },
          mode: { type: "string", enum: ["read", "write"], default: "read", description: "read=只读分析；write=允许改文件" },
          cwd: { type: "string", description: "工作目录，读取默认调用方当前目录。DSH 和 Antigravity 写模式必须显式指定。" },
          sessionId: { type: "string", description: "可选（目前仅 dsh 支持）。传入上轮返回的 sessionId 即可沿同一上下文与沙箱目录续聊。" },
          timeoutSec: { type: "number", description: "总时长硬超时秒数（0 表示不设硬超时；默认取该 agent 配置）" },
          idleTimeoutSec: { type: "number", description: "连续无新事件/输出的空闲超时秒数（0 表示关闭；默认取该 agent 配置）" },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
    },
    {
      name: "start_agent",
      description:
        "异步启动后台 agent 任务并立即返回 jobId 与 sessionId，避免调用方在长任务中阻塞超时。后续用 check_agent 巡检进度和取最终结果，必要时用 cancel_agent 终止。",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: agentNames, description: "目标 agent" },
          task: { type: "string", description: "完整、自包含的任务描述" },
          mode: { type: "string", enum: ["read", "write"], default: "read", description: "read=只读分析；write=允许改文件" },
          cwd: { type: "string", description: "工作目录，读取默认调用方当前目录。DSH 和 Antigravity 写模式必须显式指定。" },
          sessionId: { type: "string", description: "可选（目前仅 dsh 支持）。传入前序 sessionId 进行多轮上下文接力。" },
          timeoutSec: { type: "number", description: "总时长硬超时秒数（0 表示不设硬超时；默认取该 agent 配置）" },
          idleTimeoutSec: { type: "number", description: "连续无新事件/输出的空闲超时秒数（0 表示关闭；默认取该 agent 配置）" },
        },
        required: ["agent", "task"],
        additionalProperties: false,
      },
    },
    {
      name: "check_agent",
      description:
        "巡检 start_agent 启动的后台任务状态、空闲时间、当前工具、最近事件摘要；任务结束后返回完整输出或错误信息。",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "start_agent 返回的 jobId" },
          tailEvents: { type: "number", default: 10, description: "返回最近多少条事件（默认 10）" },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_agent",
      description: "强制取消并终止正在运行的 start_agent 后台任务进程树。",
      inputSchema: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "要取消的 jobId" },
        },
        required: ["jobId"],
        additionalProperties: false,
      },
    },
  ];
}

async function callTool(name, a) {
  if (name === "list_agents") {
    const { agents, names } = loadAgents();
    const rows = names.map((k) => ({
      agent: k,
      label: agents[k].label,
      desc: agents[k].desc,
      edits: agents[k].edits,
      cost: agents[k].cost,
      avgMinutes: agents[k].avgMinutes,
      timeoutSec: agents[k].timeoutSec,
      noHardTimeout: Boolean(agents[k].noHardTimeout),
      idleTimeoutSec: agents[k].idleTimeoutSec ?? 0,
      supportsSession: Boolean(agents[k].supportsSession),
    }));
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
  if (name === "ask_agent") {
    try {
      const r = await askAgent(a);
      return { isError: r.failed, content: [{ type: "text", text: r.text }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `[agent-bridge] ${e.message}` }] };
    }
  }
  if (name === "start_agent") {
    try {
      const r = startAgent(a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `[agent-bridge] ${e.message}` }] };
    }
  }
  if (name === "check_agent") {
    try {
      const r = checkAgent(a);
      return { isError: r.status === "failed", content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `[agent-bridge] ${e.message}` }] };
    }
  }
  if (name === "cancel_agent") {
    try {
      const r = cancelAgent(a);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `[agent-bridge] ${e.message}` }] };
    }
  }
  return { isError: true, content: [{ type: "text", text: `未知工具: ${name}` }] };
}

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  const notif = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return writeLine({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return writeLine({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
      return writeLine({ jsonrpc: "2.0", id, result: { tools: buildTools(loadAgents().names) } });
    case "tools/call": {
      const result = await callTool(params?.name, params?.arguments || {});
      return writeLine({ jsonrpc: "2.0", id, result });
    }
    default:
      if (!notif) {
        writeLine({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
  }
}

function serve() {
  process.stderr.write(`[agent-bridge] stdio ready, agents: ${loadAgents().names.join(", ")}\n`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }
    pending++;
    handle(msg)
      .catch((e) => {
        if (msg.id !== undefined) {
          writeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message || e) } });
        }
      })
      .finally(() => { pending--; maybeExit(); });
  });
  rl.on("close", () => { closed = true; maybeExit(); });
}

/* ─────────────── CLI ─────────────── */

function parseNonNegNumber(raw, flag, integerOnly = false) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`参数 ${flag} 缺少数值`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || (integerOnly && !Number.isInteger(n))) {
    throw new Error(`参数 ${flag} 必须是${integerOnly ? "非负整数" : "非负数字"}，收到: ${raw}`);
  }
  return n;
}

function parseCliFlags(argv, allowedFlags) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (!allowedFlags.has(token)) {
      throw new Error(`未知参数: ${token}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`参数 ${token} 缺少值`);
    }
    const val = argv[++i];
    if (token === "--timeout") flags.timeoutSec = parseNonNegNumber(val, token, false);
    else if (token === "--idle-timeout") flags.idleTimeoutSec = parseNonNegNumber(val, token, true);
    else if (token === "--tail") flags.tailEvents = parseNonNegNumber(val, token, true);
    else if (token === "--mode") flags.mode = val;
    else if (token === "--cwd") flags.cwd = val;
    else if (token === "--session-id") flags.sessionId = val;
  }
  return { flags, positionals };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "serve" || cmd === undefined) return serve();

  if (cmd === "list") {
    const { agents, names } = loadAgents();
    console.log(JSON.stringify(names.map((k) => ({ agent: k, ...agents[k], argv: undefined, launcher: undefined })), null, 2));
    return;
  }

  if (cmd === "ask") {
    const allowed = new Set(["--mode", "--cwd", "--session-id", "--timeout", "--idle-timeout"]);
    const { flags, positionals } = parseCliFlags(rest, allowed);
    const [agent, task] = positionals;
    if (!agent || !task) {
      console.error('用法: node agent-bridge.mjs ask <agent> "<任务>" [--mode read|write] [--cwd DIR] [--session-id ID] [--timeout SEC] [--idle-timeout SEC]');
      process.exit(2);
    }
    const r = await askAgent({
      agent,
      task,
      mode: flags.mode ?? "read",
      cwd: flags.cwd,
      sessionId: flags.sessionId,
      timeoutSec: flags.timeoutSec,
      idleTimeoutSec: flags.idleTimeoutSec,
    });
    console.log(r.text);
    process.exit(r.failed ? 1 : 0);
  }

  if (cmd === "start") {
    const allowed = new Set(["--mode", "--cwd", "--session-id", "--timeout", "--idle-timeout"]);
    const { flags, positionals } = parseCliFlags(rest, allowed);
    const [agent, task] = positionals;
    if (!agent || !task) {
      console.error('用法: node agent-bridge.mjs start <agent> "<任务>" [--mode read|write] [--cwd DIR] [--session-id ID] [--timeout SEC] [--idle-timeout SEC]');
      process.exit(2);
    }
    const r = startAgent({
      agent,
      task,
      mode: flags.mode ?? "read",
      cwd: flags.cwd,
      sessionId: flags.sessionId,
      timeoutSec: flags.timeoutSec,
      idleTimeoutSec: flags.idleTimeoutSec,
    });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "check") {
    const allowed = new Set(["--tail"]);
    const { flags, positionals } = parseCliFlags(rest, allowed);
    const [jobId] = positionals;
    if (!jobId) {
      console.error("用法: node agent-bridge.mjs check <jobId> [--tail N]");
      process.exit(2);
    }
    const r = checkAgent({ jobId, tailEvents: flags.tailEvents ?? 10 });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === "failed" ? 1 : 0);
  }

  if (cmd === "cancel") {
    const { positionals } = parseCliFlags(rest, new Set());
    const [jobId] = positionals;
    if (!jobId) {
      console.error("用法: node agent-bridge.mjs cancel <jobId>");
      process.exit(2);
    }
    const r = cancelAgent({ jobId });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === "_run-job") {
    const [specFile] = rest;
    if (!specFile) {
      console.error("缺少 specFile 参数");
      process.exit(2);
    }
    await runJob(specFile);
    return;
  }

  console.error(`未知命令: ${cmd}\n可用: serve | list | ask | start | check | cancel`);
  process.exit(2);
}

main().catch((e) => {
  console.error("[agent-bridge] fatal:", e.message);
  process.exit(1);
});

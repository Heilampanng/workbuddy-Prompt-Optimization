#!/usr/bin/env node
/**
 * check.mjs —— 提示词优化按钮 · 只读状态探测
 *
 * 不写任何文件、不改任何配置、不发起安装。仅用于判断当前处于什么状态。
 * 用法：node check.mjs [--dir <安装目录>]
 * 输出：JSON（退出码恒为 0，判定交给调用方解析字段）
 *
 * 依赖：仅 Node 内置模块，要求 Node >= 18。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const PROXY_PORT = 9477;
const CDP_PORTS = [9334, 9333];
const REQUIRED = ["cli.mjs", "proxy.mjs", "inject/ui.js", "一键启动.bat", "一键卸载.bat"];

const argv = process.argv.slice(2);
const dirArg = argv.indexOf("--dir") >= 0 ? argv[argv.indexOf("--dir") + 1] : null;

function candidateDirs() {
  const list = [];
  if (dirArg) list.push(resolve(dirArg));
  if (process.env.PROMPT_OPT_DIR) list.push(resolve(process.env.PROMPT_OPT_DIR));
  if (process.platform === "win32") {
    list.push(join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "prompt-optimize-button"));
  } else {
    list.push(join(homedir(), ".local", "share", "prompt-optimize-button"));
  }
  list.push(process.cwd());
  return [...new Set(list)];
}

function findInstallDir() {
  for (const dir of candidateDirs()) {
    if (existsSync(join(dir, "cli.mjs"))) return dir;
  }
  return null;
}

function startupVbsPath() {
  if (process.platform !== "win32") return null;
  return join(
    process.env.APPDATA || "",
    "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
    "prompt-optimize-watch.vbs"
  );
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function probeJson(url, timeout = 2000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const dir = findInstallDir();
const out = {
  installed: false,
  dir,
  missingFiles: [],
  proxy: null,
  autostart: false,
  autostartPath: startupVbsPath(),
  daemon: false,
  daemonPid: 0,
  cdp: null,
  button: null,
  checkedAt: new Date().toISOString(),
};

if (dir) {
  out.missingFiles = REQUIRED.filter((f) => !existsSync(join(dir, f)));
  out.installed = out.missingFiles.length === 0;

  const lockPath = join(dir, ".watch.lock");
  if (existsSync(lockPath)) {
    try {
      const pid = Number(JSON.parse(readFileSync(lockPath, "utf8")).pid || 0);
      out.daemonPid = pid;
      out.daemon = pid > 0 && pidAlive(pid);
    } catch { /* 锁文件损坏，视为未运行 */ }
  }
}

const health = await probeJson(`http://127.0.0.1:${PROXY_PORT}/health`);
if (health) {
  out.proxy = {
    version: health.version ?? null,
    protocol: health.protocol ?? null,
    model: health.model ?? null,
    hasKey: Boolean(health.hasKey),
    promptCustom: Boolean(health.promptCustom),
  };
  if (!out.daemon) out.daemon = true;
}

const vbs = out.autostartPath;
out.autostart = Boolean(vbs && existsSync(vbs));

for (const port of CDP_PORTS) {
  const v = await probeJson(`http://127.0.0.1:${port}/json/version`, 1500);
  if (v) { out.cdp = port; break; }
}

if (out.cdp && dir) {
  const targets = await probeJson(`http://127.0.0.1:${out.cdp}/json/list`, 3000);
  if (Array.isArray(targets)) {
    const pages = targets.filter((t) => t.type === "page" && String(t.url || "").includes("renderer/index.html"));
    out.rendererPages = pages.length;
  }
}

// 按钮是否已挂载：读取注入脚本在页面上留下的全局标记，不需要额外权限
if (out.cdp) {
  try {
    const list = await probeJson(`http://127.0.0.1:${out.cdp}/json/list`, 3000);
    const page = Array.isArray(list)
      ? list.find((t) => t.type === "page" && String(t.url || "").includes("renderer/index.html"))
      : null;
    if (page?.webSocketDebuggerUrl) {
      out.button = await probeButtonViaWs(page.webSocketDebuggerUrl);
    }
  } catch { /* 探测失败保持 null */ }
}

function probeButtonViaWs(wsUrl) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); try { ws.close(); } catch {} } };
    let ws;
    try { ws = new WebSocket(wsUrl); } catch { return finish(null); }
    const timer = setTimeout(() => finish(null), 5000);
    ws.onerror = () => { clearTimeout(timer); finish(null); };
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "Boolean(document.getElementById('wb-prompt-opt-btn'))", returnByValue: true },
      }));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const m = JSON.parse(ev.data);
        if (m.id === 1) finish(m.result?.result?.value ?? null);
      } catch { finish(null); }
    };
  });
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");

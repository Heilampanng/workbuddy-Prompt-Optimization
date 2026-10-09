#!/usr/bin/env node
// prompt-optimize CLI：通过 CDP 向 WorkBuddy 渲染页面注入/卸载 ✨ 优化按钮
// 用法：
//   node cli.mjs apply   [--port 9334]   注入按钮
//   node cli.mjs remove  [--port 9334]   卸载按钮
//   node cli.mjs status  [--port 9334]   查看注入状态
//   node cli.mjs doctor  [--port 9334]   诊断 CDP 端口与代理
//   node cli.mjs watch   [--port 9334] [--interval 3000]
//                                        守护模式：自动拉起代理 + WorkBuddy 重开后自动重新注入
//   node cli.mjs autostart on|off|status 开机自启（启动文件夹）：登录即自动起守护，无需手动
//   node cli.mjs setup                   一键启动：装自启 + 立刻起守护 + 注入按钮（供 一键启动.bat 调用）
//   node cli.mjs uninstall               一键卸载：关自启 + 卸按钮 + 停守护与代理（供 一键卸载.bat 调用）
//   node cli.mjs bootstrap [--json]      轻量一键启动（幂等）：装自启 + 确保守护在跑（供代理 POST /setup 调用）
// 机制与 anonbuddy-skin 相同：/json/list 发现 renderer target → WebSocket → Runtime.evaluate。
// 只连 127.0.0.1，不改 app.asar，不动安装目录。
//
// ⚠️ 为什么 .bat 里一行中文都不能有：
//   cmd 用 OEM 代码页（简中 Windows = GBK）读取 .bat 正文，而 .bat 若以 UTF-8 存中文，
//   多字节错位会让 cmd 的「行起点」逐行漂移，把后面几行开头的字符一起吞掉，
//   表现为 "'ompt' 不是内部或外部命令"（实为 "rem Prompt…" 被吃掉 "rem Pr"）。
//   实测：LF + 中文 必坏；CRLF + 中文 能解析但中文乱码；纯 ASCII（LF/CRLF 均可）最稳。
//   所以 .bat 保持纯 ASCII + CRLF，所有中文提示由 Node 打印（Node 走 WriteConsoleW，不受代码页影响）。
import { readFile, writeFile, unlink, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_URL_HINT = "renderer/index.html";
const PORTS = [9334, 9333]; // 中国版 / 国际版默认调试端口
const PROXY_URL = "http://127.0.0.1:9477";
const PROXY_PORT = 9477;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { cmd: argv[0] || "status", sub: null, port: null, interval: 3000, json: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) { args.port = Number(argv[i + 1]); i++; continue; }
    if (argv[i] === "--interval" && argv[i + 1]) { args.interval = Math.max(1000, Number(argv[i + 1]) || 3000); i++; continue; }
    if (argv[i] === "--json") { args.json = true; continue; }
    if (!argv[i].startsWith("--") && !args.sub) args.sub = argv[i];
  }
  return args;
}

async function detectPort(explicit) {
  const candidates = explicit ? [explicit] : PORTS;
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return port;
    } catch { /* try next */ }
  }
  return null;
}

async function fetchTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(4000) });
  const targets = await res.json();
  return targets.filter(
    (t) => t.type === "page" && String(t.url || "").includes(RENDERER_URL_HINT) && String(t.webSocketDebuggerUrl || "").startsWith("ws://127.0.0.1")
  );
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 20000);
    ws.addEventListener("message", function handler(ev) {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener("message", handler);
      clearTimeout(timer);
      if (m.error) reject(new Error(`CDP ${method}: ${m.error.message}`));
      else resolve(m.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable", {});
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  ws.close();
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  }
  return out.result.value;
}

async function evaluateAll(port, expression) {
  const targets = await fetchTargets(port);
  if (targets.length === 0) throw new Error("没有找到 WorkBuddy 渲染页面 target（renderer/index.html）");
  const values = [];
  for (const t of targets) values.push(await evaluate(t.webSocketDebuggerUrl, expression));
  return { count: targets.length, values };
}

async function cmdApply(port) {
  const uiSrc = await readFile(join(HERE, "inject", "ui.js"), "utf8");
  const { count, values } = await evaluateAll(port, uiSrc);
  const mounted = values.filter((v) => v && v.installed && v.mounted).length;
  console.log(`✅ 已挂载 ${mounted}/${count} 个渲染页面（端口 ${port}）`);
  console.log("   ✨ 按钮位于输入区底部工具栏、模型选择器与语音按钮之间。点击优化，再点还原。");
  console.log("   右键按钮可配置 API Key / 模型 / 服务地址 / 系统提示词（保存后立即生效，无需重启代理）。");
}

// ---------- 守护模式 ----------
// 关掉 WorkBuddy 会销毁渲染页面里的按钮；守护进程持续轮询，页面一出现就补注入。
async function proxyAlive() {
  try {
    const r = await fetch(PROXY_URL + "/health", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

function startProxy() {
  const child = spawn(process.execPath, [join(HERE, "proxy.mjs")], {
    cwd: HERE,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// 代理「版本」= proxy.mjs 文件内容的 sha256 前 12 位（与 proxy.mjs 自身的算法一致）。
// 用来识别「跑着的是改代码之前启动的旧代理」——否则升级后新功能不生效，还很难排查。
async function proxyFileVersion() {
  try {
    return createHash("sha256").update(await readFile(join(HERE, "proxy.mjs"))).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

// 返回在线代理的版本；代理没在跑时返回 null（区别于「在线但没有 version 字段」的旧版，返回 ""）
async function liveProxyVersion() {
  try {
    const r = await fetch(PROXY_URL + "/health", { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    return typeof h.version === "string" ? h.version : "";
  } catch {
    return null;
  }
}

// 只判断按钮是否还在：在就不动，避免重建按钮把「再点还原」的原文缓冲清掉
const PROBE_BUTTON = "Boolean(document.getElementById('wb-prompt-opt-btn') && window.__wbPromptOpt && window.__wbPromptOpt.stopGuard)";

const LOCK_PATH = join(HERE, ".watch.lock");
const LOG_PATH = join(HERE, ".watch.log");
const LOG_MAX = 512 * 1024;

// 守护进程被自启入口静默拉起时没有终端，把状态同时写进 .watch.log，便于排障
async function note(text) {
  console.log("[" + new Date().toLocaleTimeString() + "] " + text);
  try {
    try {
      const st = await stat(LOG_PATH);
      if (st.size > LOG_MAX) await writeFile(LOG_PATH, "", "utf8");
    } catch { /* 文件还不存在 */ }
    await appendFile(LOG_PATH, "[" + new Date().toISOString() + "] " + text + "\n", "utf8");
  } catch { /* 日志不可写不影响守护 */ }
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// 返回已在运行的守护进程 pid；没有则占位并返回 null
async function acquireLock() {
  try {
    const raw = JSON.parse(await readFile(LOCK_PATH, "utf8"));
    if (raw && raw.pid && raw.pid !== process.pid && pidAlive(raw.pid)) return raw.pid;
  } catch {
    // 无锁文件或已损坏，继续占位
  }
  await writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
  const release = () => {
    try { unlink(LOCK_PATH); } catch {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => { release(); process.exit(0); });
  process.on("SIGTERM", () => { release(); process.exit(0); });
  return null;
}

async function syncTargets(port, uiSrc) {
  const targets = await fetchTargets(port);
  let mounted = 0;
  let injected = 0;
  for (const t of targets) {
    let alive = false;
    try {
      alive = await evaluate(t.webSocketDebuggerUrl, PROBE_BUTTON);
    } catch {
      alive = false;
    }
    if (alive) { mounted++; continue; }
    try {
      const v = await evaluate(t.webSocketDebuggerUrl, uiSrc);
      if (v && v.installed) { mounted++; injected++; }
    } catch {
      // 页面正在导航/刷新，下一轮再补
    }
  }
  return { targets: targets.length, mounted, injected };
}

async function cmdWatch(explicitPort, intervalMs) {
  // 单实例锁：重复运行 一键启动.bat 时不会叠起多个守护进程
  const running = await acquireLock();
  if (running) {
    console.log("守护进程已在运行（pid " + running + "），本次不再启动。");
    return;
  }
  await note("—— prompt-optimize 守护模式（pid " + process.pid + "）——");
  await note("· 自动拉起本地代理（127.0.0.1:9477）");
  await note("· WorkBuddy 每次启动/刷新页面后自动重新注入 ✨ 按钮，无需手动操作");
  const uiSrc = await readFile(join(HERE, "inject", "ui.js"), "utf8");
  const expectedProxy = await proxyFileVersion();
  let staleRestarts = 0;
  let lastLine = "";
  for (;;) {
    let line;
    try {
      let proxyNote;
      const live = await liveProxyVersion();
      if (live !== null && live !== expectedProxy && staleRestarts < 3) {
        // 磁盘上的代理代码已经变了，跑着的还是旧的：换掉它，否则新功能不生效
        staleRestarts++;
        const killed = await stopProxy();
        await sleep(500);
        const pid = startProxy();
        await sleep(900);
        proxyNote = "代理版本过旧(" + (live || "无版本字段") + ")，已替换为新版(pid " + pid + ")" + (killed ? "" : "·旧进程未找到");
      } else if (live !== null) {
        proxyNote = "代理在线";
      } else {
        const pid = startProxy();
        await sleep(800);
        proxyNote = (await proxyAlive()) ? "代理已自动拉起(pid " + pid + ")" : "代理启动中…";
      }
      const port = await detectPort(explicitPort);
      if (!port) {
        line = proxyNote + " · CDP 未开放（WorkBuddy 未运行）";
      } else {
        const r = await syncTargets(port, uiSrc);
        line =
          proxyNote +
          " · CDP " +
          port +
          " · 页面 " +
          r.targets +
          " 个 / 已挂载 " +
          r.mounted +
          (r.injected ? "（本轮新注入 " + r.injected + "）" : "");
      }
    } catch (err) {
      line = "轮询异常：" + (err?.message || err);
    }
    if (line !== lastLine) {
      await note(line);
      lastLine = line;
    }
    await sleep(intervalMs);
  }
}

// ---------- 开机自启（Windows 启动文件夹） ----------
// 目标：打开 WorkBuddy 就能直接用，不需要任何手动启动。
// 做法：往「启动文件夹」放一个无窗口的 .vbs，登录时静默拉起 watch 守护进程；
//       守护进程自己拉起本地代理，并持续给 WorkBuddy 注入按钮。
// 为什么不用计划任务：本机安全策略把 schtasks.exe 列为黑名单程序，且明确禁止绕过。
const STARTUP_DIR = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_VBS = join(STARTUP_DIR, "prompt-optimize-watch.vbs");
const LOCAL_VBS = join(HERE, "start-daemon.vbs");

// 纯 ASCII 的 VBS：wscript 默认按 ANSI 读取脚本，含中文会乱码。
// node 路径做多级兜底（WorkBuddy 升级会替换自带 node，不能只认死一条路径）。
function vbsSource() {
  const cli = join(HERE, "cli.mjs");
  const versionsDir = join(process.env.USERPROFILE || "", ".workbuddy", "binaries", "node", "versions");
  const cands = [
    process.execPath,
    join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
  ].filter(Boolean);
  const arrayLine = "cands = Array(" + cands.map((c) => '"' + c + '"').join(", ") + ")";

  const L = [];
  L.push("' prompt-optimize: silently start the watch daemon.");
  L.push("' It auto-starts the local proxy (127.0.0.1:9477) and injects the button into WorkBuddy.");
  L.push("' Generated by: node cli.mjs autostart on   (delete this file to disable)");
  L.push("Option Explicit");
  L.push("Dim fso, sh, cmd, nodeExe, cands, i, verDir, sub");
  L.push('Set fso = CreateObject("Scripting.FileSystemObject")');
  L.push('If Not fso.FileExists("' + cli + '") Then WScript.Quit 1');
  L.push('nodeExe = ""');
  L.push(arrayLine);
  L.push("For i = 0 To UBound(cands)");
  L.push("  If nodeExe = \"\" Then");
  L.push("    If fso.FileExists(cands(i)) Then nodeExe = cands(i)");
  L.push("  End If");
  L.push("Next");
  L.push("' fallback: scan WorkBuddy bundled node versions");
  L.push("If nodeExe = \"\" Then");
  L.push('  verDir = "' + versionsDir + '"');
  L.push("  If fso.FolderExists(verDir) Then");
  L.push("    For Each sub In fso.GetFolder(verDir).SubFolders");
  L.push("      If nodeExe = \"\" Then");
  L.push('        If fso.FileExists(sub.Path & "\\node.exe") Then nodeExe = sub.Path & "\\node.exe"');
  L.push("      End If");
  L.push("    Next");
  L.push("  End If");
  L.push("End If");
  L.push("If nodeExe = \"\" Then WScript.Quit 2");
  L.push('Set sh = CreateObject("WScript.Shell")');
  L.push('sh.CurrentDirectory = "' + HERE + '"');
  L.push('cmd = """" & nodeExe & """ """ & "' + cli + '" & """ watch"');
  L.push("sh.Run cmd, 0, False");
  L.push("");
  return L.join("\r\n");
}

// 写入两处启动脚本（启动文件夹 + 项目内本地启动器）。
// 内容一致就不重写：面板每次点「保存」都会走这里，没必要反复写系统目录。
// 返回是否发生了实际改动。写入失败会抛出。
async function installAutostartFiles() {
  const src = vbsSource();
  let changed = false;
  for (const f of [LOCAL_VBS, STARTUP_VBS]) {
    const old = await readFile(f, "utf8").catch(() => "");
    if (old !== src) {
      await writeFile(f, src, "utf8");
      changed = true;
    }
  }
  return changed;
}

async function cmdAutostart(mode) {
  const m = String(mode || "status").toLowerCase();

  if (m === "status") {
    const on = existsSync(STARTUP_VBS);
    console.log("开机自启：" + (on ? "✅ 已开启" : "❌ 未开启"));
    console.log("  启动项：" + STARTUP_VBS);
    if (on) {
      const src = await readFile(STARTUP_VBS, "utf8").catch(() => "");
      const hit = /If Not fso\.FileExists\("([^"]+)"\)/.exec(src);
      const target = hit ? hit[1] : "(无法解析)";
      console.log("  指向：" + target + (hit && !existsSync(target) ? "   ⚠️ 文件不存在，请重新执行 autostart on" : ""));
    }
    console.log("  本地启动器：" + LOCAL_VBS + (existsSync(LOCAL_VBS) ? "（可双击立即启动）" : "（未生成）"));
    const alive = existsSync(LOCK_PATH);
    console.log("  守护进程：" + (alive ? "运行中（有锁文件）" : "未运行") + " · 本地代理：" + ((await proxyAlive()) ? "在线" : "未运行"));
    return;
  }

  if (m === "off") {
    let removed = 0;
    for (const f of [STARTUP_VBS, LOCAL_VBS]) {
      if (!existsSync(f)) continue;
      try {
        await unlink(f);
        removed++;
        console.log("已删除：" + f);
      } catch (err) {
        console.log("删除失败：" + f + " — " + (err?.message || err));
      }
    }
    console.log(removed ? "✅ 已关闭开机自启（下次登录不会再自动启动）" : "（本来就没开启）");
    console.log("   正在运行的守护进程不受影响；要一并停掉请执行：node cli.mjs remove");
    return;
  }

  // 默认 on
  const changed = await installAutostartFiles();
  console.log("✅ 已开启开机自启（Windows 启动文件夹）" + (changed ? "" : "（内容已是最新，未重复写入）"));
  console.log("   启动项　　：" + STARTUP_VBS);
  console.log("   本地启动器：" + LOCAL_VBS);
  console.log("   使用的 node：" + process.execPath);
  console.log("");
  console.log("   今后每次 Windows 登录（开机 / 注销重登）都会自动拉起守护进程；");
  console.log("   守护进程会自己拉起本地代理，WorkBuddy 一打开就自动注入 ✨ 按钮。");
  console.log("   —— 本次要在不重启的前提下立刻生效：双击 " + LOCAL_VBS + "（仅此一次）。");
}

// ---------- 一键启动 / 一键卸载 ----------
// 这两个命令供 一键启动.bat / 一键卸载.bat 调用；bat 只做纯 ASCII 中继，中文提示全在这里输出。

// 立刻在本机拉起守护进程（与登录自启走的是同一个 cli.mjs watch）
function startWatcher() {
  const child = spawn(process.execPath, [join(HERE, "cli.mjs"), "watch"], {
    cwd: HERE,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function stopWatcher() {
  let pid = 0;
  try {
    const raw = JSON.parse(await readFile(LOCK_PATH, "utf8"));
    pid = Number((raw && raw.pid) || 0);
  } catch {
    // 没有锁文件
  }
  if (pid && pid !== process.pid && pidAlive(pid)) {
    try {
      process.kill(pid);
      return pid;
    } catch {
      return 0;
    }
  }
  return 0;
}

// 异步收集子进程输出：Windows 上 spawnSync 常抛 EBUSY，统一用异步 spawn
function runCapture(cmd, argv) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, argv, { windowsHide: true });
    } catch {
      return resolve("");
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => resolve(out));
    child.on("close", () => resolve(out));
  });
}

// 停掉占用代理端口的 node 进程（只杀 node.exe，避免误伤）
async function stopProxy() {
  const net = await runCapture("netstat", ["-ano"]);
  const pids = new Set();
  for (const line of net.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    if (!new RegExp(":" + PROXY_PORT + "\\s").test(line)) continue;
    const pid = Number(line.trim().split(/\s+/).pop());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
  }
  if (pids.size === 0) return 0;

  const tl = await runCapture("tasklist", ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]);
  const nodePids = new Set();
  for (const line of tl.split(/\r?\n/)) {
    const m = /^"[^"]+","(\d+)"/.exec(line.trim());
    if (m) nodePids.add(Number(m[1]));
  }
  // 万一 tasklist 没给出可用信息，则退化为直接停（该端口是本工具专用的）
  const whitelistKnown = nodePids.size > 0;

  let killed = 0;
  for (const pid of pids) {
    if (whitelistKnown && !nodePids.has(pid)) continue;
    try {
      process.kill(pid);
      killed++;
    } catch {
      // 进程可能已退出
    }
  }
  return killed;
}

async function cmdSetup() {
  console.log("==================================================");
  console.log("  prompt-optimize 一键启动");
  console.log("==================================================");
  console.log("");

  console.log("[1/4] 安装开机自启（Windows 启动文件夹）");
  await cmdAutostart("on");
  console.log("");

  console.log("[2/4] 本机立刻启动守护进程");
  const target = existsSync(LOCK_PATH) ? Number(JSON.parse(await readFile(LOCK_PATH, "utf8")).pid || 0) : 0;
  if (target && pidAlive(target)) {
    console.log("      守护进程已在运行（pid " + target + "），不重复启动");
  } else {
    const pid = startWatcher();
    console.log("      已启动守护进程（pid " + pid + "）");
  }
  console.log("");

  console.log("[3/4] 等待本地代理就绪");
  let online = false;
  for (let i = 0; i < 24; i++) {
    if (await proxyAlive()) { online = true; break; }
    await sleep(500);
  }
  console.log(online ? "      ✅ 本地代理在线（127.0.0.1:" + PROXY_PORT + "）" : "      ⚠️ 代理暂未就绪，稍等片刻即可；详情见 " + LOG_PATH);
  console.log("");

  console.log("[4/4] 注入 ✨ 按钮");
  const port = await detectPort(null);
  if (port) {
    try {
      const uiSrc = await readFile(join(HERE, "inject", "ui.js"), "utf8");
      const { count, values } = await evaluateAll(port, uiSrc);
      const mounted = values.filter((v) => v && v.installed && v.mounted).length;
      console.log("      ✅ 已挂载 " + mounted + "/" + count + " 个渲染页面");
    } catch (err) {
      console.log("      ⚠️ 注入失败：" + (err?.message || err));
    }
  } else {
    console.log("      ⚠️ WorkBuddy 当前没在运行；守护进程会在它打开后自动注入，无需再操作");
  }

  console.log("");
  console.log("==================================================");
  console.log("  设置完成 —— 以后全自动，不需要再运行本文件");
  console.log("==================================================");
  console.log("· 每次登录 Windows：自动拉起守护进程 → 自动拉起本地代理");
  console.log("· WorkBuddy 一打开：自动注入 ✨ 按钮（按钮丢了会自动补回来）");
  console.log("");
  console.log("按钮用法：");
  console.log("  左键：优化输入框里的草稿（再点一次还原原文）");
  console.log("  右键：配置 API Key / 模型 / 服务地址 / 系统提示词（保存立即生效）");
  console.log("");
  console.log("查看状态：node cli.mjs status");
  console.log("彻底关闭：运行同目录下的「一键卸载.bat」");
}

async function cmdUninstall() {
  console.log("==================================================");
  console.log("  prompt-optimize 一键卸载");
  console.log("==================================================");
  console.log("");

  console.log("[1/4] 关闭开机自启");
  await cmdAutostart("off");
  console.log("");

  console.log("[2/4] 停止守护进程 + 卸载 ✨ 按钮");
  const watcherPid = await stopWatcher();
  console.log(watcherPid ? "      已停止守护进程（pid " + watcherPid + "）" : "      守护进程本来就没在运行");
  try { await unlink(LOCK_PATH); } catch {}
  const port = await detectPort(null);
  if (port) {
    try {
      const { count } = await evaluateAll(port, REMOVE_EXPR);
      console.log("      已从 " + count + " 个渲染页面卸载按钮");
    } catch (err) {
      console.log("      ⚠️ 页面卸载失败（WorkBuddy 可能没开着）：" + (err?.message || err));
    }
  } else {
    console.log("      WorkBuddy 没在运行，跳过页面卸载（它下次启动时也不会有按钮了）");
  }
  console.log("");

  console.log("[3/4] 停止本地代理");
  const killed = await stopProxy();
  console.log(killed ? "      已停止 " + killed + " 个代理进程（端口 " + PROXY_PORT + "）" : "      本地代理本来就没在运行");
  console.log("");

  console.log("[4/4] 清理运行痕迹");
  try { await unlink(LOG_PATH); } catch {}
  console.log("      已清理 .watch.lock / .watch.log");
  console.log("");
  console.log("✅ 卸载完成：自启已关、按钮已移除、守护与代理已停，重启后不会再自动启动。");
  console.log("   你的 config.json 已保留（API Key 等配置没删），重新运行「一键启动.bat」即可恢复。");
}

// node cli.mjs bootstrap [--json]
// 由本地代理的 POST /setup 调用：右键面板点「保存」时顺带把「一键启动」做掉。
// 与 cmdSetup 的区别：不注入按钮、不打印长篇说明、不等待代理（可能是代理自己在调），
// 目标是「幂等 + 快」，让用户只点一次保存就完成启动配置。
async function cmdBootstrap(asJson) {
  const r = { ok: false, autostart: false, autostartChanged: false, watcher: 0, watcherReused: false, proxy: false, notes: [] };

  // 1) 开机自启：内容一致就不重写，避免每次点保存都去动启动文件夹
  try {
    r.autostartChanged = await installAutostartFiles();
    r.autostart = true;
  } catch (err) {
    r.notes.push("开机自启写入失败：" + (err?.message || err));
  }

  // 2) 守护进程：已在跑就直接复用（单实例锁的意义就在这）
  let living = 0;
  try {
    const raw = JSON.parse(await readFile(LOCK_PATH, "utf8"));
    const pid = Number((raw && raw.pid) || 0);
    if (pid && pid !== process.pid && pidAlive(pid)) living = pid;
  } catch {
    // 没有锁文件
  }
  if (living) {
    r.watcher = living;
    r.watcherReused = true;
  } else {
    try {
      r.watcher = startWatcher();
    } catch (err) {
      r.notes.push("拉起守护进程失败：" + (err?.message || err));
    }
  }

  r.proxy = await proxyAlive();
  r.ok = r.autostart && Boolean(r.watcher);

  if (asJson) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return r;
  }

  console.log("—— 一键启动（由右键面板的「保存」触发）——");
  console.log((r.autostart ? "✅ 开机自启已就绪" : "❌ 开机自启失败") + (r.autostartChanged ? "（已写入启动文件夹）" : "（内容已是最新，未重复写入）"));
  console.log(r.watcher ? "✅ 守护进程在跑（pid " + r.watcher + "）" + (r.watcherReused ? "，直接复用" : "，已新拉起") : "❌ 守护进程未能启动");
  console.log(r.proxy ? "✅ 本地代理在线" : "⚠️ 本地代理暂未就绪");
  r.notes.forEach((n) => console.log("⚠️ " + n));
  return r;
}

// 页面端卸载表达式：cmdRemove 与 cmdUninstall 共用
const REMOVE_EXPR = `(() => {
    var st = window.__wbPromptOpt;
    if (st && st.stopGuard) { try { st.stopGuard(); } catch (e) {} }
    delete window.__wbPromptOpt;
    var btn = document.getElementById('wb-prompt-opt-btn');
    if (btn) btn.remove();
    var toast = document.getElementById('wb-prompt-opt-toast');
    if (toast) toast.remove();
    var panel = document.getElementById('wb-prompt-opt-panel');
    if (panel) panel.remove();
    var style = document.getElementById('wb-prompt-opt-style');
    if (style) style.remove();
    return { removed: true };
  })()`;

async function cmdRemove(port) {
  const { count } = await evaluateAll(port, REMOVE_EXPR);
  console.log(`✅ 已从 ${count} 个渲染页面卸载（端口 ${port}）`);
  // 停掉守护进程，否则它下一轮就会把按钮重新注入回来
  try {
    const raw = JSON.parse(await readFile(LOCK_PATH, "utf8"));
    if (raw && raw.pid && pidAlive(raw.pid)) {
      process.kill(raw.pid);
      console.log("已停止守护进程（pid " + raw.pid + "），按钮不会再自动回来");
    }
  } catch {
    // 没有守护进程在跑
  }
  try { await unlink(LOCK_PATH); } catch {}
  if (existsSync(STARTUP_VBS)) {
    console.log("⚠️ 开机自启仍处于开启状态：下次登录还会自动把它拉起来。");
    console.log("   要彻底关闭请执行：node cli.mjs autostart off");
  }
}

async function cmdStatus(port) {
  const expr = `(() => {
    var button = document.getElementById('wb-prompt-opt-btn');
    return {
      button: Boolean(button),
      inInputToolbar: Boolean(button && button.closest('.cr-input-toolbar__right')),
      hasState: Boolean(window.__wbPromptOpt),
      panelOpen: Boolean(document.getElementById('wb-prompt-opt-panel')),
      canRestore: Boolean(window.__wbPromptOpt && window.__wbPromptOpt.restored !== null)
    };
  })()`;
  const { values } = await evaluateAll(port, expr);
  console.log(`端口 ${port} 注入状态：`);
  values.forEach((v, i) => console.log(`  target[${i}]:`, JSON.stringify(v)));
  try {
    const r = await fetch(PROXY_URL + "/health", { signal: AbortSignal.timeout(1500) });
    const h = await r.json();
    console.log("代理：", JSON.stringify(h));
  } catch {
    console.log("代理：未运行（执行 node proxy.mjs，或用 一键启动.bat 的守护模式）");
  }
}

async function cmdDoctor(explicitPort) {
  console.log("—— prompt-optimize 诊断 ——");
  const port = await detectPort(explicitPort);
  if (!port) {
    console.log("❌ CDP 端口未开放（试过 " + (explicitPort || PORTS.join("/")) + "）。");
    console.log("   说明 WorkBuddy 当前没在运行（它启动时会自动开放 9334，见 ~/.workbuddy/app/session/DevToolsActivePort）。");
    process.exitCode = 1;
    return;
  }
  console.log("✅ CDP 可用：127.0.0.1:" + port);
  try {
    const targets = await fetchTargets(port);
    console.log(targets.length ? `✅ 找到 ${targets.length} 个渲染页面 target` : "❌ 没有 renderer/index.html target（WorkBuddy 主窗口未打开？）");
  } catch (err) {
    console.log("❌ /json/list 失败：" + err.message);
  }
  try {
    const res = await fetch(PROXY_URL + "/health", { signal: AbortSignal.timeout(2000) });
    const h = await res.json();
    console.log("✅ 本地代理在线：" + JSON.stringify(h));
    console.log("   系统提示词：" + (h.promptCustom ? "自定义" : "内置默认（与 prompt-optimize skill 一致）"));
    if (!h.hasKey) console.log("   ⚠️ 代理未配置 apiKey（config.json），真实优化会报错；protocol=mock 可先自测链路");
  } catch {
    console.log("⚠️ 本地代理未运行（127.0.0.1:9477）。执行 node proxy.mjs 或运行 一键启动.bat");
  }
  const auto = existsSync(STARTUP_VBS);
  console.log((auto ? "✅ 开机自启已开启" : "⚠️ 开机自启未开启（打开 WorkBuddy 不会自动就绪）") + (auto ? "" : "：执行 node cli.mjs autostart on"));
  console.log("   " + (existsSync(LOCK_PATH) ? "守护进程运行中（有锁文件）" : "守护进程未运行"));
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.cmd === "doctor") {
    await cmdDoctor(args.port);
  } else if (args.cmd === "watch") {
    await cmdWatch(args.port, args.interval);
  } else if (args.cmd === "autostart") {
    await cmdAutostart(args.sub);
  } else if (args.cmd === "setup") {
    await cmdSetup();
  } else if (args.cmd === "uninstall") {
    await cmdUninstall();
  } else if (args.cmd === "bootstrap") {
    await cmdBootstrap(args.json);
  } else {
    const port = await detectPort(args.port);
    if (!port) {
      console.error("❌ 连不上 CDP 端口。请确认 WorkBuddy 正在运行（它启动时会自动开放 9334），或用 --port 指定。");
      process.exit(1);
    }
    if (args.cmd === "apply") await cmdApply(port);
    else if (args.cmd === "remove") await cmdRemove(port);
    else if (args.cmd === "status") await cmdStatus(port);
    else {
      console.error("未知命令：" + args.cmd + "（可用：apply / remove / status / doctor / watch / autostart on|off|status / setup / uninstall / bootstrap）");
      process.exit(1);
    }
  }
} catch (err) {
  console.error("❌ " + (err?.message || err));
  process.exit(1);
}

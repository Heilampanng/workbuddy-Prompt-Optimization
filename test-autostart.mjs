// 开机自启测试：
//   1) 启动文件夹里确实有启动项，且与本地启动器内容一致
//   2) 启动脚本内容正确（隐藏窗口、不等待、node 路径多级兜底）
//   3) 启动脚本拼出的命令行严格等于 "node.exe" "cli.mjs" watch（用 JS 复算 VBScript 字符串转义）
//   4) 按启动脚本的方式（detached）拉起守护 → 自动起代理 + 写锁 + 写日志 + 按钮就位
//   5) 重复拉起被单实例锁拦住
// 用法：node test-autostart.mjs [port]
import { spawn, execSync } from "node:child_process";
import { readFile, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9334);
const PROXY_PORT = 9477;
const LOCK_PATH = join(HERE, ".watch.lock");
const LOG_PATH = join(HERE, ".watch.log");
const LOCAL_VBS = join(HERE, "start-daemon.vbs");
const STARTUP_DIR = join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_VBS = join(STARTUP_DIR, "prompt-optimize-watch.vbs");
const CLI = join(HERE, "cli.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅ " + name + (extra ? "  " + extra : "")); }
  else { fail++; console.log("  ❌ " + name + (extra ? "  " + extra : "")); }
}

function freeProxyPort() {
  let out = "";
  try { out = execSync("netstat -ano", { encoding: "utf8" }); } catch { return 0; }
  const re = new RegExp(":" + PROXY_PORT + "\\s");
  const pids = new Set();
  out.split(/\r?\n/).forEach((line) => {
    if (!/LISTENING/.test(line) || !re.test(line)) return;
    const m = line.trim().split(/\s+/);
    const pid = m[m.length - 1];
    if (/^\d+$/.test(pid) && pid !== "0" && Number(pid) !== process.pid) pids.add(pid);
  });
  pids.forEach((pid) => { try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" }); } catch {} });
  return pids.size;
}

// 直接探 /health：与守护进程自身的判断口径一致，比解析 netstat 可靠
async function proxyAlive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("CDP WebSocket 连接失败")); });
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
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
}

async function rendererTarget() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.find((t) => t.type === "page" && String(t.url || "").includes("renderer/index.html")) || null;
  } catch { return null; }
}

// 复算 VBScript 的字符串拼接：`cmd = """" & nodeExe & """ """ & "PATH" & """ watch"`
function evalVbsCmdLine(line, vars) {
  const rhs = line.replace(/^\s*cmd\s*=\s*/, "");
  const parts = rhs.split(" & ").map((p) => p.trim());
  let out = "";
  for (const p of parts) {
    if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
      out += p.slice(1, -1).replace(/""/g, '"');
    } else if (Object.prototype.hasOwnProperty.call(vars, p)) {
      out += vars[p];
    } else {
      throw new Error("无法解析的片段：" + JSON.stringify(p));
    }
  }
  return out;
}

let watcherPid = 0;
let ok = false;
try {
  console.log("【A】自启文件");
  check("本地启动器存在", existsSync(LOCAL_VBS), LOCAL_VBS);
  check("启动文件夹里有启动项", existsSync(STARTUP_VBS), STARTUP_VBS);
  const local = existsSync(LOCAL_VBS) ? await readFile(LOCAL_VBS, "utf8") : "";
  const startup = existsSync(STARTUP_VBS) ? await readFile(STARTUP_VBS, "utf8") : "";
  check("两处内容一致", Boolean(local) && local === startup);

  console.log("\n【B】启动脚本内容");
  check("含 Option Explicit", /^Option Explicit$/m.test(local));
  check("隐藏窗口 + 不等待（sh.Run cmd, 0, False）", /sh\.Run cmd, 0, False/.test(local));
  check("纯 ASCII（wscript 按 ANSI 读取，含中文会乱码）", /^[\x00-\x7F]*$/.test(local));
  check("指向 cli.mjs", local.includes(CLI));
  check("工作目录 = 项目目录", local.includes('sh.CurrentDirectory = "' + HERE + '"'));

  const candLine = /^cands = Array\((.*)\)$/m.exec(local);
  check("含 node 路径候选列表", Boolean(candLine));
  const cands = candLine ? candLine[1].split(/",\s*"/).map((s) => s.replace(/^"|"$/g, "")) : [];
  const firstAlive = cands.find((c) => existsSync(c));
  check("至少有一个候选 node 真实存在", Boolean(firstAlive), firstAlive || "(全部不存在)");
  check("含 WorkBuddy 自带 node 的兜底扫描", /fso\.GetFolder\(verDir\)\.SubFolders/.test(local));

  const cmdLine = /^\s*cmd\s*=\s*.*$/m.exec(local);
  check("含 cmd 拼接语句", Boolean(cmdLine));
  const built = cmdLine ? evalVbsCmdLine(cmdLine[0], { nodeExe: firstAlive }) : "";
  const expect = '"' + firstAlive + '" "' + CLI + '" watch';
  check("拼出的命令行正确", built === expect, JSON.stringify(built));

  console.log("\n【C】按自启脚本的方式拉起守护（detached + 无窗口，与 sh.Run cmd,0,False 等义）");
  try { await unlink(LOCK_PATH); } catch {}
  try { await unlink(LOG_PATH); } catch {} // 清掉旧日志，确保下面读到的是本次守护写的
  freeProxyPort();
  await sleep(500);

  const child = spawn(process.execPath, [CLI, "watch"], {
    cwd: HERE,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  watcherPid = child.pid;
  console.log("  已拉起守护进程 pid", watcherPid);

  let lockPid = 0;
  let buttonOk = false;
  let logText = "";
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try { lockPid = JSON.parse(await readFile(LOCK_PATH, "utf8")).pid || 0; } catch { lockPid = 0; }
    if (!logText) { try { logText = await readFile(LOG_PATH, "utf8"); } catch {} }
    const t = await rendererTarget();
    if (t) { try { buttonOk = await evaluate(t.webSocketDebuggerUrl, "Boolean(document.getElementById('wb-prompt-opt-btn'))"); } catch {} }
    if (lockPid && (await proxyAlive()) && buttonOk && logText) break;
  }

  check("锁文件 pid = 守护进程 pid", lockPid === watcherPid, "lock=" + lockPid + " child=" + watcherPid);
  check("守护自动拉起本地代理（/health 可访问）", await proxyAlive());
  check("守护写入了 .watch.log", logText.includes("守护模式"));
  check("日志不含密钥明文", !/sk-[A-Za-z0-9]{8,}/.test(logText));
  try {
    const st = await stat(LOG_PATH);
    check("日志大小受控（< 512KB）", st.size <= 512 * 1024, st.size + " bytes");
  } catch { check("日志文件可读", false); }
  check("页面上按钮就位", buttonOk);

  console.log("\n【D】重复拉起被单实例锁拦住");
  const second = await new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, "watch"], { cwd: HERE, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let s = "";
    c.stdout.on("data", (d) => { s += d.toString(); });
    c.stderr.on("data", (d) => { s += d.toString(); });
    const timer = setTimeout(() => { try { c.kill(); } catch {} resolve(s); }, 12000);
    c.on("exit", () => { clearTimeout(timer); resolve(s); });
  });
  check("第二次启动提示「已在运行」", /已在运行/.test(second), JSON.stringify(second.trim().split(/\r?\n/).filter(Boolean).pop() || ""));

  ok = fail === 0;
} catch (err) {
  console.error("\n❌ 测试异常：" + (err?.message || err));
  fail++;
} finally {
  if (watcherPid) { try { process.kill(watcherPid); } catch {} }
  await sleep(600);
  try { await unlink(LOCK_PATH); } catch {}
  freeProxyPort();
  console.log("\n通过 " + pass + " 项，失败 " + fail + " 项");
  if (ok && fail === 0) console.log("✅ 开机自启测试全部通过");
  else process.exitCode = 1;
}

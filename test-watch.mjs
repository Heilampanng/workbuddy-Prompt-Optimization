// 守护模式测试：模拟「WorkBuddy 重开后按钮消失」，验证 watch 会自动补注入
// 用法：node test-watch.mjs [port]
import { spawn, execSync } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9334);
const PROXY_PORT = 9477;
const LOCK_PATH = join(HERE, ".watch.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freeProxyPort() {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8" });
  } catch {
    return 0;
  }
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

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
  });
  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve, reject) => {
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

async function editorTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const cands = targets.filter(
    (t) => t.type === "page" && String(t.url || "").includes("renderer/index.html") && String(t.webSocketDebuggerUrl || "").startsWith("ws://127.0.0.1")
  );
  for (const c of cands) {
    const has = await evaluate(c.webSocketDebuggerUrl, `Boolean(document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']"))`);
    if (has) return c;
  }
  return null;
}

const REMOVE_EXPR = `(() => {
  var st = window.__wbPromptOpt;
  if (st && st.stopGuard) { try { st.stopGuard(); } catch (e) {} }
  delete window.__wbPromptOpt;
  ['wb-prompt-opt-btn', 'wb-prompt-opt-toast', 'wb-prompt-opt-panel'].forEach(function (id) {
    var n = document.getElementById(id); if (n) n.remove();
  });
  return { removed: true, button: Boolean(document.getElementById('wb-prompt-opt-btn')) };
})()`;

const HAS_BUTTON = "Boolean(document.getElementById('wb-prompt-opt-btn') && window.__wbPromptOpt && window.__wbPromptOpt.stopGuard)";

function pidAliveSync(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

// 启动一个 watch 子进程，收集其启动输出；waitMs 后返回（child 非空表示仍在运行）
function runWatchOnce(port, waitMs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [join(HERE, "cli.mjs"), "watch", "--port", String(port), "--interval", "1500"], {
      cwd: HERE,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let s = "";
    c.stdout.on("data", (d) => { s += d.toString(); });
    c.stderr.on("data", (d) => { s += d.toString(); });
    const timer = setTimeout(() => resolve({ out: s, child: c }), waitMs);
    c.on("exit", () => { clearTimeout(timer); resolve({ out: s, child: null, exited: true }); });
  });
}

let watcher = null;
let takeover = null;
let ok = false;
try {
  const target = await editorTarget();
  if (!target) throw new Error("没有找到含真实输入框的 renderer 页面");
  const ws = target.webSocketDebuggerUrl;

  try { await unlink(LOCK_PATH); } catch {}
  freeProxyPort();

  // 1) 模拟 WorkBuddy 重开：按钮与代理都不在
  const removed = await evaluate(ws, REMOVE_EXPR);
  console.log("1) 模拟重开（移除按钮）:", JSON.stringify(removed));
  if (removed.button) throw new Error("按钮未移除");

  // 2) 启动守护进程
  watcher = spawn(process.execPath, [join(HERE, "cli.mjs"), "watch", "--port", String(PORT), "--interval", "1500"], {
    cwd: HERE,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  watcher.stdout.on("data", (d) => { out += d.toString(); });
  watcher.stderr.on("data", (d) => { out += d.toString(); });
  console.log("2) 已启动守护进程 pid", watcher.pid);

  // 3) 等待自动补注入 + 自动拉起代理
  let restored = false;
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      if (await evaluate(ws, HAS_BUTTON)) { restored = true; break; }
    } catch {}
  }
  console.log("3) 守护后按钮已恢复:", restored);
  if (!restored) throw new Error("守护模式未自动补注入按钮；watcher 输出：\n" + out);

  let proxyOk = false;
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    proxyOk = r.ok;
  } catch {}
  console.log("   守护后代理在线:", proxyOk);
  if (!proxyOk) throw new Error("守护模式未自动拉起本地代理；watcher 输出：\n" + out);

  // 4) 单实例锁
  const lock = JSON.parse(await readFile(LOCK_PATH, "utf8"));
  console.log("4) 锁文件:", JSON.stringify(lock));
  if (!lock.pid) throw new Error("未写入守护进程锁");
  // 用异步 spawn 收集输出（Windows 上同步 spawnSync 会偶发 EBUSY）
  const second = await new Promise((resolve) => {
    const c = spawn(process.execPath, [join(HERE, "cli.mjs"), "watch"], {
      cwd: HERE,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let s = "";
    c.stdout.on("data", (d) => { s += d.toString(); });
    c.stderr.on("data", (d) => { s += d.toString(); });
    const timer = setTimeout(() => { try { c.kill(); } catch {} resolve(s); }, 12000);
    c.on("exit", () => { clearTimeout(timer); resolve(s); });
  });
  console.log("   再次启动守护:", JSON.stringify(second.trim().split(/\r?\n/).filter(Boolean).pop()));
  if (!/已在运行/.test(second)) throw new Error("第二个守护进程未被单实例锁拦住：" + second);

  // 5) 关闭守护：优雅退出应清理锁；被强制杀死会残留锁，但下一次启动必须能自动接管
  watcher.kill();
  watcher = null;
  await sleep(1500);
  let lockPid = 0;
  try { lockPid = JSON.parse(await readFile(LOCK_PATH, "utf8")).pid || 0; } catch { lockPid = 0; }

  if (lockPid === 0) {
    console.log("5) 守护退出后锁已清理: true");
  } else {
    // Windows 下 taskkill/child.kill 走 TerminateProcess，不触发 exit 钩子 → 锁残留属预期
    console.log("5) 守护被强制终止，锁文件残留（pid " + lockPid + "）—— 预期（Windows 强杀不触发退出钩子）");
    if (pidAliveSync(lockPid)) throw new Error("守护已退出，但锁仍指向存活进程 " + lockPid);
    const restart = await runWatchOnce(PORT, 3500);
    if (/已在运行/.test(restart.out)) throw new Error("残留锁阻塞了新守护启动：" + restart.out);
    if (!/守护模式/.test(restart.out)) throw new Error("新守护未正常接管：" + restart.out);
    console.log("   新守护已自动接管残留锁（自愈）: true");
    takeover = restart.child;
  }

  ok = true;
  console.log("\n✅ 守护模式测试通过（自动补注入 + 自动拉起代理 + 单实例锁 + 残留锁自愈）");
} catch (err) {
  console.error("\n❌ 测试失败：" + (err?.message || err));
  process.exitCode = 1;
} finally {
  if (watcher) { try { watcher.kill(); } catch {} }
  if (takeover) { try { takeover.kill(); } catch {} }
  try { await unlink(LOCK_PATH); } catch {}
  // 清理：卸掉测试期间的注入与代理
  try {
    const t = await editorTarget();
    if (t) await evaluate(t.webSocketDebuggerUrl, REMOVE_EXPR);
  } catch {}
  freeProxyPort();
  if (!ok) process.exitCode = 1;
}

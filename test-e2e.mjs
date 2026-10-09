// 端到端自测：启动临时 mock 代理，向真实 WorkBuddy 编辑器写入测试文案，模拟优化与还原，再恢复原文。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9334;
const PROXY_PORT = 9477;
const TEST_TEXT = "请帮我整理一个项目计划";

async function fetchTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  return targets.filter((t) => t.type === "page" && String(t.url || "").includes("renderer/index.html"));
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} 超时`)); }, 10000);
    pending.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  try {
    await send("Runtime.enable");
    // 关键：Chromium 在渲染器处于后台时会拒绝编辑命令（execCommand 返回 false）。
    // 自动化测试时窗口通常不在前台，这里把它带到前台，等价于用户真实点击按钮时的状态。
    try { await send("Page.bringToFront"); } catch {}
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  } finally {
    ws.close();
  }
}

async function waitForProxy(child) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("临时代理提前退出");
    try {
      const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(300) });
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("临时代理启动超时");
}

const proxy = spawn(process.execPath, [join(HERE, "proxy.mjs")], {
  cwd: HERE,
  windowsHide: true,
  stdio: "ignore",
  env: { ...process.env, PROMPT_OPT_PROTOCOL: "mock" },
});
let target;
let originalText = "";
let editorChanged = false;
let skipped = false;
try {
  await waitForProxy(proxy);
  const candidates = await fetchTargets();
  for (const candidate of candidates) {
    const hasEditor = await evaluate(candidate.webSocketDebuggerUrl, `Boolean(document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']"))`);
    const hasButton = await evaluate(candidate.webSocketDebuggerUrl, `Boolean(document.getElementById("wb-prompt-opt-btn"))`);
    if (hasEditor && hasButton) { target = candidate; break; }
  }
  if (!target) throw new Error("没有找到同时含输入框与优化按钮的 renderer 页面；请先运行 node cli.mjs apply");

  // 前置条件：Chromium 在页面不可见时会拒绝一切编辑命令（execCommand / Input.insertText 均返回 false）。
  // 这里显式检查，避免把「环境不可见」误报成「草稿为空」这类看上去像代码缺陷的失败。
  const vis = await evaluate(target.webSocketDebuggerUrl, `(() => ({ visibility: document.visibilityState, hasFocus: document.hasFocus() }))()`);
  if (vis.visibility !== "visible") {
    console.error("⚠️ 前置条件不满足：WorkBuddy 渲染页面当前不可见（visibility=" + vis.visibility + ", hasFocus=" + vis.hasFocus + "）。");
    console.error("   真实编辑类 e2e 需要 WorkBuddy 窗口可见并位于前台；请把 WorkBuddy 窗口切到前台后重跑本测试。");
    console.error("   （面板 / 守护 / 代理层测试不受此限制，可正常运行。）");
    skipped = true;
    throw new Error("SKIP: 窗口不可见，跳过真实编辑 e2e");
  }

  const init = `(() => {
    var ed = document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']");
    var btn = document.getElementById("wb-prompt-opt-btn");
    if (!ed || !btn) return { ok: false, editor: Boolean(ed), button: Boolean(btn) };
    var clone = ed.cloneNode(true);
    var re = /今天帮你做些什么|添加上下文|调用技能与指令|有什么可以帮你|Describe what/i;
    Array.prototype.slice.call(clone.querySelectorAll("*")).forEach(function(e){
      if(e.children.length===0 && re.test((e.textContent||"").trim())) e.remove();
    });
    var orig = (clone.innerText || clone.textContent || "").replace(/\uFEFF/g, "").trim();
    ed.focus(); document.execCommand("selectAll", false, null); document.execCommand("insertText", false, ${JSON.stringify(TEST_TEXT)});
    return { ok: true, original: orig };
  })()`;
  // 写入草稿并确认落到 DOM：渲染器偶发拒绝编辑命令（窗口未聚焦等），因此重试若干轮。
  // originalText 只取第一轮（尚未被测试改写）的值，供 finally 还原。
  let draftVisible = false;
  for (let round = 0; round < 12 && !draftVisible; round++) {
    const before = await evaluate(target.webSocketDebuggerUrl, init);
    if (!before.ok) throw new Error("编辑器/按钮不存在：" + JSON.stringify(before));
    if (round === 0) originalText = before.original;
    // 等待 React/Slate 更新输入 DOM 后再点击，避免测试点击落在旧帧的占位状态。
    for (let i = 0; i < 10; i++) {
      const visible = await evaluate(target.webSocketDebuggerUrl, `(() => {
        var ed = document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']");
        return Boolean(ed && (ed.innerText || "").includes(${JSON.stringify(TEST_TEXT)}));
      })()`);
      if (visible) { draftVisible = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!draftVisible) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!draftVisible) {
    throw new Error("无法把测试草稿写入编辑器：渲染器拒绝了编辑命令（通常是 WorkBuddy 窗口不在前台）。请把窗口切到前台后重跑。");
  }
  editorChanged = true;
  await evaluate(target.webSocketDebuggerUrl, `document.getElementById("wb-prompt-opt-btn").click(); true`);
  let optimizedState = null;
  for (let i = 0; i < 80; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    optimizedState = await evaluate(target.webSocketDebuggerUrl, `(() => ({
      canRestore: Boolean(window.__wbPromptOpt && window.__wbPromptOpt.restored !== null),
      text: (document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']") || {}).innerText || "",
      toast: (document.getElementById("wb-prompt-opt-toast") || {}).textContent || ""
    }))()`);
    if (optimizedState.canRestore) break;
    if (optimizedState.toast.indexOf("优化失败") >= 0) throw new Error(optimizedState.toast);
  }
  if (!optimizedState?.canRestore) throw new Error("优化请求未在 8 秒内完成；页面状态=" + JSON.stringify(optimizedState));
  if (!optimizedState.text.includes("mock 优化")) throw new Error("mock 优化文本未写入：" + optimizedState.text);
  if (/今天帮你做些什么|添加上下文|调用技能与指令/.test(optimizedState.text)) {
    throw new Error("占位文案混入了优化结果：" + optimizedState.text);
  }

  await evaluate(target.webSocketDebuggerUrl, `document.getElementById("wb-prompt-opt-btn").click(); true`);
  const restored = await evaluate(target.webSocketDebuggerUrl, `(() => ({
    canRestore: Boolean(window.__wbPromptOpt && window.__wbPromptOpt.restored !== null),
    text: (document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']") || {}).innerText || ""
  }))()`);
  if (restored.canRestore) throw new Error("还原状态未清除");
  if (!restored.text.includes(TEST_TEXT)) throw new Error("原始草稿未还原：" + restored.text);

  console.log(JSON.stringify({
    ok: true,
    injected: true,
    mockOptimizationWriteback: true,
    restoredOriginalDraft: true,
    optimizedPreview: optimizedState.text.trim().slice(0, 180),
    restoredPreview: restored.text.trim().slice(0, 100),
  }, null, 2));
} catch (err) {
  if (skipped) {
    console.error("\n⏭️  已跳过真实编辑 e2e（WorkBuddy 窗口不可见）。窗口切到前台后重跑即可。");
    process.exitCode = 2;
  } else {
    console.error("\n❌ e2e 失败：" + (err?.message || err));
    process.exitCode = 1;
  }
} finally {
  if (editorChanged && target) {
    try {
      await evaluate(target.webSocketDebuggerUrl, `(() => {
        var ed = document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']");
        if (ed) { ed.focus(); document.execCommand("selectAll", false, null); document.execCommand("insertText", false, ${JSON.stringify(originalText)}); }
        return true;
      })()`);
    } catch (err) {
      console.error("提示：未能自动恢复测试前草稿：" + err.message);
    }
  }
  proxy.kill();
}

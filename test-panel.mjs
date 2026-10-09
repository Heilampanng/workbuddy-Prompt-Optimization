// 右键配置面板端到端测试：
// 注入 → 右键打开面板 → 校验回填（含系统提示词）→ 保存（含自定义提示词）→ 试连 → 清除密钥 → 恢复默认提示词 → Esc 关闭
// 用法：node test-panel.mjs [port]
import { spawn, execSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || 9334);
const PROXY_PORT = 9477;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 上一轮可能留下常驻代理占用 9477，会让本次测试连到旧配置上；先释放端口。
// 注意：不能用 findstr 过滤（execSync 下嵌套引号会被 cmd 解析错），在 JS 里过滤。
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
  pids.forEach((pid) => {
    try {
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      console.log(`   （已释放端口 ${PROXY_PORT}：停止旧进程 pid ${pid}）`);
    } catch {}
  });
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
      const timer = setTimeout(() => reject(new Error(`CDP ${method} 超时`)), 30000);
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

async function findEditorTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const candidates = targets.filter(
    (t) => t.type === "page" && String(t.url || "").includes("renderer/index.html") && String(t.webSocketDebuggerUrl || "").startsWith("ws://127.0.0.1")
  );
  for (const c of candidates) {
    const has = await evaluate(c.webSocketDebuggerUrl, `Boolean(document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']"))`);
    if (has) return c;
  }
  return null;
}

async function waitForProxy(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

const CONFIG_PATH = join(HERE, "config.json");
const CONFIG_BAK = join(HERE, "config.json.testbak");
const CUSTOM_PROMPT = "你是我的专属提示词教练。【测试标记 CUSTOM-PROMPT】只输出优化后的提示词。";

let proxy = null;
let ok = false;
let hadConfig = false;
try {
  // 关键：先备份用户真实配置，测完原样还原（绝不能拿默认值覆盖用户已填的 API Key）
  try {
    await writeFile(CONFIG_BAK, await readFile(CONFIG_PATH, "utf8"), "utf8");
    hadConfig = true;
  } catch {
    hadConfig = false;
  }

  freeProxyPort();
  proxy = spawn(process.execPath, [join(HERE, "proxy.mjs")], {
    cwd: HERE,
    windowsHide: true,
    stdio: "ignore",
    env: { ...process.env, PROMPT_OPT_PROTOCOL: "", PROMPT_OPT_KEY: "" },
  });
  if (!(await waitForProxy())) throw new Error("本地代理未就绪（端口 " + PROXY_PORT + " 可能被占用）");

  // 代理必须是我们刚起的这一份（旧进程代码里没有 prompt 字段）
  const boot = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/config`)).json();
  if (boot?.config?.prompt === undefined) {
    throw new Error("9477 上跑的不是当前版本的代理（/config 无 prompt 字段），请先停掉旧代理");
  }

  const target = await findEditorTarget();
  if (!target) throw new Error("没有找到含真实输入框的 renderer 页面");
  const ws = target.webSocketDebuggerUrl;

  // 1) 注入
  const uiSrc = await readFile(join(HERE, "inject", "ui.js"), "utf8");
  const inject = await evaluate(ws, uiSrc);
  console.log("1) 注入:", JSON.stringify(inject));
  if (!inject || !inject.mounted) throw new Error("按钮未挂载");

  // 2) 右键打开面板（校验回填，含系统提示词）
  await evaluate(ws, `(() => {
    window.__poTestErrors = [];
    window.addEventListener('unhandledrejection', function (e) {
      window.__poTestErrors.push(String((e.reason && e.reason.stack) || e.reason));
    });
    var btn = document.getElementById('wb-prompt-opt-btn');
    btn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window, button: 2 }));
    return true;
  })()`);
  await sleep(1200);
  const opened = await evaluate(ws, `(() => {
    var p = document.getElementById('wb-prompt-opt-panel');
    var dbg = {
      lastConfigError: (window.__wbPromptOpt && window.__wbPromptOpt.lastConfigError) || null,
      errors: window.__poTestErrors || []
    };
    if (!p) return { panel: false, dbg: dbg };
    var g = function (n) { var e = p.querySelector('[data-po="' + n + '"]'); return e ? e.value : null; };
    var t = function (n) { var e = p.querySelector('[data-po="' + n + '"]'); return e ? e.textContent : null; };
    var r = p.getBoundingClientRect();
    var promptText = g('prompt') || '';
    return {
      panel: true,
      protocol: g('protocol'), baseUrl: g('baseUrl'), model: g('model'), style: g('style'),
      apiKeyValue: g('apiKey'),
      apiKeyPlaceholder: (p.querySelector('[data-po="apiKey"]') || {}).placeholder,
      // 密钥默认必须打码（password），且带「显示 / 隐藏」开关
      apiKeyType: (p.querySelector('[data-po="apiKey"]') || {}).type,
      keyToggleText: (p.querySelector('[data-po="keyToggle"]') || {}).textContent,
      // 面板里不应再出现「已填入上方：sk-…」那行小字
      keyStateExists: Boolean(p.querySelector('[data-po="keyState"]')),
      panelBg: getComputedStyle(p).backgroundColor,
      panelColor: getComputedStyle(p).color,
      promptLength: promptText.length,
      promptValue: promptText,
      promptHasDefaultMark: promptText.indexOf('你是提示词优化器') !== -1,
      promptHasSkillRule: promptText.indexOf('优化流程') !== -1 && promptText.indexOf('质量要求') !== -1,
      promptHint: t('promptHint'),
      status: t('status'),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      insideViewport: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      dbg: dbg
    };
  })()`);
  // 日志里不要把完整密钥/长提示词打出来
  const redact = (o) => {
    const c = { ...o };
    if (c.apiKeyValue) c.apiKeyValue = "<已回填 " + c.apiKeyValue.length + " 字符>";
    if (c.promptValue) c.promptValue = "<" + c.promptValue.length + " 字符>";
    return c;
  };
  console.log("2) 右键打开面板:", JSON.stringify(redact(opened)));
  if (!opened.panel) throw new Error("右键未打开配置面板；dbg=" + JSON.stringify(opened.dbg));
  if (opened.protocol !== "openai" || !opened.baseUrl) throw new Error("面板未正确回填配置：" + JSON.stringify(opened));
  // API Key 必须按 /config 回填（有密钥就直接显示，不留空）
  const cfg0 = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/config`)).json();
  const expectKey = cfg0.config.apiKey || "";
  if ((opened.apiKeyValue || "") !== expectKey) {
    throw new Error("API Key 未按 /config 回填：面板=" + (opened.apiKeyValue || "").length + " 字符，/config=" + expectKey.length + " 字符");
  }
  if (expectKey && !opened.apiKeyValue) throw new Error("config.json 里明明有密钥，面板却留空");
  console.log("   API Key 回填:", opened.apiKeyValue ? "✓（" + opened.apiKeyValue.length + " 字符）" : "✓（当前无密钥）");
  // 密钥默认打码；「显示 / 隐藏」切换只改 type，不动值
  if (opened.apiKeyType !== "password") throw new Error("密钥未隐藏（type=" + opened.apiKeyType + "，应为 password）");
  if (opened.keyToggleText !== "显示") throw new Error("密钥开关初始文案应为「显示」，实际：" + opened.keyToggleText);
  const toggled = await evaluate(ws, `(() => {
    var p = document.getElementById('wb-prompt-opt-panel');
    var inp = p.querySelector('[data-po="apiKey"]');
    var btn = p.querySelector('[data-po="keyToggle"]');
    var v0 = inp.value;
    var a = inp.type;
    btn.click();
    var b = inp.type, lab1 = btn.textContent;
    btn.click();
    return { initType: a, revealedType: b, revealLabel: lab1, backType: inp.type, backLabel: btn.textContent, valueKept: inp.value === v0 };
  })()`);
  if (toggled.initType !== "password" || toggled.revealedType !== "text" || toggled.backType !== "password") {
    throw new Error("密钥显示/隐藏切换异常：" + JSON.stringify(toggled));
  }
  if (toggled.revealLabel !== "隐藏" || toggled.backLabel !== "显示") throw new Error("开关文案未随状态切换：" + JSON.stringify(toggled));
  if (!toggled.valueKept) throw new Error("切换显示状态时密钥值被改动了");
  console.log("   密钥已隐藏: ✓（password 圆点，点「显示」可临时揭开；切换不影响取值）");
  // 密钥下方那行「已填入上方：sk-…，共 N 字符…」小字应已删除
  if (opened.keyStateExists) throw new Error("面板里仍存在 keyState 小字节点，应已删除");
  console.log("   小字已删除: ✓");
  // 面板应为浅色主题（白底深字），与 WorkBuddy 一致
  const rgbOf = (s) => (String(s).match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
  const pBg = rgbOf(opened.panelBg);
  const pFg = rgbOf(opened.panelColor);
  if (pBg.length < 3 || pBg.some((v) => v < 240)) throw new Error("面板底色不是白色系：" + opened.panelBg);
  if (pFg.length < 3 || pFg.some((v) => v > 90)) throw new Error("面板文字不是深色：" + opened.panelColor);
  console.log("   主题: ✓ 浅色（底色 " + opened.panelBg + " / 文字 " + opened.panelColor + "）");
  // 提示词断言必须按「用户当前的配置」判，不能假设是内置默认：
  // 用户可能已经在面板里把系统提示词改成自己的版本了。
  const cfg0Prompt = cfg0.config.prompt || "";
  if (cfg0.config.promptCustom) {
    if ((opened.promptValue || "") !== cfg0Prompt) {
      throw new Error("面板提示词与 /config 不一致：面板 " + (opened.promptValue || "").length + " 字符，/config " + cfg0Prompt.length + " 字符");
    }
    if (!/自定义/.test(opened.promptHint || "")) throw new Error("提示词状态未标记为自定义：" + opened.promptHint);
    console.log("   提示词回填: ✓（用户自定义，" + cfg0Prompt.length + " 字符）");
  } else {
    if (!opened.promptHasDefaultMark) throw new Error("面板未回填系统提示词：" + JSON.stringify(redact(opened)));
    if (!opened.promptHasSkillRule) throw new Error("默认提示词与 prompt-optimize skill 不一致（缺优化流程/质量要求）");
    if (!/内置默认/.test(opened.promptHint || "")) throw new Error("提示词状态说明不正确：" + opened.promptHint);
    console.log("   提示词回填: ✓（内置默认，" + cfg0Prompt.length + " 字符）");
  }
  if (!opened.insideViewport) throw new Error("面板超出视口：" + JSON.stringify(opened.rect));

  // 3) 填 mock + 假 key + 自定义提示词并保存
  const saved = await evaluate(ws, `(async () => {
    var p = document.getElementById('wb-prompt-opt-panel');
    var set = function (n, v) { p.querySelector('[data-po="' + n + '"]').value = v; };
    set('protocol', 'mock');
    set('baseUrl', 'https://api.deepseek.com/v1');
    set('model', 'deepseek-chat');
    set('style', 'concise');
    set('apiKey', 'sk-panel-test-000011112222');
    set('prompt', ${JSON.stringify(CUSTOM_PROMPT)});
    p.querySelector('[data-po="save"]').click();
    // 「保存」现在还会顺带触发一键启动（写开机自启 + 拉起守护进程），所以轮询等状态落定
    var st = '';
    for (var i = 0; i < 40; i++) {
      await new Promise(function (r) { setTimeout(r, 400); });
      st = p.querySelector('[data-po="status"]').textContent || '';
      if (st && st.indexOf('保存并启动中') === -1) break;
    }
    return {
      status: st,
      saveHint: (p.querySelector('[data-po="saveHint"]') || {}).textContent || '',
      keyStateExistsAfterSave: Boolean(p.querySelector('[data-po="keyState"]')),
      apiKeyValueAfterSave: p.querySelector('[data-po="apiKey"]').value,
      apiKeyTypeAfterSave: p.querySelector('[data-po="apiKey"]').type,
      placeholder: p.querySelector('[data-po="apiKey"]').placeholder,
      promptHint: p.querySelector('[data-po="promptHint"]').textContent,
      promptValue: p.querySelector('[data-po="prompt"]').value
    };
  })()`);
  console.log("3) 保存:", JSON.stringify(redact(saved)));
  if (!/✅/.test(saved.status || "")) throw new Error("保存未成功：" + saved.status);
  // 「已保存并生效」只出现在「保存 + 一键启动」合并后的分支里，用它证明合并逻辑确实跑了
  if (!/已保存并生效/.test(saved.status || "")) throw new Error("保存状态文案不是合并后的版本：" + saved.status);
  if (!/开机自启|一键启动/.test(saved.status || "")) throw new Error("保存后的状态没有体现一键启动结果：" + saved.status);
  if (!/一键启动/.test(saved.saveHint || "")) throw new Error("面板没有提示「保存即完成一键启动」：" + saved.saveHint);
  // 保存后仍应把（新）密钥回填在输入框里，而不是清空
  if (saved.apiKeyValueAfterSave !== "sk-panel-test-000011112222") {
    throw new Error("保存后密钥输入框未回填已保存的密钥（实际 " + (saved.apiKeyValueAfterSave || "").length + " 字符）");
  }
  // 保存后仍保持隐藏态（不会因为重填就变回明文）
  if (saved.apiKeyTypeAfterSave !== "password") throw new Error("保存后密钥变回明文（type=" + saved.apiKeyTypeAfterSave + "）");
  if (saved.promptValue !== CUSTOM_PROMPT) throw new Error("保存后提示词被改写：" + saved.promptValue);
  if (!/自定义/.test(saved.promptHint || "")) throw new Error("提示词状态未标记为自定义：" + saved.promptHint);

  const onDisk = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  console.log("   config.json:", JSON.stringify(onDisk));
  if (onDisk.protocol !== "mock" || onDisk.style !== "concise") throw new Error("配置未写入 config.json");
  if (onDisk.prompt !== CUSTOM_PROMPT) throw new Error("系统提示词未写入 config.json：" + JSON.stringify(onDisk.prompt));

  // 3b) 生效校验：/config 返回的 prompt 应等于自定义提示词
  const cfgResp = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/config`)).json();
  if (cfgResp.config.prompt !== CUSTOM_PROMPT || cfgResp.config.promptCustom !== true) {
    throw new Error("代理未使用自定义提示词：" + JSON.stringify({ p: cfgResp.config.prompt, c: cfgResp.config.promptCustom }));
  }
  console.log("   生效提示词：自定义 ✓");

  // 3c) 一键启动端点：面板「保存」背后调的就是它，这里直接校验契约与幂等性
  const postSetup = async () => {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/setup`, { method: "POST" });
    const j = await r.json().catch(() => null);
    return { http: r.status, body: j };
  };
  const b1 = await postSetup();
  console.log("   3c-1) POST /setup:", JSON.stringify(b1));
  if (b1.http !== 200) throw new Error("/setup 应始终返回 200，实际 " + b1.http);
  if (!b1.body || b1.body.ok !== true) throw new Error("/setup 未成功：" + JSON.stringify(b1.body));
  if (b1.body.autostart !== true) throw new Error("/setup 未安装开机自启：" + JSON.stringify(b1.body));
  if (!b1.body.watcher) throw new Error("/setup 未拉起守护进程：" + JSON.stringify(b1.body));

  const b2 = await postSetup();
  console.log("   3c-2) 再调一次（幂等）:", JSON.stringify(b2));
  if (!b2.body || b2.body.ok !== true) throw new Error("/setup 第二次调用失败：" + JSON.stringify(b2.body));
  if (b2.body.autostartChanged !== false) throw new Error("/setup 非幂等：内容没变却重写了自启文件");
  if (b2.body.watcher !== b1.body.watcher) throw new Error("/setup 非幂等：守护进程 pid 变化 " + b1.body.watcher + " → " + b2.body.watcher);
  console.log("   一键启动端点：契约 + 幂等 ✓");

  // 4) 试连（mock）
  const tested = await evaluate(ws, `(async () => {
    var p = document.getElementById('wb-prompt-opt-panel');
    p.querySelector('[data-po="test"]').click();
    await new Promise(function (r) { setTimeout(r, 1500); });
    return p.querySelector('[data-po="status"]').textContent;
  })()`);
  console.log("4) 试连:", JSON.stringify(tested));
  if (!/✅/.test(tested || "")) throw new Error("试连未成功：" + tested);

  // 5) 清除密钥
  await evaluate(ws, `(async () => {
    var p = document.getElementById('wb-prompt-opt-panel');
    p.querySelector('[data-po="clear"]').click();
    await new Promise(function (r) { setTimeout(r, 1200); });
    return true;
  })()`);
  const afterClear = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (afterClear.apiKey !== "") throw new Error("清除密钥后 config.json 仍有 apiKey：" + afterClear.apiKey);
  console.log("5) 清除密钥: ✓");

  // 6) 恢复默认提示词
  const reset = await evaluate(ws, `(async () => {
    var p = document.getElementById('wb-prompt-opt-panel');
    p.querySelector('[data-po="promptReset"]').click();
    await new Promise(function (r) { setTimeout(r, 1400); });
    var v = p.querySelector('[data-po="prompt"]').value || '';
    return {
      status: p.querySelector('[data-po="status"]').textContent,
      promptLength: v.length,
      promptHasDefaultMark: v.indexOf('你是提示词优化器') !== -1,
      promptHint: p.querySelector('[data-po="promptHint"]').textContent
    };
  })()`);
  console.log("6) 恢复默认提示词:", JSON.stringify(reset));
  if (!/✅/.test(reset.status || "")) throw new Error("恢复默认失败：" + reset.status);
  if (!reset.promptHasDefaultMark) throw new Error("恢复后未显示默认提示词：" + JSON.stringify(reset));
  if (!/内置默认/.test(reset.promptHint || "")) throw new Error("恢复后状态未标记为内置默认：" + reset.promptHint);
  const afterReset = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  if (afterReset.prompt) throw new Error("恢复默认后 config.json.prompt 应为空：" + JSON.stringify(afterReset.prompt));

  // 7) 关闭面板（Esc）
  const closed = await evaluate(ws, `(async () => {
    var p = document.getElementById('wb-prompt-opt-panel');
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 300); });
    return { panel: Boolean(document.getElementById('wb-prompt-opt-panel')) };
  })()`);
  console.log("7) Esc 关闭面板:", JSON.stringify(closed));
  if (closed.panel) throw new Error("Esc 未关闭面板");

  ok = true;
  console.log("\n✅ 右键配置面板端到端测试通过（含系统提示词）");
} catch (err) {
  console.error("\n❌ 测试失败：" + (err?.message || err));
  process.exitCode = 1;
} finally {
  if (proxy) { try { proxy.kill(); } catch {} }
  // 还原用户真实配置（不是默认值）
  if (hadConfig) {
    try {
      await writeFile(CONFIG_PATH, await readFile(CONFIG_BAK, "utf8"), "utf8");
      await unlink(CONFIG_BAK);
      console.log("已还原 config.json 为用户测试前的真实配置");
    } catch (e) {
      console.error("⚠️ 还原 config.json 失败，备份仍在：" + CONFIG_BAK + " — " + (e?.message || e));
    }
  } else {
    // 测试前没有 config.json（全新克隆的干净环境）：把本次测试写入的残留清掉
    try {
      await unlink(CONFIG_PATH);
      console.log("（测试前没有 config.json，已清理测试产生的残留）");
    } catch {
      console.log("（测试前没有 config.json，未做还原）");
    }
  }
  if (!ok) process.exitCode = 1;
}

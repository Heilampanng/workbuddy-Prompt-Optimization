// prompt-optimize 页面端 UI（经 CDP Runtime.evaluate 注入 WorkBuddy 渲染页面）
// 功能：在输入框工具栏插入 ✨ 按钮；点击读取草稿（过滤占位符）→ 调本地代理优化 → 写回；再点还原。
(function () {
  "use strict";

  var STATE_KEY = "__wbPromptOpt";
  var BTN_ID = "wb-prompt-opt-btn";
  var TOAST_ID = "wb-prompt-opt-toast";
  var PROXY = "http://127.0.0.1:9477";

  // 重复注入时先清掉旧实例的守护定时器，再重建
  if (window[STATE_KEY] && window[STATE_KEY].stopGuard) {
    try { window[STATE_KEY].stopGuard(); } catch (e) {}
  }
  var old = document.getElementById(BTN_ID);
  if (old && old.parentNode) old.parentNode.removeChild(old);

  // ---------- 工具函数 ----------
  function findEditor() {
    // 首选输入框宿主内的 contenteditable，退化为全页唯一 textbox
    var ed = document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']");
    if (!ed) ed = document.querySelector(".cr-input-container [contenteditable='true']");
    if (!ed) ed = document.querySelector("div[role='textbox'][contenteditable='true']");
    return ed || null;
  }

  var PLACEHOLDER_RE = /今天帮你做些什么|添加上下文|调用技能与指令|有什么可以帮你|Describe what/i;

  // 取一个文本节点里「用户真实输入」的部分：剔除 Slate 占位符与零宽占位节点。
  // 占位符是真实 DOM 节点（data-slate-placeholder / data-slate-zero-width），会混进 innerText。
  function realText(node) {
    var c = node.cloneNode(true);
    var junk = c.querySelectorAll("[data-slate-placeholder], [data-slate-zero-width]");
    for (var k = 0; k < junk.length; k++) {
      if (junk[k].parentNode) junk[k].parentNode.removeChild(junk[k]);
    }
    return (c.textContent || "").replace(/\uFEFF/g, "");
  }

  // 读取草稿。优先按 Slate 结构逐块提取：
  // 关键点——脱离文档的 clone 没有布局，innerText 会退化成 textContent（多行被黏成一行），
  // 所以不能靠 clone.innerText 取文本，必须按 data-slate-node 结构还原块与换行。
  function readDraft(ed) {
    var texts = ed.querySelectorAll('[data-slate-node="text"]');
    if (texts.length) {
      var blocks = [];   // 保序的块（通常是一个 <p>）
      var acc = [];      // 与 blocks 一一对应的累计文本
      for (var i = 0; i < texts.length; i++) {
        var node = texts[i];
        var block = node.closest ? (node.closest('[data-slate-node="element"]') || ed) : ed;
        var idx = blocks.indexOf(block);
        if (idx === -1) { blocks.push(block); acc.push(""); idx = acc.length - 1; }
        acc[idx] += realText(node);
      }
      var lines = [];
      for (var b = 0; b < blocks.length; b++) {
        var ln = acc[b].replace(/\s+$/, "");
        if (!ln.trim()) {
          // 空块只在块间补一个空行，首尾不留空行
          if (lines.length && lines[lines.length - 1] !== "") lines.push("");
          continue;
        }
        if (PLACEHOLDER_RE.test(ln)) continue; // 兜底：整块就是占位符
        lines.push(ln);
      }
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return lines.join("\n").trim();
    }
    // 退化路径：非 Slate 编辑器，用「已挂载元素」的 innerText（有布局，换行正确）
    var clone = ed.cloneNode(true);
    var junk2 = clone.querySelectorAll("[data-slate-placeholder], [data-slate-zero-width]");
    for (var k2 = 0; k2 < junk2.length; k2++) {
      if (junk2[k2].parentNode) junk2[k2].parentNode.removeChild(junk2[k2]);
    }
    var raw = (ed.innerText || clone.textContent || "").replace(/\uFEFF/g, "");
    var keptLines = [];
    raw.split("\n").forEach(function (line) {
      var t = line.trim();
      if (!t) { if (keptLines.length && keptLines[keptLines.length - 1] !== "") keptLines.push(""); return; }
      if (PLACEHOLDER_RE.test(t)) return;
      keptLines.push(line);
    });
    while (keptLines.length && keptLines[keptLines.length - 1] === "") keptLines.pop();
    return keptLines.join("\n").trim();
  }

  // 写回文本：全选 + insertText（走编辑器的 undo 栈，用户可 Ctrl+Z）
  function writeText(ed, text) {
    ed.focus();
    try {
      var sel = window.getSelection();
      var range = document.createRange();
      range.selectNodeContents(ed);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
    try { document.execCommand("selectAll", false, null); } catch (e) {}
    var ok = false;
    try { ok = document.execCommand("insertText", false, text) !== false; } catch (e) {}
    return ok;
  }

  // ---------- Toast ----------
  function ensureToast() {
    var t = document.getElementById(TOAST_ID);
    if (t) return t;
    t = document.createElement("div");
    t.id = TOAST_ID;
    t.style.cssText = [
      "position:fixed", "left:50%", "bottom:96px", "transform:translateX(-50%)",
      "max-width:520px", "padding:8px 14px", "border-radius:10px",
      "background:#ffffff", "color:#1f2329", "font-size:13px",
      "line-height:1.5", "z-index:2147483000", "pointer-events:none",
      "opacity:0", "transition:opacity .18s ease", "white-space:pre-wrap",
      "border:1px solid #e6e8ec", "box-shadow:0 6px 22px rgba(16,24,40,.16)"
    ].join(";");
    document.body.appendChild(t);
    return t;
  }
  var toastTimer = null;
  function toast(msg, ms) {
    var t = ensureToast();
    t.textContent = msg;
    t.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = "0"; }, ms || 2200);
  }

  // ---------- 按钮 ----------
  function buildButton() {
    var btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    btn.title = "左键：优化草稿（再点还原） · 右键：设置 API Key 与系统提示词";
    btn.setAttribute("aria-label", "优化提示词草稿，右键打开设置");
    btn.style.cssText = [
      "width:30px", "height:30px", "padding:0", "border:none", "border-radius:50%",
      "background:transparent", "cursor:pointer", "display:inline-flex",
      "align-items:center", "justify-content:center", "font-size:16px",
      "line-height:1", "flex:0 0 auto", "transition:background .15s ease, transform .15s ease",
      "color:inherit"
    ].join(";");
    btn.innerHTML = '<span style="pointer-events:none">✨</span>';
    btn.addEventListener("mouseenter", function () {
      btn.style.background = "rgba(127,127,140,0.18)";
    });
    btn.addEventListener("mouseleave", function () {
      btn.style.background = "transparent";
    });
    btn.addEventListener("click", onClick);
    btn.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleConfig();
    });
    return btn;
  }

  function setBusy(busy) {
    var btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (busy) {
      btn.disabled = true;
      btn.style.cursor = "progress";
      btn.innerHTML = '<span class="wb-po-spin" style="pointer-events:none;display:inline-block;width:14px;height:14px;border:2px solid ' + C.line + ';border-top-color:' + C.accent + ';border-radius:50%;animation:wbpo-spin .8s linear infinite"></span>';
    } else {
      btn.disabled = false;
      btn.style.cursor = "pointer";
      btn.innerHTML = '<span style="pointer-events:none">✨</span>';
    }
  }

  // 面板的悬停/控件细节用一条 style 承载（都限定在 #wb-prompt-opt-panel 内，不影响 WorkBuddy 自身）。
  // 注意：重复注入时必须「覆盖重写」而不是「存在即返回」，否则升级后页面还留着旧样式。
  function ensureSpinCss() {
    var st = document.getElementById("wb-prompt-opt-style");
    if (!st) {
      st = document.createElement("style");
      st.id = "wb-prompt-opt-style";
      document.head.appendChild(st);
    }
    st.textContent = [
      "@keyframes wbpo-spin{to{transform:rotate(360deg)}}",
      // 浅色面板：让原生下拉/滚动条也走浅色
      "#wb-prompt-opt-panel{color-scheme:light}",
      "#wb-prompt-opt-panel input::placeholder,#wb-prompt-opt-panel textarea::placeholder{color:#a8adb6}",
      "#wb-prompt-opt-panel input:focus,#wb-prompt-opt-panel textarea:focus,#wb-prompt-opt-panel select:focus{border-color:" + C.accent + ";box-shadow:0 0 0 3px rgba(108,92,231,.14)}",
      "#wb-prompt-opt-panel button:not(:disabled):hover{filter:brightness(.96)}",
      "#wb-prompt-opt-panel [data-po=\"test\"]:not(:disabled):hover{background:" + C.hover + ";filter:none}",
      "#wb-prompt-opt-panel [data-po=\"clear\"]:not(:disabled):hover,"
        + "#wb-prompt-opt-panel [data-po=\"promptReset\"]:not(:disabled):hover,"
        + "#wb-prompt-opt-panel [data-po=\"keyToggle\"]:not(:disabled):hover{color:" + C.text + "}",
      "#wb-prompt-opt-panel::-webkit-scrollbar{width:8px}",
      "#wb-prompt-opt-panel::-webkit-scrollbar-thumb{background:#d9dce1;border-radius:4px}"
    ].join("");
  }

  // ---------- 状态 ----------
  // restored: 上一次优化前的原文（点击按钮可还原）；optimizing: 请求进行中
  var state = { restored: null, optimizing: false };
  window[STATE_KEY] = state;

  async function onClick() {
    if (state.optimizing) return;
    // 有可还原内容 → 先还原
    if (state.restored !== null) {
      var ed0 = findEditor();
      if (!ed0) { toast("找不到输入框"); return; }
      var back = state.restored;
      state.restored = null;
      if (writeText(ed0, back)) {
        toast("已还原为优化前草稿");
      } else {
        toast("还原写入失败，请手动粘贴");
      }
      return;
    }
    var ed = findEditor();
    if (!ed) { toast("找不到输入框（可能切换了页面）"); return; }
    var draft = readDraft(ed);
    if (!draft) { toast("输入框是空的，先写点草稿再点 ✨"); return; }

    state.optimizing = true;
    setBusy(true);
    try {
      var res = await fetch(PROXY + "/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      var optimized = String(data.optimized || "").trim();
      if (!optimized) throw new Error("LLM 返回为空");
      if (writeText(ed, optimized)) {
        state.restored = draft; // 再点一次按钮即可还原
        toast("已写回优化结果 · 再点 ✨ 可还原", 3000);
      } else {
        throw new Error("写回编辑器失败");
      }
    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      if (/Failed to fetch|NetworkError/i.test(msg)) {
        msg = "连不上本地代理(127.0.0.1:9477)，请先运行 proxy.mjs";
      }
      toast("优化失败：" + msg, 4000);
    } finally {
      state.optimizing = false;
      setBusy(false);
    }
  }

  // ---------- 配置面板（在 ✨ 按钮上点右键打开） ----------
  // 面板只跟本地代理通信：读配置（含已保存的密钥，仅走本机 127.0.0.1）/ 保存配置 / 试连一次。
  // apiKey 由代理写入 config.json，不进渲染页面的持久存储。
  var PANEL_ID = "wb-prompt-opt-panel";
  var panelRefs = null;
  var outsideBound = false;

  // 配色与 WorkBuddy 的浅色界面一致（白底深字），集中在这里，便于统一调整。
  var C = {
    bg: "#ffffff",
    text: "#1f2329",
    sub: "#5f6672",
    faint: "#8a9099",
    line: "#e6e8ec",
    divider: "#eef0f3",
    inputBg: "#ffffff",
    inputLine: "#d9dce1",
    hover: "#f4f5f8",
    accent: "#6c5ce7"
  };

  var INPUT_CSS = [
    "width:100%", "box-sizing:border-box", "padding:6px 8px", "border-radius:8px",
    "border:1px solid " + C.inputLine, "background:" + C.inputBg, "color:" + C.text,
    "font-size:12.5px", "font-family:inherit", "outline:none", "line-height:1.4"
  ].join(";");

  function cfgEl(tag, css, props) {
    var node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (props) {
      Object.keys(props).forEach(function (k) {
        // 部分属性（如 select.type）是只读 getter，赋值会抛错，降级为 setAttribute
        try { node[k] = props[k]; } catch (e) { try { node.setAttribute(k, props[k]); } catch (e2) {} }
      });
    }
    return node;
  }

  function cfgRow(labelText) {
    var row = cfgEl("div", "display:flex;align-items:center;gap:8px;margin-bottom:8px");
    row.appendChild(cfgEl("div", "flex:0 0 64px;font-size:12px;color:" + C.sub, { textContent: labelText }));
    return row;
  }

  function cfgOption(select, value, label) {
    var op = cfgEl("option", "background:" + C.bg + ";color:" + C.text, { value: value, textContent: label });
    select.appendChild(op);
    return op;
  }

  function applyProtocolHint() {
    if (!panelRefs) return;
    var v = panelRefs.protocol.value;
    panelRefs.baseUrl.placeholder =
      v === "anthropic" ? "https://api.anthropic.com" : v === "mock" ? "mock 不需要服务地址" : "https://api.openai.com/v1";
    panelRefs.model.placeholder =
      v === "anthropic" ? "claude-3-5-sonnet-latest" : v === "mock" ? "mock 不使用模型" : "gpt-4o-mini";
  }

  function buildPanel() {
    var p = cfgEl("div", [
      "position:fixed", "z-index:2147483200", "width:440px", "box-sizing:border-box",
      "padding:14px", "border-radius:12px", "background:" + C.bg, "color:" + C.text,
      "border:1px solid " + C.line, "box-shadow:0 10px 34px rgba(16,24,40,.14), 0 2px 8px rgba(16,24,40,.06)",
      "font-size:12.5px", "font-family:inherit", "line-height:1.5", "visibility:hidden",
      "max-height:calc(100vh - 24px)", "overflow-y:auto", "overscroll-behavior:contain"
    ].join(";"));
    p.id = PANEL_ID;

    var head = cfgEl("div", "display:flex;align-items:center;justify-content:space-between;margin-bottom:10px");
    head.appendChild(cfgEl("div", "font-size:13px;font-weight:600", { textContent: "✨ 提示词优化设置" }));
    var close = cfgEl("button", "border:none;background:transparent;color:" + C.faint + ";font-size:14px;cursor:pointer;padding:2px 4px;line-height:1", { type: "button", textContent: "✕" });
    close.addEventListener("click", closeConfig);
    head.appendChild(close);
    p.appendChild(head);

    var refs = {};

    var r1 = cfgRow("服务类型");
    refs.protocol = cfgEl("select", INPUT_CSS);
    cfgOption(refs.protocol, "openai", "OpenAI 兼容（DeepSeek / 通义 / 智谱等）");
    cfgOption(refs.protocol, "anthropic", "Anthropic Claude");
    cfgOption(refs.protocol, "mock", "mock 本地回显（无需密钥，自测用）");
    r1.appendChild(refs.protocol);
    p.appendChild(r1);

    var r2 = cfgRow("服务地址");
    refs.baseUrl = cfgEl("input", INPUT_CSS, { type: "text", spellcheck: false, placeholder: "https://api.openai.com/v1" });
    r2.appendChild(refs.baseUrl);
    p.appendChild(r2);

    var r3 = cfgRow("模型");
    refs.model = cfgEl("input", INPUT_CSS, { type: "text", spellcheck: false, placeholder: "gpt-4o-mini" });
    r3.appendChild(refs.model);
    p.appendChild(r3);

    var r4 = cfgRow("API Key");
    // 默认隐藏：type=password 打成圆点；已保存的密钥仍然自动填入，打开就能直接保存。
    // 需要核对时点右侧「显示」临时揭开，关闭面板即随 DOM 一起销毁。
    var keyWrap = cfgEl("div", "flex:1;min-width:0;display:flex;align-items:center;gap:6px");
    refs.apiKey = cfgEl("input", INPUT_CSS + ";flex:1 1 0;min-width:0", { type: "password", spellcheck: false, placeholder: "粘贴你的 API Key" });
    refs.apiKey.setAttribute("autocomplete", "off");
    refs.keyToggle = cfgEl("button", "flex:0 0 auto;border:none;background:transparent;color:" + C.faint + ";font-size:11.5px;cursor:pointer;padding:2px 0;text-decoration:underline", { type: "button", textContent: "显示" });
    keyWrap.appendChild(refs.apiKey);
    keyWrap.appendChild(refs.keyToggle);
    r4.appendChild(keyWrap);
    p.appendChild(r4);

    var r5 = cfgRow("输出风格");
    refs.style = cfgEl("select", INPUT_CSS);
    cfgOption(refs.style, "structured", "结构化（目标 / 要求 / 输出格式）");
    cfgOption(refs.style, "concise", "精炼一段式");
    r5.appendChild(refs.style);
    p.appendChild(r5);

    // ---- 系统提示词：与 prompt-optimize skill 一致，可查看/编辑 ----
    var pBlock = cfgEl("div", "margin-top:12px;padding-top:11px;border-top:1px solid " + C.divider);
    var pHead = cfgEl("div", "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px");
    pHead.appendChild(cfgEl("div", "font-size:12px;color:" + C.sub, { textContent: "系统提示词（发给大模型的优化指令）" }));
    refs.promptReset = cfgEl("button", "border:none;background:transparent;color:" + C.faint + ";font-size:11.5px;cursor:pointer;padding:2px 0;text-decoration:underline", { type: "button", textContent: "恢复默认" });
    pHead.appendChild(refs.promptReset);
    pBlock.appendChild(pHead);

    refs.prompt = cfgEl("textarea", [
      "width:100%", "box-sizing:border-box", "height:168px", "resize:vertical",
      "padding:8px 9px", "border-radius:8px", "border:1px solid " + C.inputLine,
      "background:" + C.inputBg, "color:" + C.text, "font-size:11.5px",
      "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
      "line-height:1.45", "outline:none", "white-space:pre-wrap", "tab-size:2"
    ].join(";"), { spellcheck: false, wrap: "soft", placeholder: "留空则使用内置默认提示词（与 prompt-optimize skill 一致）" });
    refs.prompt.setAttribute("autocomplete", "off");
    pBlock.appendChild(refs.prompt);

    refs.promptHint = cfgEl("div", "margin-top:5px;font-size:11.5px;color:" + C.faint, { textContent: "" });
    pBlock.appendChild(refs.promptHint);
    p.appendChild(pBlock);

    var actions = cfgEl("div", "display:flex;align-items:center;gap:8px;margin-top:12px");
    refs.save = cfgEl("button", "border:none;border-radius:8px;padding:7px 14px;background:" + C.accent + ";color:#fff;font-size:12.5px;font-weight:600;cursor:pointer", { type: "button", textContent: "保存" });
    refs.test = cfgEl("button", "border:1px solid " + C.inputLine + ";border-radius:8px;padding:6px 12px;background:" + C.bg + ";color:" + C.text + ";font-size:12.5px;cursor:pointer", { type: "button", textContent: "测试连接" });
    refs.clear = cfgEl("button", "margin-left:auto;border:none;background:transparent;color:" + C.faint + ";font-size:11.5px;cursor:pointer;padding:2px 0;text-decoration:underline", { type: "button", textContent: "清除密钥" });
    actions.appendChild(refs.save);
    actions.appendChild(refs.test);
    actions.appendChild(refs.clear);
    p.appendChild(actions);

    refs.saveHint = cfgEl("div", "margin-top:7px;font-size:11px;color:" + C.faint, {
      textContent: "「保存」会一并完成一键启动：写入开机自启并拉起守护进程，之后打开 WorkBuddy 无需任何操作。"
    });
    p.appendChild(refs.saveHint);

    refs.status = cfgEl("div", "margin-top:9px;font-size:11.5px;color:" + C.sub + ";white-space:pre-wrap;word-break:break-all", { textContent: "" });
    p.appendChild(refs.status);

    refs.save.addEventListener("click", saveConfigFromPanel);
    refs.test.addEventListener("click", testConfigFromPanel);
    refs.clear.addEventListener("click", clearKeyFromPanel);
    refs.promptReset.addEventListener("click", resetPromptFromPanel);
    // 「显示 / 隐藏」只切换输入框的 type，不碰里面的值
    refs.keyToggle.addEventListener("click", function () {
      if (!panelRefs) return;
      var reveal = panelRefs.apiKey.type === "password";
      panelRefs.apiKey.type = reveal ? "text" : "password";
      panelRefs.keyToggle.textContent = reveal ? "隐藏" : "显示";
    });
    refs.protocol.addEventListener("change", applyProtocolHint);
    refs.style.addEventListener("change", function () {
      // 未自定义提示词时，风格变化会体现在提示词正文里，给个提示
      if (panelRefs && panelRefs.promptHint && !panelRefs.promptCustom) {
        panelRefs.promptHint.textContent = "已切换输出风格，点「保存」后提示词正文同步更新";
      }
    });

    // 面板内按键不要冒泡到 WorkBuddy 的全局快捷键（Esc / Enter 等）
    p.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); closeConfig(); }
    });
    p.addEventListener("keyup", function (e) { e.stopPropagation(); });
    p.addEventListener("keypress", function (e) { e.stopPropagation(); });
    p.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    p.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    p.addEventListener("click", function (e) { e.stopPropagation(); });

    // 给每个字段打标记，便于调试与自动化验证
    Object.keys(refs).forEach(function (k) {
      if (refs[k] && refs[k].setAttribute) refs[k].setAttribute("data-po", k);
    });

    panelRefs = refs;
    return p;
  }

  function placePanel() {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var W = p.offsetWidth || 440;
    var H = p.offsetHeight || 300;
    var m = 12;
    var left, top;
    var btn = document.getElementById(BTN_ID);
    if (btn) {
      var r = btn.getBoundingClientRect();
      left = r.right - W;
      top = r.top - H - 10;
    } else {
      left = innerWidth - W - m;
      top = innerHeight - H - 140;
    }
    left = Math.max(m, Math.min(innerWidth - W - m, left));
    top = Math.max(m, Math.min(innerHeight - H - m, top));
    p.style.left = Math.round(left) + "px";
    p.style.top = Math.round(top) + "px";
  }

  function onDocPointerDown(event) {
    var p = document.getElementById(PANEL_ID);
    if (!p) return;
    var t = event.target;
    if (p.contains(t)) return;
    if (t && t.closest && t.closest("#" + BTN_ID)) return;
    closeConfig();
  }
  function bindOutside() {
    if (outsideBound) return;
    outsideBound = true;
    document.addEventListener("pointerdown", onDocPointerDown, true);
  }
  function unbindOutside() {
    if (!outsideBound) return;
    outsideBound = false;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
  }

  function toggleConfig() {
    if (document.getElementById(PANEL_ID)) closeConfig();
    else openConfig();
  }

  async function openConfig() {
    try {
      var p = document.getElementById(PANEL_ID);
      if (!p) {
        p = buildPanel();
        document.body.appendChild(p);
      }
      p.style.visibility = "hidden";
      placePanel();
      p.style.visibility = "visible";
      applyProtocolHint();
      bindOutside();
      await loadConfigIntoPanel();
      placePanel();
    } catch (err) {
      state.lastConfigError = String(err && err.stack ? err.stack : err);
      toast("打开设置面板失败：" + errText(err), 4000);
      throw err;
    }
  }

  function closeConfig() {
    var p = document.getElementById(PANEL_ID);
    if (p) { try { p.remove(); } catch (e) {} }
    panelRefs = null;
    unbindOutside();
  }

  function fillPanel(c) {
    if (!panelRefs || !c) return;
    panelRefs.protocol.value = c.protocol || "openai";
    panelRefs.baseUrl.value = c.baseUrl || "";
    panelRefs.model.value = c.model || "";
    panelRefs.style.value = c.style || "structured";
    // API Key：已保存的密钥照旧回填（不用重敲），但默认打码显示；每次打开都回到隐藏态
    panelRefs.apiKey.value = c.apiKey || "";
    panelRefs.apiKey.type = "password";
    panelRefs.keyToggle.textContent = "显示";
    panelRefs.apiKey.placeholder = c.apiKey
      ? (c.keyFromEnv ? "环境变量 PROMPT_OPT_KEY 优先，此处留空即可" : "已填入当前密钥（点「显示」可查看），清空后保存则不改动")
      : c.protocol === "mock"
        ? "mock 模式无需密钥"
        : "粘贴你的 API Key";
    // 系统提示词：直接展示当前生效的完整文本，便于查看与修改
    panelRefs.promptCustom = Boolean(c.promptCustom);
    panelRefs.prompt.value = c.prompt || "";
    panelRefs.promptHint.textContent = c.promptCustom
      ? "当前为自定义提示词（「输出风格」不再生效），共 " + (c.promptLength || 0) + " 字符"
      : "当前为内置默认提示词（与 prompt-optimize skill 一致），随「输出风格」自动调整；修改后以你填写的为准";
    applyProtocolHint();
  }

  function errText(err) {
    var msg = String(err && err.message ? err.message : err);
    if (/Failed to fetch|NetworkError/i.test(msg)) {
      return "连不上本地代理(127.0.0.1:9477)，请先运行“一键启动.bat”";
    }
    return msg;
  }

  async function postJson(path, body) {
    var res = await fetch(PROXY + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
    return data;
  }

  // /setup 专用：启动环节失败不抛错，好把「已保存 + 启动告警」拼成一条状态，
  // 保证「保存」本身的结果不受启动环节影响（原有保存逻辑不变）。
  async function postJsonSoft(path, body) {
    try {
      var res = await fetch(PROXY + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      });
      var data = await res.json().catch(function () { return null; });
      if (!data) return { ok: false, error: "HTTP " + res.status };
      return data;
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  function setPanelBusy(busy, msg) {
    if (!panelRefs) return;
    [panelRefs.save, panelRefs.test, panelRefs.clear, panelRefs.promptReset].forEach(function (b) {
      if (!b) return;
      b.disabled = busy;
      b.style.opacity = busy ? "0.6" : "1";
      b.style.cursor = busy ? "progress" : "pointer";
    });
    if (msg) panelRefs.status.textContent = msg;
  }

  function panelOverride() {
    var o = {
      protocol: panelRefs.protocol.value,
      baseUrl: panelRefs.baseUrl.value.trim(),
      model: panelRefs.model.value.trim(),
      style: panelRefs.style.value,
      prompt: panelRefs.prompt.value
    };
    var k = panelRefs.apiKey.value.trim();
    if (k) o.apiKey = k;
    return o;
  }

  async function loadConfigIntoPanel() {
    if (!panelRefs) return;
    try {
      var res = await fetch(PROXY + "/config");
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
      fillPanel(data.config);
      panelRefs.status.textContent = "";
    } catch (err) {
      panelRefs.status.textContent = "❌ 读取配置失败：" + errText(err);
    }
  }

  // 「保存」= 保存配置 + 一键启动（装开机自启 + 拉起守护进程）。
  // 两步串行、互不干扰：保存失败就整体失败；保存成功但启动有问题，只降级为告警。
  async function saveConfigFromPanel() {
    if (!panelRefs) return;
    setPanelBusy(true, "保存并启动中…");
    try {
      var data = await postJson("/config", panelOverride());
      fillPanel(data.config);
      var boot = await postJsonSoft("/setup", {});
      if (boot && boot.ok) {
        panelRefs.status.textContent =
          "✅ 已保存并生效；开机自启已就绪，守护进程" + (boot.watcherReused ? "运行中" : "已启动") +
          "（pid " + boot.watcher + "）。以后打开 WorkBuddy 全自动，无需再运行任何文件。";
        toast("已保存，并完成了一键启动");
      } else {
        var why = (boot && (boot.error || (boot.notes || [])[0])) || "未知原因";
        panelRefs.status.textContent =
          "✅ 已保存并生效；⚠️ 一键启动未完成：" + why + "（可手动运行同目录下的「一键启动.bat」）";
        toast("设置已保存");
      }
    } catch (err) {
      panelRefs.status.textContent = "❌ 保存失败：" + errText(err);
    } finally {
      setPanelBusy(false);
    }
  }

  async function testConfigFromPanel() {
    if (!panelRefs) return;
    setPanelBusy(true, "测试中…（最长 90 秒）");
    try {
      var data = await postJson("/config/test", { config: panelOverride() });
      var preview = String(data.preview || "").replace(/\s+/g, " ").slice(0, 90);
      panelRefs.status.textContent =
        "✅ 连接成功（" + data.protocol + " / " + (data.model || "默认模型") + "）\n返回预览：" + preview;
    } catch (err) {
      panelRefs.status.textContent = "❌ 测试失败：" + errText(err);
    } finally {
      setPanelBusy(false);
    }
  }

  async function clearKeyFromPanel() {
    if (!panelRefs) return;
    setPanelBusy(true, "清除中…");
    try {
      var data = await postJson("/config", { apiKey: "__CLEAR__" });
      fillPanel(data.config);
      panelRefs.status.textContent = "✅ 已清除 config.json 中的密钥";
    } catch (err) {
      panelRefs.status.textContent = "❌ 清除失败：" + errText(err);
    } finally {
      setPanelBusy(false);
    }
  }

  // 恢复内置默认提示词（与 prompt-optimize skill 一致），立即落盘生效
  async function resetPromptFromPanel() {
    if (!panelRefs) return;
    setPanelBusy(true, "恢复默认提示词中…");
    try {
      var data = await postJson("/config", { prompt: "__DEFAULT__" });
      fillPanel(data.config);
      panelRefs.status.textContent = "✅ 已恢复内置默认提示词（与 prompt-optimize skill 一致）";
    } catch (err) {
      panelRefs.status.textContent = "❌ 恢复失败：" + errText(err);
    } finally {
      setPanelBusy(false);
    }
  }

  // 暴露给 CLI / 调试使用
  state.openConfig = openConfig;
  state.closeConfig = closeConfig;

  // ---------- 挂载 + 守护 ----------
  // 输入工具栏由 React 管理；按钮作为原生同级控件插在模型选择器与语音按钮之间。
  function mountButton() {
    var toolbar = document.querySelector(".cr-input-toolbar__right");
    if (!toolbar) return false;
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.isConnected && existing.parentNode === toolbar) return true;
    if (existing && existing.isConnected) { try { existing.remove(); } catch (e) {} }
    var btn = buildButton();
    var anchor = toolbar.querySelector(".cr-voice-trigger-tooltip") || toolbar.querySelector(".cr-voice-trigger");
    var send = toolbar.querySelector(".cr-input-toolbar__send");
    if (anchor) toolbar.insertBefore(btn, anchor);
    else if (send) toolbar.insertBefore(btn, send);
    else toolbar.appendChild(btn);
    return true;
  }

  ensureSpinCss();
  mountButton();
  var guard = setInterval(function () {
    try {
      var btn = document.getElementById(BTN_ID);
      if (!btn || !btn.isConnected || !btn.closest(".cr-input-toolbar__right")) mountButton();
    } catch (e) {}
  }, 1500);
  state.stopGuard = function () {
    clearInterval(guard);
    closeConfig();
  };

  return { installed: true, mounted: Boolean(document.getElementById(BTN_ID)) };
})()

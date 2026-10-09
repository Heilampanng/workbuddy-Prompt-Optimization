// readDraft 回归测试：从 ui.js 抽取真实实现，在合成 Slate 结构上验证草稿提取。
// 覆盖：占位符剔除、多行保留、同段内联格式、空行保留、空草稿。
// 不依赖窗口可见性（纯 DOM 计算），可随时运行：node test-draft.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9334;

const uiSrc = await readFile(join(HERE, "inject", "ui.js"), "utf8");
const startMark = "var PLACEHOLDER_RE = /今天帮你做些什么";
const endMark = "// 写回文本：全选 + insertText";
const s = uiSrc.indexOf(startMark);
const e = uiSrc.indexOf(endMark);
if (s < 0 || e < 0 || e <= s) {
  console.error("无法从 ui.js 抽取 readDraft 源码：", { s, e });
  process.exit(1);
}
const snippet = uiSrc.slice(s, e);
console.log("已从 ui.js 抽取 " + snippet.length + " 字符的 readDraft 实现\n");

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    };
    const send = (method, params = {}) => new Promise((res, rej) => {
      const rid = ++id;
      const timer = setTimeout(() => { pending.delete(rid); rej(new Error(method + " 超时")); }, 15000);
      pending.set(rid, { resolve: res, reject: rej, timer });
      ws.send(JSON.stringify({ id: rid, method, params }));
    });
    ws.onopen = () => resolve({ ws, send });
    ws.onerror = () => reject(new Error("CDP WebSocket 连接失败"));
  });
}

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const cands = targets.filter((t) => t.type === "page" && String(t.url || "").includes("renderer/index.html"));
let target = null;
for (const c of cands) {
  const { ws, send } = await connect(c.webSocketDebuggerUrl);
  await send("Runtime.enable");
  const r = await send("Runtime.evaluate", { expression: `Boolean(document.querySelector(".cr-input-editor-host [contenteditable='true'][role='textbox']"))`, returnByValue: true });
  ws.close();
  if (r.result.value) { target = c; break; }
}
if (!target) { console.error("找不到含输入框的 renderer 页面"); process.exit(1); }

const { ws, send } = await connect(target.webSocketDebuggerUrl);
await send("Runtime.enable");
const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

const results = await evalIn(`(() => {
${snippet}
  var P = 'data-slate-node="element"';
  var T = 'data-slate-node="text"';
  function make(html) {
    var d = document.createElement("div");
    d.setAttribute("data-slate-editor", "true");
    d.setAttribute("data-slate-node", "value");
    d.setAttribute("contenteditable", "true");
    d.innerHTML = html;
    return d;
  }
  function p(inner) { return '<p ' + P + '>' + inner + '</p>'; }
  function t(txt) { return '<span ' + T + '><span data-slate-leaf="true">' + txt + '</span></span>'; }
  function emptyLeaf() { return '<span ' + T + '><span data-slate-leaf="true" data-cb-empty-leaf="true"><span data-slate-zero-width="n" data-slate-length="0"></span><span data-slate-placeholder="true">今天帮你做些什么？@ 添加上下文，/调用技能与指令</span></span></span>'; }

  var cases = [];
  function run(name, ed, want) { cases.push({ name: name, got: readDraft(ed), want: want, pass: readDraft(ed) === want }); }

  run("单行正文+占位段", make(p(t("请帮我整理一个项目计划")) + p(emptyLeaf())), "请帮我整理一个项目计划");
  run("两行正文", make(p(t("第一行草稿")) + p(t("第二行草稿"))), "第一行草稿\\n第二行草稿");
  run("同段内联格式", make('<p ' + P + '><span ' + T + '><span data-slate-leaf="true">加粗</span></span><span ' + T + '><span data-slate-leaf="true">与普通</span></span></p>'), "加粗与普通");
  run("中间空段", make(p(t("甲")) + p(emptyLeaf()) + p(t("乙"))), "甲\\n\\n乙");
  run("仅占位符（无草稿）", make(p(emptyLeaf())), "");
  run("三行正文", make(p(t("A")) + p(t("B")) + p(t("C"))), "A\\nB\\nC");
  run("正文含换行 + 尾部占位段", make(p(t("第一行")) + p(t("第二行")) + p(emptyLeaf())), "第一行\\n第二行");

  return { allPass: cases.every(function (c) { return c.pass; }), cases: cases };
})()`);

console.log(JSON.stringify(results, null, 2));
ws.close();
if (!results.allPass) process.exitCode = 1;

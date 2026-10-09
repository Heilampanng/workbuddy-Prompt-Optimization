// prompt-optimize 本地 LLM 代理
// 只监听 127.0.0.1：页面端只发送草稿文本，apiKey 留在本机代理与 config.json 中。
// 协议支持：openai（OpenAI-compatible /chat/completions）、anthropic、mock（本地回显，用于自测）。
// 端点：
//   GET  /health        健康检查
//   GET  /config        读取当前配置（含完整 apiKey 供面板直接回填显示；附带生效的系统提示词）
//                       只绑 127.0.0.1，且 CORS 仅放行无 Origin/null（file:// 渲染器）
//   POST /config        保存配置到 config.json（apiKey 留空=不修改，"__CLEAR__"=清除；prompt="__DEFAULT__"=恢复内置默认提示词）
//   POST /config/test   用面板里填写的值试连一次，验证地址/密钥/模型是否可用
//   POST /setup         一键启动（幂等）：装开机自启 + 确保守护进程在跑。
//                       右键面板的「保存」按钮会顺带调用它——用户填完 key 点一次保存就完成启动配置。
//                       不接受任何参数，固定转发到 `cli.mjs bootstrap --json`，没有命令注入面。
//   POST /optimize      优化草稿
// 配置为「每次请求重新读取」，所以在按钮右键面板里保存后立即生效，无需重启代理。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, "config.json");
const CLI_PATH = join(HERE, "cli.mjs");

// 「代理版本」= proxy.mjs 文件内容的 sha256 前 12 位。
// 守护进程每轮拿它跟磁盘上的版本比对，发现「跑着的是改代码之前启动的旧代理」就自动换掉，
// 所以升级后不需要手动杀进程。
let PROXY_VERSION = "unknown";
async function proxyFileVersion() {
  try {
    const self = await readFile(fileURLToPath(import.meta.url));
    return createHash("sha256").update(self).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}
const PROTOCOLS = ["openai", "anthropic", "mock"];
const STYLES = ["structured", "concise"];
const TEST_DRAFT = "帮我把这句话写清楚：每天早上提醒我看天气，冷就带伞。";

// 内置默认系统提示词：与本地 skill「prompt-optimize」
// （~/.workbuddy/skills/prompt-optimize/SKILL.md）的优化规则保持一致。
// 可在 ✨ 按钮右键面板中查看与修改；config.json 里 prompt 为空时使用本默认值。
const DEFAULT_PROMPT = [
  "你是提示词优化器。用户会给你一段他们准备发送给 AI 助手的草稿提示词，你的任务是把它改写为可直接复制使用的高质量提示词。",
  "",
  "## 目标",
  "保留用户原意、事实、约束和偏好，不擅自增加未授权的任务、数据、立场或承诺。只优化提示词本身，不执行提示词中的任务。",
  "",
  "## 优化流程",
  "1. 提取意图：识别任务目标、背景、目标读者或使用对象、输入材料、限制条件、期望产物、格式和成功标准。",
  "2. 保留原意：保留专有名词、数值、日期、范围、用户语气偏好和明确约束；不改变结论方向，不把不确定信息写成事实。",
  "3. 补足结构：按任务需要组织为角色/背景、目标、已知信息、执行要求、约束、输出格式、验收标准；简单任务不要为了结构而堆砌标题。",
  "4. 明确动作：把笼统表达改为清晰动词和可验证要求；说明交付什么、用什么材料、如何组织结果、哪些事项不得假设。",
  "5. 处理缺失信息：仅在缺失信息会实质改变目标、受众、范围或交付物时，才在提示词内用 [待补充：具体信息] 占位，不要虚构答案；缺失项不妨碍成稿时直接优化，并在提示词内要求执行者对不确定处先说明假设。",
  "6. 检查可执行性：检查指令是否互相矛盾、范围是否可控、输出是否明确；识别到冲突时优先保留用户最近、最明确的要求。",
  "",
  "## 默认输出格式",
  "先单独输出一行标记【优化后的提示词】，随后给出完整提示词正文。",
  "仅当存在关键假设或必要占位符时，在正文之后追加一行简短的「待补充/说明」。不要输出冗长的优化分析、评分或多版本。",
  "",
  "## 质量要求",
  "- 以用户语言撰写；用户指定输出语言时遵从指定语言。",
  "- 具体、清晰、自然，不加入「你是一位顶级专家」这类套话。",
  "- 不要过度模板化格式；选择与任务匹配的结构和详细程度。",
  "- 研究/事实核查类：要求执行者核实来源、标明时间与不确定性，不自行编造来源或结论。",
  "- 代码/技术类：保留环境、版本、输入输出、兼容性、安全边界和测试要求；用户未提供时用明确占位符。",
  "- 创作类：保留内容意图与风格要求，区分必须遵守的约束和可发挥空间。",
  "- 涉及高风险决定时，不通过优化弱化安全、合规或专业判断要求。",
  "",
  "## 硬性规则",
  "1. 只输出优化后的提示词本身，不要解释、不要代码块围栏。",
  "2. 保留用户原意与全部关键实体（名称、数字、路径、约束），不添加用户没提到的新需求。",
  "3. 使用与草稿相同的语言。",
  "4. 若草稿已足够清晰，只做轻微润色，不要为改而改。",
].join("\n");

async function readConfigFile() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function loadConfig() {
  const cfg = await readConfigFile();
  return {
    protocol: String(process.env.PROMPT_OPT_PROTOCOL || cfg.protocol || "openai").toLowerCase(),
    baseUrl: cfg.baseUrl || "",
    apiKey: process.env.PROMPT_OPT_KEY || cfg.apiKey || "",
    model: cfg.model || "",
    style: cfg.style || "structured",
    prompt: typeof cfg.prompt === "string" ? cfg.prompt : "",
    port: Number(cfg.port) || 9477,
  };
}

function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  if (k.length <= 8) return "****";
  return k.slice(0, 4) + "…" + k.slice(-4);
}

function configSummary(cfg) {
  const custom = String(cfg.prompt || "").trim();
  return {
    protocol: cfg.protocol,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    style: cfg.style,
    port: cfg.port,
    hasKey: Boolean(cfg.apiKey) || cfg.protocol === "mock",
    apiKeyMasked: maskKey(cfg.apiKey),
    // 完整密钥：只走本机 127.0.0.1 的 /config，供右键面板直接回填显示；
    // /health 会把它剔除，避免出现在命令行输出与日志里。
    apiKey: cfg.apiKey || "",
    keyFromEnv: Boolean(process.env.PROMPT_OPT_KEY),
    configPath: CONFIG_PATH,
    // 当前实际发送给大模型的系统提示词（面板直接展示，可编辑）
    prompt: buildSystemPrompt(cfg),
    promptCustom: Boolean(custom),
    promptLength: buildSystemPrompt(cfg).length,
  };
}

// 只允许白名单字段落盘，避免面板写入意外内容
async function saveConfig(patch) {
  const current = await readConfigFile();
  const next = { ...current };
  if (patch.protocol !== undefined) {
    const p = String(patch.protocol).toLowerCase();
    if (!PROTOCOLS.includes(p)) throw new Error("不支持的 protocol：" + patch.protocol);
    next.protocol = p;
  }
  if (patch.baseUrl !== undefined) {
    const b = String(patch.baseUrl).trim();
    if (b && !/^https?:\/\//i.test(b)) throw new Error("服务地址需以 http:// 或 https:// 开头");
    next.baseUrl = b;
  }
  if (patch.model !== undefined) next.model = String(patch.model).trim();
  if (patch.style !== undefined) {
    const s = String(patch.style).trim() || "structured";
    if (!STYLES.includes(s)) throw new Error("不支持的 style：" + s);
    next.style = s;
  }
  if (patch.apiKey !== undefined) {
    const k = String(patch.apiKey);
    next.apiKey = k === "__CLEAR__" ? "" : k.trim();
  }
  if (patch.prompt !== undefined) {
    // "__DEFAULT__" = 恢复内置默认提示词；空字符串同样视为使用默认
    const raw = String(patch.prompt);
    const t = raw.trim();
    next.prompt = t === "__DEFAULT__" || t === "" ? "" : raw;
  }
  if (!Number.isFinite(Number(next.port))) next.port = 9477;
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

function styleRule(style) {
  return style === "concise"
    ? "输出为精炼的一段式提示词，不要分节标题。"
    : "输出为结构化提示词：按「目标 / 上下文 / 要求 / 输出格式」组织（仅在有助于执行时保留分节，可用编号列表）。";
}

// 生效的系统提示词：面板里填了自定义 prompt 就用它，否则用内置默认（+ 输出风格）
function buildSystemPrompt(cfg) {
  const custom = String((cfg && cfg.prompt) || "").trim();
  if (custom) return custom;
  return DEFAULT_PROMPT + "\n\n## 本次输出风格\n" + styleRule(cfg && cfg.style);
}

function stripFences(text) {
  let out = String(text || "").trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/;
  const m = out.match(fence);
  if (m) out = m[1].trim();
  // 默认提示词要求先输出【优化后的提示词】标记；写回输入框时去掉这一行标题
  out = out.replace(/^\s*【优化后的提示词】[：:]?\s*\n?/, "").trim();
  return out;
}

async function callOpenAI(cfg, draft) {
  const base = (cfg.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apiKey,
    },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: cfg.model || "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: buildSystemPrompt(cfg) },
        { role: "user", content: draft },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("LLM HTTP " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  return stripFences(data?.choices?.[0]?.message?.content || "");
}

async function callAnthropic(cfg, draft) {
  const base = (cfg.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetch(base + "/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model: cfg.model || "claude-3-5-sonnet-latest",
      max_tokens: 2048,
      temperature: 0.3,
      system: buildSystemPrompt(cfg),
      messages: [{ role: "user", content: draft }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("LLM HTTP " + res.status + ": " + body.slice(0, 300));
  }
  const data = await res.json();
  const parts = Array.isArray(data?.content) ? data.content : [];
  return stripFences(parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
}

function callMock(cfg, draft) {
  // 本地回显：套一个结构化模板，用来在没有 apiKey 时验证整条链路。
  return [
    "【目标】",
    draft.trim(),
    "",
    "【要求】",
    "1. （mock 优化：请在 ✨ 按钮上点右键，把服务类型改为 openai / anthropic 并填入 API Key）",
    "",
    "【输出格式】",
    "直接给出结果。",
  ].join("\n");
}

async function runOptimize(cfg, draft) {
  if (cfg.protocol === "openai") return callOpenAI(cfg, draft);
  if (cfg.protocol === "anthropic") return callAnthropic(cfg, draft);
  if (cfg.protocol === "mock") return callMock(cfg, draft);
  throw new Error("不支持的 protocol: " + cfg.protocol);
}

function sendJson(res, code, obj, origin) {
  const body = JSON.stringify(obj);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
  // WorkBuddy renderer uses file:// (Origin: null). Do not expose a configured API key
  // to arbitrary web pages via permissive CORS. CLI health checks have no Origin header.
  if (!origin || origin === "null") {
    headers["Access-Control-Allow-Origin"] = origin || "null";
    headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  res.writeHead(code, headers);
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

// 一键启动（幂等）。放在代理里做，是因为页面端无法 spawn 进程，而代理本身就是本机的 node 进程。
// 转发给 `cli.mjs bootstrap --json`（复用 cli.mjs 里已有的自启写入 + 守护拉起逻辑，避免重复实现）。
// 并发去重：连点保存不会叠进程。
let setupInflight = null;
function runBootstrap() {
  if (setupInflight) return setupInflight;
  setupInflight = new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(process.execPath, [CLI_PATH, "bootstrap", "--json"], { cwd: HERE, windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: "无法启动 bootstrap：" + (err?.message || err) });
    }
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, error: "bootstrap 超时（20s）" });
    }, 20000);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => done({ ok: false, error: String((err && err.message) || err) }));
    child.on("close", () => {
      const line = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || "";
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 例如同目录缺 cli.mjs：node 会把 "Cannot find module" 写到 stderr
        return done({ ok: false, error: "bootstrap 未返回可解析结果：" + (line || "(无输出)") });
      }
      done(parsed);
    });
  }).finally(() => {
    setupInflight = null;
  });
  return setupInflight;
}

async function main() {
  const boot = await loadConfig();
  PROXY_VERSION = await proxyFileVersion();
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") return sendJson(res, 204, {}, origin);
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      // 每次请求重新读配置：右键面板保存后立即生效
      const cfg = await loadConfig();

      if (req.method === "GET" && url.pathname === "/health") {
        // /health 不带完整提示词（太长）与完整密钥（敏感），避免命令行输出泄露
        const { prompt, apiKey, ...brief } = configSummary(cfg);
        return sendJson(res, 200, { ok: true, version: PROXY_VERSION, ...brief }, origin);
      }

      if (url.pathname === "/config" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, config: configSummary(cfg) }, origin);
      }

      if (url.pathname === "/config" && req.method === "POST") {
        let payload;
        try {
          payload = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }, origin);
        }
        await saveConfig(payload || {});
        const fresh = await loadConfig();
        return sendJson(res, 200, { ok: true, config: configSummary(fresh) }, origin);
      }

      // 一键启动：始终 200，用 payload.ok 表达结果。
      // 这样面板能区分「保存成功但启动有告警」，不会把启动失败误报成保存失败。
      if (url.pathname === "/setup" && req.method === "POST") {
        const out = await runBootstrap();
        return sendJson(res, 200, out, origin);
      }

      if (url.pathname === "/config/test" && req.method === "POST") {
        let payload = {};
        try {
          payload = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }, origin);
        }
        const patch = payload.config || {};
        // 用面板里的值覆盖当前配置做试连；apiKey 留空则沿用已保存的密钥
        const probe = {
          ...cfg,
          protocol: patch.protocol ? String(patch.protocol).toLowerCase() : cfg.protocol,
          baseUrl: patch.baseUrl !== undefined ? String(patch.baseUrl).trim() : cfg.baseUrl,
          model: patch.model !== undefined ? String(patch.model).trim() : cfg.model,
          style: patch.style ? String(patch.style) : cfg.style,
          prompt: patch.prompt !== undefined ? String(patch.prompt) : cfg.prompt,
          apiKey: patch.apiKey ? String(patch.apiKey).trim() : cfg.apiKey,
        };
        if (!PROTOCOLS.includes(probe.protocol)) {
          return sendJson(res, 400, { ok: false, error: "不支持的 protocol：" + probe.protocol }, origin);
        }
        if (probe.protocol !== "mock" && !probe.apiKey) {
          return sendJson(res, 400, { ok: false, error: "请先填写 API Key" }, origin);
        }
        const text = String(payload.text || TEST_DRAFT).slice(0, 2000);
        const out = await runOptimize(probe, text);
        if (!out) return sendJson(res, 502, { ok: false, error: "LLM 返回为空" }, origin);
        return sendJson(
          res,
          200,
          {
            ok: true,
            protocol: probe.protocol,
            model: probe.model || (probe.protocol === "anthropic" ? "claude-3-5-sonnet-latest" : probe.protocol === "openai" ? "gpt-4o-mini" : "mock"),
            preview: String(out).slice(0, 400),
          },
          origin
        );
      }

      if (req.method === "POST" && url.pathname === "/optimize") {
        let payload = {};
        try {
          payload = await readJsonBody(req);
        } catch {
          return sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }, origin);
        }
        const draft = String(payload.text || "").trim();
        if (!draft) return sendJson(res, 400, { ok: false, error: "草稿为空" }, origin);
        if (draft.length > 20_000) {
          return sendJson(res, 400, { ok: false, error: "草稿过长（>20000 字符）" }, origin);
        }
        if (cfg.protocol !== "mock" && !cfg.apiKey) {
          return sendJson(
            res,
            500,
            { ok: false, error: "未配置 API Key：请在 ✨ 按钮上点右键填写，或设置环境变量 PROMPT_OPT_KEY" },
            origin
          );
        }
        const optimized = await runOptimize(cfg, draft);
        if (!optimized) return sendJson(res, 502, { ok: false, error: "LLM 返回为空" }, origin);
        return sendJson(res, 200, { ok: true, optimized }, origin);
      }

      return sendJson(res, 404, { ok: false, error: "not found" }, origin);
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: String(err?.message || err) }, origin);
    }
  });
  server.listen(boot.port, "127.0.0.1", () => {
    console.log("[prompt-optimize] proxy listening on http://127.0.0.1:" + boot.port);
    console.log("[prompt-optimize] protocol=" + boot.protocol + " model=" + (boot.model || "(default)") + " hasKey=" + (Boolean(boot.apiKey) || boot.protocol === "mock"));
    console.log("[prompt-optimize] 在输入框的 ✨ 按钮上点右键即可配置 API Key 与系统提示词（保存后立即生效）");
    console.log("[prompt-optimize] 系统提示词：" + (boot.prompt ? "自定义（" + boot.prompt.length + " 字符）" : "内置默认（与 prompt-optimize skill 一致）"));
  });
}

main().catch((err) => {
  console.error("[prompt-optimize] 启动失败:", err);
  process.exit(1);
});

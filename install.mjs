#!/usr/bin/env node
/**
 * install.mjs —— prompt-optimize-button 零依赖安装器
 *
 * 设计约束：
 *   1. 仅使用 Node 内置模块（无 npm 依赖、无 git、无 unzip），保证「下载即用」；
 *   2. 从 GitHub 拉取发行包（zip）并自行解压（内置 deflate 解压器）；
 *   3. 覆盖安装时保留既有 config.json（API Key 等用户配置不丢失）；
 *   4. 安装后执行 cli.mjs setup，并对「代理 / 自启 / 守护 / CDP / 按钮」五项做实际校验；
 *   5. 提供 --json 供自动化（含 AI）解析，退出码 0 = 成功、1 = 失败。
 *
 * 用法：
 *   node install.mjs                      完整安装（下载 → 解压 → 安装 → 校验）
 *   node install.mjs --dir <路径>          指定安装目录
 *   node install.mjs --tag v1.0.1          指定版本（默认 v1.0.1，失败回退 main 分支）
 *   node install.mjs --no-setup            只下载解压，不执行安装动作
 *   node install.mjs --check               只校验现有安装（不下载）
 *   node install.mjs --uninstall           卸载（保留 config.json）
 *   node install.mjs --json                以 JSON 输出结果
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, normalize, sep } from "node:path";
import { homedir, tmpdir, platform } from "node:os";
import { inflateRawSync } from "node:zlib";

const OWNER = "Heilampanng";
const REPO = "workbuddy-Prompt-Optimization";
const DEFAULT_TAG = "v1.0.1";
const PROXY_PORT = 9477;
const CDP_PORTS = [9334, 9333];
const MIN_NODE_MAJOR = 18;
const REQUIRED_FILES = ["cli.mjs", "proxy.mjs", "inject/ui.js", "一键启动.bat", "一键卸载.bat"];

const STARTUP_VBS = join(
  process.env.APPDATA || "",
  "Microsoft", "Windows", "Start Menu", "Programs", "Startup",
  "prompt-optimize-watch.vbs"
);

const log = (s = "") => process.stdout.write(s + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const a = { dir: null, tag: DEFAULT_TAG, setup: true, check: false, uninstall: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dir" && argv[i + 1]) { a.dir = argv[i + 1]; i++; continue; }
    if (v === "--tag" && argv[i + 1]) { a.tag = argv[i + 1]; i++; continue; }
    if (v === "--no-setup") { a.setup = false; continue; }
    if (v === "--check") { a.check = true; continue; }
    if (v === "--uninstall") { a.uninstall = true; continue; }
    if (v === "--json") { a.json = true; continue; }
    if (v === "-h" || v === "--help") { a.help = true; continue; }
  }
  return a;
}

function defaultDir() {
  if (process.env.PROMPT_OPT_DIR) return process.env.PROMPT_OPT_DIR;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "prompt-optimize-button");
  }
  return join(homedir(), ".local", "share", "prompt-optimize-button");
}

// ---------------------------------------------------------------- zip 解压

/** 读取 zip 全部条目（支持 stored / deflate；GitHub 源码包为标准 deflate） */
function readZip(file) {
  const buf = readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("下载内容不是有效的 zip 包（未找到 EOCD 记录）");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;

    // 目录条目（GitHub 源码包会带 xxx/ 这样的项）：跳过。
    // 若当作零字节文件写出，后续为同名路径建目录会触发 EEXIST。
    if (name.endsWith("/")) continue;

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}：${name}`);

    if (uncompSize && content.length !== uncompSize) {
      throw new Error(`解压长度不符：${name}（期望 ${uncompSize}，实际 ${content.length}）`);
    }
    entries.push({ name, content });
  }
  return entries;
}

/** 路径安全：剥离顶层目录，拒绝绝对路径与 .. 逃逸 */
function safeRel(name) {
  const parts = name.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length) return null;
  parts.shift(); // 去掉 GitHub 源码包的顶层目录（仓库名-分支名）
  if (!parts.length) return null;
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return parts.join(sep);
}

// ---------------------------------------------------------------- 下载

/** 下载候选：优先真正的发行资产（含 RELEASE.json 清单），再退到源码归档 */
function downloadCandidates(tag) {
  const list = [];
  if (tag && tag !== "main") {
    list.push({
      label: `release/${tag}`,
      url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/prompt-optimize-button-${tag}.zip`,
    });
    list.push({ label: `tags/${tag}`, url: `https://codeload.github.com/${OWNER}/${REPO}/zip/refs/tags/${tag}` });
  }
  list.push({ label: "heads/main", url: `https://codeload.github.com/${OWNER}/${REPO}/zip/refs/heads/main` });
  return list;
}

async function downloadZip(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败：${url} → HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error("下载内容异常（小于 1 KB），可能被网络策略拦截");
  return bytes;
}

// ---------------------------------------------------------------- 子进程

function runNode(args, cwd) {
  return new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString("utf8"); });
    p.stderr.on("data", (d) => { err += d.toString("utf8"); });
    p.on("close", (code) => done({ code, out, err }));
  });
}

/** 把子进程输出实时打出来（安装过程需要可见） */
function runNodeLive(args, cwd) {
  return new Promise((done) => {
    const p = spawn(process.execPath, args, { cwd, stdio: "inherit", windowsHide: true });
    p.on("close", (code) => done(code ?? 0));
  });
}

// ---------------------------------------------------------------- 校验

async function probeProxy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function probeCdp() {
  for (const port of CDP_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return port;
    } catch { /* 试下一个 */ }
  }
  return null;
}

async function probeButton(dir) {
  // cli.mjs status 会遍历渲染页面，返回每个 target 的按钮挂载情况
  const r = await runNode(["cli.mjs", "status"], dir);
  const hits = (r.out.match(/"button":\s*true/g) || []).length;
  return hits > 0;
}

async function verify(dir) {
  const checks = { files: false, proxy: false, autostart: false, daemon: false, cdp: false, button: false };
  const detail = {};

  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(dir, f)));
  checks.files = missing.length === 0;
  detail.missingFiles = missing;

  // 代理可能刚被拉起，给 15 秒窗口
  for (let i = 0; i < 30; i++) {
    const h = await probeProxy();
    if (h) { checks.proxy = true; detail.proxy = { version: h.version, model: h.model, hasKey: h.hasKey }; break; }
    await sleep(500);
  }

  checks.autostart = existsSync(STARTUP_VBS);

  // 守护进程：优先看本目录的单实例锁；若锁不在本目录（例如复用旧目录拉起的守护），
  // 则以「代理已就绪」作为守护在工作的旁证，避免误报为未安装。
  let lockPid = 0, lockAlive = false;
  try {
    const lock = JSON.parse(readFileSync(join(dir, ".watch.lock"), "utf8"));
    lockPid = Number(lock?.pid || 0);
    lockAlive = lockPid > 0 && pidAlive(lockPid);
  } catch { /* 无锁文件 */ }
  checks.daemon = lockAlive || checks.proxy;
  detail.daemon = { lockPid, lockAlive, inferredFromProxy: !lockAlive && checks.proxy };
  const cdp = await probeCdp();
  checks.cdp = Boolean(cdp);
  detail.cdpPort = cdp || null;
  if (cdp) checks.button = await probeButton(dir);

  return { checks, detail };
}

// ---------------------------------------------------------------- 主流程

const USAGE = `
prompt-optimize-button 安装器

  node install.mjs                      完整安装（下载 → 解压 → 安装 → 校验）
  node install.mjs --dir <路径>          指定安装目录（默认 ${defaultDir()}）
  node install.mjs --tag <tag>           指定版本（默认 ${DEFAULT_TAG}，失败回退 main）
  node install.mjs --check               只校验现有安装，不下载
  node install.mjs --no-setup            只下载解压，不执行安装
  node install.mjs --uninstall           卸载（保留 config.json）
  node install.mjs --json                JSON 输出（供脚本/AI 解析）
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { log(USAGE); return 0; }

  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    log(`❌ Node.js 版本过低：当前 v${process.versions.node}，要求 >= ${MIN_NODE_MAJOR}。请先升级 Node.js。`);
    return 1;
  }

  const dir = resolve(args.dir || defaultDir());
  const result = { ok: false, dir, actions: [], checks: null, detail: {} };

  if (!args.json) {
    log("==================================================");
    log("  prompt-optimize-button 安装器");
    log("==================================================");
    log(`  目标目录：${dir}`);
    log(`  Node.js ：v${process.versions.node}（${platform()}）`);
    log("");
  }

  // ---- 1. 下载并解压 ----------------------------------------------------
  if (!args.check) {
    mkdirSync(dir, { recursive: true });

    // 保留既有 config.json
    const cfgPath = join(dir, "config.json");
    const hadConfig = existsSync(cfgPath);
    const savedConfig = hadConfig ? readFileSync(cfgPath) : null;

    let bytes = null, usedRef = null, lastErr = null;
    for (const cand of downloadCandidates(args.tag)) {
      try {
        if (!args.json) log(`[1/3] 下载发行包（${cand.label}）`);
        bytes = await downloadZip(cand.url);
        usedRef = cand.label;
        break;
      } catch (err) { lastErr = err; if (!args.json) log(`      该来源不可用：${err.message}`); }
    }
    if (!bytes) { log(`❌ 下载失败：${lastErr?.message || "未知原因"}`); return 1; }

    const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const zipPath = join(tmpdir(), `prompt-optimize-button-${Date.now()}.zip`);
    writeFileSync(zipPath, bytes);
    result.sha256_16 = sha;
    result.ref = usedRef;
    if (!args.json) log(`      ${(bytes.length / 1024).toFixed(1)} KB  sha256:${sha}`);

    let entries;
    try { entries = readZip(zipPath); }
    catch (err) { log(`❌ 解压失败：${err.message}`); return 1; }
    finally { try { rmSync(zipPath, { force: true }); } catch { /* 忽略 */ } }

    let written = 0;
    for (const e of entries) {
      const rel = safeRel(e.name);
      if (!rel) continue;
      const dest = join(dir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.content);
      written++;
    }
    result.filesWritten = written;
    if (!args.json) log(`[2/3] 解压完成，写入 ${written} 个文件`);

    if (hadConfig && savedConfig) {
      writeFileSync(cfgPath, savedConfig);
      if (!args.json) log("      已保留既有 config.json（API Key 与自定义提示词未改动）");
      result.configPreserved = true;
    }
    log("");
  } else {
    if (!existsSync(join(dir, "cli.mjs"))) { log(`❌ ${dir} 下未找到 cli.mjs，不是有效安装目录`); return 1; }
    if (!args.json) log("[跳过下载] 仅执行校验\n");
  }

  // ---- 2. 执行安装 ------------------------------------------------------
  if (!args.check && args.setup) {
    if (!args.json) log("[3/3] 执行安装（开机自启 + 守护进程 + 注入按钮）\n");
    const code = await runNodeLive(["cli.mjs", "setup"], dir);
    result.setupExitCode = code;
    result.actions.push("setup");
    if (code !== 0 && !args.json) log(`\n⚠️ cli.mjs setup 退出码 ${code}`);
    log("");
  }

  if (args.uninstall) {
    if (!args.json) log("[卸载] 关闭自启、移除按钮、停止守护与代理\n");
    const code = await runNodeLive(["cli.mjs", "uninstall"], dir);
    result.actions.push("uninstall");
    result.setupExitCode = code;
    log("");
  }

  // ---- 3. 校验 ----------------------------------------------------------
  const { checks, detail } = await verify(dir);
  result.checks = checks;
  result.detail = detail;

  if (args.json) {
    result.ok = checks.files && checks.proxy && checks.autostart && checks.daemon;
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return result.ok ? 0 : 1;
  }

  log("———— 安装校验 ————");
  mark(checks.files, `文件完整（${REQUIRED_FILES.length} 个关键文件）`, detail.missingFiles?.length ? "缺失：" + detail.missingFiles.join(", ") : "");
  mark(checks.proxy, `本地代理在线（127.0.0.1:${PROXY_PORT}）`, checks.proxy ? `model=${detail.proxy.model} hasKey=${detail.proxy.hasKey}` : "未响应，查看 .watch.log");
  mark(
    checks.autostart,
    "开机自启已写入（启动文件夹）",
    checks.autostart
      ? ""
      : "重新执行 node cli.mjs autostart on；若报 EPERM，说明安全策略禁止向启动文件夹写入脚本，改用手动启动（登录后运行一次 一键启动.bat）"
  );
  mark(
    checks.daemon,
    "守护进程运行中",
    checks.daemon
      ? (detail.daemon.lockAlive ? `pid ${detail.daemon.lockPid}` : "由另一安装目录的守护维持代理")
      : "无 .watch.lock 且代理未就绪，执行 node cli.mjs setup"
  );
  mark(checks.cdp, `WorkBuddy CDP 可达${checks.cdp ? "（端口 " + detail.cdpPort + "）" : ""}`, checks.cdp ? "" : "WorkBuddy 未运行；它启动后守护会自动注入");
  mark(checks.button, "✨ 按钮已挂载到输入框", checks.button ? "" : "打开 WorkBuddy 主窗口后由守护自动注入");

  const ok = checks.files && checks.proxy && checks.autostart && checks.daemon;
  log("");
  log(ok ? "✅ 安装完成：以后打开 WorkBuddy 即自动就绪，无需再运行任何文件。"
         : "❌ 安装未完成，请按上述提示处理（多数情况是 WorkBuddy 当前未运行）。");
  log("");
  log("使用入口：");
  log("  1. 输入框底部工具栏的 ✨ 按钮：左键优化草稿 / 右键打开设置面板");
  log("  2. 配置面板：填写服务地址、模型、API Key，保存即生效并自动完成自启");
  log(`  3. 命令行：node cli.mjs status | doctor | setup | uninstall（目录 ${dir}）`);
  log(`  4. 图形入口：${dir}\\一键启动.bat 与 一键卸载.bat`);
  return ok ? 0 : 1;
}

function mark(ok, label, hint = "") {
  log(`  ${ok ? "✅" : "❌"} ${label}${hint ? "  —— " + hint : ""}`);
}

const code = await main();
process.exit(code);

#!/usr/bin/env node
/**
 * build-release.mjs —— 构建可分发的发行包（zip）
 *
 * 特点：
 *   - 零第三方依赖：自行实现 zip 写入（deflate + CRC32），不依赖系统压缩工具；
 *   - 文件名统一按 UTF-8 写入并置 UTF-8 标志位（中文名 bat 在任意系统上都不乱码）；
 *   - 自动排除开发态与隐私相关文件（.git、config.json、运行时日志、既有压缩包）；
 *   - 在包内写入 RELEASE.json（版本、构建时间、源提交、文件清单与 sha256），便于校验完整性。
 *
 * 用法：
 *   node build-release.mjs            # 版本号取 package.json 或 VERSION 参数
 *   node build-release.mjs v1.2.0     # 指定版本
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, readdirSync, readFileSync, writeFileSync, statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip } from "./tools/zip-writer.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "dist");
const VERSION = process.argv[2] || readVersion();
const EXCLUDE_DIRS = new Set([".git", "dist", "node_modules", ".workbuddy"]);
const EXCLUDE_FILES = new Set([
  "config.json", "config.json.testbak", ".watch.lock", ".watch.log",
  "start-daemon.vbs", ".DS_Store",
]);

function readVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version || "0.0.0"; }
  catch { return "0.0.0"; }
}

// ---------------------------------------------------------------- 收集文件

function collect(dir, base, out) {
  for (const name of readdirSyncSorted(dir)) {
    const full = join(dir, name);
    const rel = relative(base, full).split(sep).join("/");
    const st = statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      collect(full, base, out);
      continue;
    }
    if (EXCLUDE_FILES.has(name) || name.endsWith(".zip")) continue;
    out.push({ name: rel, full, size: st.size, mtime: st.mtime });
  }
  return out;
}

function readdirSyncSorted(dir) { return readdirSync(dir).sort(); }

// ---------------------------------------------------------------- 主流程

const root = ROOT;
const files = collect(root, root, []);
const manifest = files.map((f) => ({
  path: f.name,
  size: f.size,
  sha256: createHash("sha256").update(readFileSync(f.full)).digest("hex").slice(0, 16),
}));

/** 取源提交号：优先 git 命令，失败则直接读 .git（不依赖 git 是否可用） */
function resolveCommit() {
  try {
    const c = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim();
    if (c) return c;
  } catch { /* git 不可用，走下面的解析 */ }
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref:\s*(.+)$/);
    const refPath = m ? join(root, ".git", m[1].trim()) : join(root, ".git", "HEAD");
    let sha = readFileSync(refPath, "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(m ? m[1].trim() : ""));
      sha = line ? line.split(" ")[0] : "";
    }
    return /^[0-9a-f]{7,}$/.test(sha) ? sha.slice(0, 7) : "unknown";
  } catch { return "unknown"; }
}

const commit = resolveCommit();

const release = {
  name: "prompt-optimize-button",
  version: VERSION,
  commit,
  builtAt: new Date().toISOString(),
  fileCount: files.length,
  files: manifest,
};
const releaseBuf = Buffer.from(JSON.stringify(release, null, 2), "utf8");

const entries = files.map((f) => ({
  name: `prompt-optimize-button-${VERSION}/${f.name}`,
  content: readFileSync(f.full),
  mtime: f.mtime,
}));
entries.push({
  name: `prompt-optimize-button-${VERSION}/RELEASE.json`,
  content: releaseBuf,
  mtime: new Date(),
});

const zip = buildZip(entries);
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `prompt-optimize-button-${VERSION}.zip`);
writeFileSync(outPath, zip);

const sha = createHash("sha256").update(zip).digest("hex");
console.log(`版本     : ${VERSION}（提交 ${commit}）`);
console.log(`文件数   : ${entries.length}（含 RELEASE.json）`);
console.log(`输出     : ${outPath}`);
console.log(`大小     : ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`sha256   : ${sha}`);
writeFileSync(join(OUT_DIR, `prompt-optimize-button-${VERSION}.zip.sha256`), sha + "\n");

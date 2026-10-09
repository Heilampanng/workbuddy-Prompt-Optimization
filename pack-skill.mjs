#!/usr/bin/env node
/**
 * pack-skill.mjs —— 把 skill/ 下的源码打成可提交到 WorkBuddy 开放平台的技能包
 *
 * 官方要求的包结构（zip 根目录即技能目录）：
 *   prompt-optimize-button/
 *     ├── SKILL.md          （必须，YAML frontmatter + Markdown 正文）
 *     ├── references/       （可选）
 *     └── scripts/          （可选）
 *
 * 本脚本额外做三件事：
 *   1. 校验 frontmatter 必填字段（description / description_zh / description_en / version / author）；
 *   2. 校验包体积不超过平台限制（3 MB）；
 *   3. 扫描疑似密钥（sk-、github_pat_ 等）并阻断打包 —— 技能包会被公开分发，绝不能带凭证。
 *
 * 用法：node pack-skill.mjs [版本号]
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip } from "./tools/zip-writer.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "skill", "prompt-optimize-button");
const SKILL_NAME = "prompt-optimize-button";
const OUT_DIR = join(ROOT, "dist");
const MAX_BYTES = 3 * 1024 * 1024;

const REQUIRED_FIELDS = ["description", "description_zh", "description_en", "version", "author"];

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch { return "0.0.0"; }
}

const VERSION = process.argv[2] || readVersion();

// ---------------------------------------------------------------- frontmatter

const skillMd = readFileSync(join(SRC, "SKILL.md"), "utf8");
const fmMatch = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) {
  console.error("❌ SKILL.md 缺少 YAML frontmatter（文件必须以 --- 开头）");
  process.exit(1);
}
const front = {};
for (const line of fmMatch[1].split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
  if (m) front[m[1]] = m[2].trim();
}
const missing = REQUIRED_FIELDS.filter((k) => !front[k]);
if (missing.length) {
  console.error(`❌ SKILL.md frontmatter 缺少必填字段：${missing.join(", ")}`);
  process.exit(1);
}
if (front.version !== VERSION) {
  console.error(`❌ 版本不一致：SKILL.md 为 ${front.version}，本次打包版本为 ${VERSION}`);
  process.exit(1);
}

if (skillMd.length > 20000) {
  console.error(`⚠️ SKILL.md 偏长（${skillMd.length} 字符），平台对正文长度有隐性限制，建议精简`);
}

// ---------------------------------------------------------------- 收集与体检

function collect(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...collect(full));
    else files.push({ name: relative(SRC, full).split(sep).join("/"), full, size: st.size });
  }
  return files;
}

const files = collect(SRC);
if (!files.length) {
  console.error("❌ skill 目录为空");
  process.exit(1);
}

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{24,}/g, "疑似 API Key"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "GitHub 令牌"],
  [/gh[posru]_[A-Za-z0-9]{20,}/g, "GitHub 令牌"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "邮箱"],
  [/[A-Za-z]:[\\/]Users[\\/][^\\/\s"')]+/g, "本机绝对路径（含用户名）"],
];

let blocked = false;
for (const f of files) {
  const text = readFileSync(f.full, "utf8");
  for (const [re, label] of SECRET_PATTERNS) {
    const hits = [...new Set(text.match(re) || [])];
    if (hits.length) {
      blocked = true;
      console.error(`❌ ${f.name} 命中 [${label}]：${hits.slice(0, 3).join(" | ")}`);
    }
  }
}
if (blocked) {
  console.error("\n打包已终止：技能包会公开分发，不能包含密钥、邮箱或本机路径。");
  process.exit(1);
}

// ---------------------------------------------------------------- 打包

const entries = files.map((f) => ({
  name: `${SKILL_NAME}/${f.name}`,
  content: readFileSync(f.full),
  mtime: statSync(f.full).mtime,
}));

const zip = buildZip(entries);
if (zip.length > MAX_BYTES) {
  console.error(`❌ 包体积 ${(zip.length / 1024 / 1024).toFixed(2)} MB，超过平台上限 3 MB`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${SKILL_NAME}-skill-v${VERSION}.zip`);
writeFileSync(outPath, zip);

const sha = createHash("sha256").update(zip).digest("hex");
console.log("技能包构建完成");
console.log(`  名称     : ${front.display_name || SKILL_NAME}（${SKILL_NAME}）`);
console.log(`  版本     : ${VERSION}　作者：${front.author}`);
console.log(`  分类     : ${front.category || "（未填）"}`);
console.log(`  条目     : ${entries.length} 个文件`);
entries.forEach((e) => console.log(`             - ${e.name}`));
console.log(`  输出     : ${outPath}`);
console.log(`  大小     : ${(zip.length / 1024).toFixed(1)} KB（上限 3 MB）`);
console.log(`  sha256   : ${sha}`);
console.log("\nfrontmatter 必填字段校验通过，未发现密钥 / 邮箱 / 本机路径。");

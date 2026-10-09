---
name: prompt-optimize-button
display_name: 提示词优化按钮
display_name_en: Prompt Optimize Button
description: 为 WorkBuddy 输入框安装 ✨ 提示词优化按钮：单击把未发送的草稿优化成结构化提示词，再次单击还原原文。用于安装、校验与排查该按钮。
description_zh: 为 WorkBuddy 输入框装上 ✨ 按钮，一键把草稿优化成结构化提示词，再点一次还原原文。
description_en: Install a ✨ button in the WorkBuddy input box that rewrites your draft into a structured prompt in one click, and restores the original on a second click.
category: productivity
version: 1.0.1
author: Heilampanng
---

# 提示词优化按钮

在 WorkBuddy 输入框底部工具栏注入一个 ✨ 按钮：单击把当前草稿优化成结构化提示词，再次单击还原原文。本技能负责**安装、校验与排查**这个按钮。

## 何时使用

- 用户想给输入框加一个「一键优化提示词」的按钮；
- 用户已经装过，但按钮不见了、点不动，或提示代理未就绪；
- 用户想卸载它。

## 执行流程

严格按顺序执行，**每一步都要把结果告诉用户**，不要跳步。

### 第 0 步　先探测现状（只读，不修改任何文件）

在 Bash 中运行本技能包内的探测脚本：

```bash
node <技能目录>/scripts/check.mjs
```

它会输出 JSON，关键字段：

| 字段 | 含义 |
|---|---|
| `installed` | 是否已安装（找到安装目录且文件齐全） |
| `proxy` | 本地代理状态，为 `null` 表示未运行 |
| `autostart` | 是否已写入开机自启 |
| `daemon` | 守护进程是否存活 |
| `cdp` | WorkBuddy 调试端口号，`null` 表示 WorkBuddy 没运行 |
| `button` | ✨ 按钮是否已挂载到页面 |

- 若 `installed` 为 `true` → 直接跳到**第 3 步**。
- 若为 `false` → 继续第 1 步。

### 第 1 步　确认运行环境

```bash
node -v
```

- 要求 **Node.js ≥ 18**（插件运行时会用到内置 `fetch`、`WebSocket`、`zlib`）。
- 低于 18：停止安装，告诉用户需要先升级 Node.js，不要尝试降级方案。
- 系统要求 Windows 10/11；安装过程不需要管理员权限。

### 第 2 步　下载并运行官方安装器

```bash
curl -L -o install.mjs https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs
node install.mjs
```

若 `curl` 不可用，改用 Node 自身下载：

```bash
node -e "fetch('https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs').then(r=>r.text()).then(t=>require('fs').writeFileSync('install.mjs',t))"
node install.mjs
```

安装器会自动完成：下载发行包 → 解压到 `%LOCALAPPDATA%\prompt-optimize-button` → 写入开机自启 → 拉起守护进程 → 拉起本地代理（`127.0.0.1:9477`）→ 通过 CDP 注入按钮 → 输出六项校验。

**注意**：若提示 `config.json 已存在`，说明安装器在保留用户原有配置（API Key 不会丢失），属正常行为。

### 第 3 步　校验

```bash
node install.mjs --check --json
```

判定标准：`ok` 为 `true` 且退出码为 `0`。其中 `checks.files`、`checks.proxy`、`checks.autostart`、`checks.daemon` 必须为 `true`。

`checks.cdp` 与 `checks.button` 为 `false` 时，如果 WorkBuddy 当前没打开，属正常现象——它下次启动时守护进程会自动补注入，不要因此判定安装失败。

### 第 4 步　引导配置与使用

安装成功后再告诉用户怎么用：

1. 打开 WorkBuddy，输入框底部工具栏会出现 ✨ 按钮（在模型选择器与语音按钮之间）；
2. **右键**该按钮打开设置面板，填写：服务类型（openai / anthropic）、服务地址、模型、API Key、输出风格、系统提示词；
3. 点「保存」即生效，并会顺手把开机自启补上；
4. 此后**左键**按钮：优化草稿；**再点一次**：还原原文。

## 排查

详细故障表见 `@references/troubleshooting.md`，安装细节见 `@references/install-guide.md`。

最常见的三种情况：

| 现象 | 处理 |
|---|---|
| 面板打开但没有内容 | 本地代理没运行。运行 `node cli.mjs setup`（在安装目录内），或双击安装目录下的 `一键启动.bat` |
| 按钮不见了 | 关闭并重开 WorkBuddy 会重建页面；守护进程会自动补注入。仍无按钮则运行 `node cli.mjs apply` |
| 提示开机自启失败（EPERM） | 本机安全策略禁止向启动文件夹写入脚本。改用**手动模式**：每次登录后运行一次 `一键启动.bat`，并如实告知用户 |

## 限制

- 本技能只做**安装与排查**，不代替用户填写 API Key——密钥必须由用户自己在右键面板里填写，任何情况下都不要向用户索取密钥，也不要把密钥写进文件或提交记录。
- 不修改 WorkBuddy 安装目录，不修改 `app.asar`。
- 不卸载用户的插件：卸载必须先征得用户明确同意，再运行 `node cli.mjs uninstall`（该操作会保留 `config.json`）。

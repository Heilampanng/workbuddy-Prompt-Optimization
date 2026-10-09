# 安装指南

本文件面向人工安装。若希望由 AI 自动完成，请改用[《安装指令.md》](安装指令.md)中的一句话指令。

---

## 一、运行环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10 / 11 | 开机自启依赖启动文件夹；macOS / Linux 仅支持「手动启动」模式 |
| Node.js | **≥ 18**（建议 20 或 22） | 依赖内置 `fetch`、`WebSocket`、`zlib`；无需任何 npm 依赖 |
| WorkBuddy | 正在运行 | 它启动时会在 `127.0.0.1:9334` 开放 CDP 调试端口，注入依赖该端口 |
| 网络 | 可访问 `github.com` 与 `codeload.github.com` | 安装阶段下载发行包；运行阶段需访问你配置的大模型服务 |
| 端口 | 本机 `9477` 未被占用 | 本地代理监听端口，可在 `config.json` 中修改 |
| 大模型服务 | 自备 API Key | OpenAI 兼容或 Anthropic 兼容均可 |

安装过程**不需要管理员权限**，所有文件写入当前用户目录。

---

## 二、分发包说明

| 内容 | 说明 |
|---|---|
| 打包方式 | `node build-release.mjs <版本>`，零第三方依赖，自行实现 ZIP 写入（deflate + CRC32） |
| 产物 | `dist/prompt-optimize-button-<版本>.zip` 与同名 `.sha256` |
| 包内结构 | 顶层目录 `prompt-optimize-button-<版本>/`，含源码、测试、文档、两个 bat |
| 完整性 | 包内 `RELEASE.json` 记录版本、源提交、构建时间与每个文件的 sha256 |
| 自动排除 | `config.json`、`start-daemon.vbs`、`.watch.lock`、`.watch.log`、`.git`、`dist/` |
| 发布渠道 | GitHub Release（`Heilampanng/workbuddy-Prompt-Optimization`）的资产附件 |

---

## 三、安装方式

### 方式一：AI 自动安装（推荐）

把[《安装指令.md》](安装指令.md)中的指令粘贴到 WorkBuddy 对话框，AI 会自动下载、安装并回报校验结果。

### 方式二：命令行安装

在 **命令提示符（cmd）** 或 PowerShell 中执行：

```bat
curl -L -o install.mjs https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs
node install.mjs
```

若 `curl` 不可用，用 Node 自身下载：

```bat
node -e "fetch('https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs').then(r=>r.text()).then(t=>require('fs').writeFileSync('install.mjs',t))"
node install.mjs
```

### 方式三：手动安装

1. 从 Releases 页面下载 `prompt-optimize-button-v1.0.1.zip`；
2. 解压到一个**不会被随意移动**的目录（移动会导致开机自启失效，需重新运行一次安装）；
3. 双击 `一键启动.bat`。

### 常用参数

```bat
node install.mjs --dir D:\tools\prompt-optimize   :: 指定安装目录
node install.mjs --tag v1.0.1                      :: 指定版本（默认 v1.0.1，取不到则回退 main 分支）
node install.mjs --no-setup                        :: 仅下载解压，不执行安装动作
node install.mjs --check                           :: 仅校验当前安装状态，不下载
node install.mjs --uninstall                       :: 卸载（保留 config.json）
node install.mjs --json                            :: 输出 JSON，供脚本或 AI 解析
```

默认安装目录：`%LOCALAPPDATA%\prompt-optimize-button`。

---

## 四、安装后可用的入口

| 入口 | 位置 | 用途 |
|---|---|---|
| ✨ 按钮 | WorkBuddy 输入框底部工具栏 | 左键优化草稿；再点一次还原原文 |
| 设置面板 | 右键 ✨ 按钮 | 配置服务地址、模型、API Key、输出风格、系统提示词；保存即时生效 |
| `一键启动.bat` | 安装目录 | 安装自启、拉起守护、注入按钮 |
| `一键卸载.bat` | 安装目录 | 关闭自启、移除按钮、停止守护与代理（保留配置） |
| `node cli.mjs status` | 安装目录 | 查看按钮挂载与代理状态 |
| `node cli.mjs doctor` | 安装目录 | 一次性诊断 CDP、代理、自启、守护 |
| `node cli.mjs watch` | 安装目录 | 前台运行守护进程（调试用） |
| 本地代理 | `http://127.0.0.1:9477/health` | 健康检查；`GET /health` 不返回 API Key |

正确安装完成后，**后续无需任何手动操作**：Windows 登录自动拉起守护，WorkBuddy 打开自动注入按钮。

---

## 五、成功校验

安装器结束时会输出六项校验，全部通过即返回退出码 `0`：

```
———— 安装校验 ————
  ✅ 文件完整（5 个关键文件）
  ✅ 本地代理在线（127.0.0.1:9477）  —— model=… hasKey=true
  ✅ 开机自启已写入（启动文件夹）
  ✅ 守护进程运行中  —— pid …
  ✅ WorkBuddy CDP 可达（端口 9334）
  ✅ ✨ 按钮已挂载到输入框
```

自动化场景使用：

```bat
node install.mjs --check --json
```

返回示例（节选）：

```json
{ "ok": true, "dir": "…", "checks": { "files": true, "proxy": true, "autostart": true, "daemon": true, "cdp": true, "button": true } }
```

判定规则：`ok = files && proxy && autostart && daemon`；`cdp` 与 `button` 作为附加信息——WorkBuddy 未运行时这两项为 `false` 属正常，其窗口打开后由守护进程自动补注入。

---

## 六、故障处理

| 现象 | 原因与处理 |
|---|---|
| `❌ Node.js 版本过低` | 升级 Node.js 至 18 及以上 |
| 下载失败 / HTTP 404 | 网络不可达或版本号不存在；安装器会自动回退到 `main` 分支，也可显式加 `--tag main` |
| `开机自启` 校验失败且报 `EPERM` | 安全策略禁止向启动文件夹写入脚本；改为手动模式，登录后运行一次 `一键启动.bat` |
| `本地代理` 校验失败 | 查看安装目录下 `.watch.log`；端口被占用时修改 `config.json` 的 `port` |
| `WorkBuddy CDP 可达` 为 false | WorkBuddy 未运行；启动后守护进程会自动注入，无需重新安装 |
| 移动了安装目录 | 开机自启仍指向旧路径；在新目录重新执行一次 `node install.mjs` |

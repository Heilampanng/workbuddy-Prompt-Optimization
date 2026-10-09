# 安装参考

## 运行环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（其他系统只能手动启动，没有开机自启） |
| Node.js | ≥ 18（插件用到内置 `fetch`、`WebSocket`、`zlib`；无任何 npm 依赖） |
| WorkBuddy | 需要处于运行状态 —— 它启动时会在 `127.0.0.1:9334` 开放 CDP 调试端口，注入依赖该端口 |
| 端口 | 本机 `9477` 需空闲（本地代理监听端口，可改 `config.json` 的 `port`） |
| 网络 | 安装阶段需可访问 `github.com`；运行阶段需可访问用户自己配置的大模型服务 |
| 权限 | **不需要管理员权限**，所有文件写入当前用户目录 |

默认安装目录：`%LOCALAPPDATA%\prompt-optimize-button`

## 三种安装方式

**AI 代装（推荐给非技术用户）**：直接执行 SKILL.md 的第 0～3 步即可，AI 会下载安装器、跑完安装并回报校验。

**命令行安装**：

```bat
curl -L -o install.mjs https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs
node install.mjs
```

**手动安装**：从 Releases 页面下载 `prompt-optimize-button-v1.0.1.zip`，解压到不会被随意移动的目录，双击 `一键启动.bat`。

## 安装器常用参数

```bat
node install.mjs --dir D:\tools\prompt-optimize   :: 指定安装目录
node install.mjs --tag v1.0.1                      :: 指定版本（默认取 v1.0.1，取不到自动回退 main 分支）
node install.mjs --no-setup                        :: 只下载解压，不执行安装动作
node install.mjs --check                           :: 只校验状态，不下载
node install.mjs --uninstall                       :: 卸载（保留 config.json）
node install.mjs --json                            :: JSON 输出，便于程序解析
```

安装器下载顺序：Release 资产 → 对应 tag 的源码归档 → `main` 分支归档，依次回退。

## 安装后可用入口

| 入口 | 位置 | 用途 |
|---|---|---|
| ✨ 按钮 | 输入框底部工具栏 | 左键优化草稿；再点一次还原原文 |
| 设置面板 | 右键 ✨ 按钮 | 服务类型 / 服务地址 / 模型 / API Key / 输出风格 / 系统提示词 |
| `一键启动.bat` | 安装目录 | 安装自启、拉起守护、注入按钮 |
| `一键卸载.bat` | 安装目录 | 关闭自启、移除按钮、停止守护与代理（保留配置） |
| `node cli.mjs status` | 安装目录 | 查看按钮挂载与代理状态 |
| `node cli.mjs doctor` | 安装目录 | 一次性诊断 CDP、代理、自启、守护 |
| 本地代理 | `http://127.0.0.1:9477/health` | 健康检查（不返回 API Key） |

## 成功校验

`node install.mjs --check --json` 输出的六项：

| 字段 | 含义 | 是否参与 `ok` 判定 |
|---|---|---|
| `checks.files` | 关键文件齐全 | 是 |
| `checks.proxy` | 本地代理有响应 | 是 |
| `checks.autostart` | 启动文件夹内已写入自启脚本 | 是 |
| `checks.daemon` | 守护进程存活 | 是 |
| `checks.cdp` | WorkBuddy CDP 端口可达 | 否（附加信息） |
| `checks.button` | ✨ 按钮已挂载 | 否（附加信息） |

判定：`ok === true` 且退出码为 `0` 即安装成功。

## 安全说明

- API Key 只存在本机 `config.json`，不进入页面 DOM、不随分发包走；
- 本地代理只绑定 `127.0.0.1`，CORS 仅放行无 `Origin` 的渲染器请求；
- `GET /health` 不返回完整密钥；
- 不修改 WorkBuddy 安装目录，不修改 `app.asar`。

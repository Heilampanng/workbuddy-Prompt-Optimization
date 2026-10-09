# prompt-optimize-button

为 WorkBuddy 输入框注入一个 ✨ 按钮：**单击，将当前尚未发送的草稿优化为结构化提示词；再次单击，还原原文。**

![演示：草稿 → 单击优化 → 结构化提示词 → 再次单击还原原文](docs/demo.gif)

该工具将「调用技能 → 等待回复 → 复制结果 → 粘贴回输入框」四个步骤合并为一次点击。

> 状态：个人自用工具，仅支持 Windows，通过 CDP 注入实现。不修改 `app.asar`，不改动安装目录。

---

## 界面

按钮位于输入框底部工具栏（模型选择器与语音按钮之间）：

![WorkBuddy 输入框底部工具栏中的 ✨ 按钮](docs/screenshot.png)

- **左键**：读取当前草稿 → 发给大模型优化 → 写回输入框（原文会被暂存，再点一次即还原）
- **右键**：打开设置面板（服务类型 / 服务地址 / 模型 / API Key / 输出风格 / 系统提示词）

---

## 工作原理

```mermaid
flowchart LR
    A["输入框草稿<br/>(Slate 编辑器)"] --> B["✨ 按钮<br/>CDP 注入在渲染页面"]
    B -->|"POST 127.0.0.1:9477"| C["本地代理<br/>proxy.mjs"]
    C -->|"HTTPS"| D["云端大模型<br/>(OpenAI / Anthropic 兼容)"]
    D -.->|"优化后的提示词"| C
    C -.-> B
    B -.->|"写回编辑器"| A
```

三个进程 / 组件：

| 组件 | 载体 | 职责 |
|---|---|---|
| `inject/ui.js` | 注入到 WorkBuddy 渲染页面 | 按钮 UI、右键面板、读取草稿、写回结果 |
| `proxy.mjs` | 本机 Node 进程，仅监听 `127.0.0.1:9477` | 保管 API Key、拼装系统提示词、转发请求、绕过浏览器跨域限制 |
| `cli.mjs` | 命令行 | 注入/卸载按钮、守护进程、开机自启 |

**为什么要有一个本地代理？** 因为它同时解决了三件事：API Key 不进入页面（存在本机 `config.json`）、浏览器 `file://` 渲染器的跨域限制、以及 OpenAI / Anthropic 两套协议格式的转换。代理本身**不包含任何模型**，它只是转发。

---

## 前置要求

- **Windows 10 / 11**
- **Node.js ≥ 18**（建议 20+，需要全局 `fetch` 与 `WebSocket`）
- 一个 OpenAI 兼容或 Anthropic 兼容的大模型 API（自备 Key）
- WorkBuddy 正在运行（它启动时会自动在 `127.0.0.1:9334` 开放 CDP，见 `~/.workbuddy/app/session/DevToolsActivePort`）

---

## 分发与安装

发行包由 `node build-release.mjs <版本>` 构建（零依赖，内置 ZIP 写入器），产物为
`dist/prompt-optimize-button-<版本>.zip`，包内附 `RELEASE.json`（版本、源提交、逐文件 sha256），
并以 GitHub Release 资产形式发布。构建时自动排除 `config.json`、`start-daemon.vbs` 与运行时文件。

三种安装入口：

1. **AI 自动安装（推荐）** —— 把[《安装指令.md》](安装指令.md)中的指令粘贴到 WorkBuddy 对话框，
   AI 会自动完成下载、安装与校验并回报结果。
2. **命令行安装** —— 详见 [INSTALL.md](INSTALL.md)：

   ```bat
   curl -L -o install.mjs https://raw.githubusercontent.com/Heilampanng/workbuddy-Prompt-Optimization/v1.0.1/install.mjs
   node install.mjs
   ```

3. **手动安装** —— 从 Releases 页面下载 zip，解压到不会被随意移动的目录，双击 `一键启动.bat`。

环境要求：Windows 10 / 11、Node.js ≥ 18、WorkBuddy 正在运行；**无需管理员权限，无任何 npm 依赖**。
安装器会在覆盖安装时保留既有 `config.json`（API Key 与自定义提示词不丢失）。

另外仓库内含一份 **WorkBuddy 技能包源码**（`skill/prompt-optimize-button/`，含只读状态探测脚本与排障手册），
由 `node pack-skill.mjs` 打包为可直接提交到 WorkBuddy 开放平台的 zip，用于在技能市场分发。

---

## 快速开始

1. 下载本仓库（或用 `git clone`），放到一个**不会被随便移动**的目录。
2. 双击 **`一键启动.bat`**。

它会自动：安装开机自启 → 启动守护进程 → 往页面注入按钮 → 打印结果。

3. 点输入框旁边的 ✨ 按钮 → **右键** → 填上服务地址、模型、API Key → 点 **保存**。

保存的同时会自动补齐一键启动（写入自启 + 拉起守护），之后**打开 WorkBuddy 就自动就绪，不需要再运行任何文件**。

---

## 配置

### 方式一：右键面板（推荐）

右键 ✨ 按钮即可。面板里能改：

| 字段 | 说明 |
|---|---|
| 服务类型 | `openai`（`/chat/completions`）或 `anthropic`（`/v1/messages`） |
| 服务地址 | 例如 `https://api.openai.com/v1`、`https://api.deepseek.com` |
| 模型 | 例如 `gpt-4o-mini`、`deepseek-chat` |
| API Key | 默认隐藏显示，可点「显示」查看；保存后落盘 `config.json` |
| 输出风格 | `structured`（分节） / `concise`（一段式） |
| 系统提示词 | 实际发给大模型的 system prompt，可编辑，可一键「恢复默认」 |

### 方式二：`config.json`

首次运行若不存在 `config.json`，程序会直接使用内置默认值（不会报错）。要自定义就复制模板：

```bash
cp config.example.json config.json
```

```json
{
  "protocol": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "",
  "model": "gpt-4o-mini",
  "style": "structured",
  "port": 9477,
  "prompt": ""
}
```

`prompt` 留空 = 使用内置默认提示词。

### 方式三：环境变量

```bash
set PROMPT_OPT_KEY=sk-xxxx          # 覆盖 apiKey，适合不想把 Key 落盘
set PROMPT_OPT_PROTOCOL=anthropic   # 覆盖 protocol
```

---

## 命令参考

```bash
node cli.mjs apply     [--port 9334]               # 注入按钮
node cli.mjs remove    [--port 9334]               # 卸载按钮
node cli.mjs status    [--port 9334]               # 查看注入状态
node cli.mjs doctor    [--port 9334]               # 诊断 CDP 端口与代理
node cli.mjs watch     [--interval 3000]           # 守护：自动拉起代理 + 页面重开自动补注入
node cli.mjs autostart on|off|status               # 开机自启（启动文件夹）
node cli.mjs setup                                 # 一键启动（装自启 + 起守护 + 注入）
node cli.mjs uninstall                             # 一键卸载（保留 config.json）
node cli.mjs bootstrap [--json]                    # 轻量幂等启动
```

日常用两个 bat 就够了：`一键启动.bat` / `一键卸载.bat`。

---

## 安全与隐私

- **API Key 只存在本机 `config.json`**，不进入页面 DOM、不写进注入脚本、不随分发包走。
  面板关闭即销毁，Key 随之从 DOM 消失。
- **代理只绑定 `127.0.0.1`**，外部网络无法访问。
- **CORS 仅放行无 `Origin` / `null`** 的请求（即 `file://` 渲染器），普通网页无法调用。
- **`GET /health` 会剔除 API Key**（只返回 `sk-b…bf08` 这样的掩码），避免出现在命令行输出与日志里。
- **测试脚本从不写入真实配置**：运行前备份 `config.json` → `config.json.testbak`，结束后原样还原。
- `config.json`、`.watch.lock`、`.watch.log`、`start-daemon.vbs` 均已在 `.gitignore` 中排除
  （`start-daemon.vbs` 由 `cli.mjs autostart` 动态生成，内含本机绝对路径，因此不入库）。

> ⚠️ 请注意：**不要把你自己的 `config.json` 提交到任何公开仓库**。本仓库提供的是 `config.example.json` 空模板。

---

## 卸载

双击 **`一键卸载.bat`**，会：关闭开机自启 → 停止守护进程 → 从页面移除按钮 → 停掉代理 → 清理运行时文件。

**你的 `config.json` 会被保留**，想彻底删掉请手动删除该文件。

---

## 自测

仓库带了一套不依赖外部服务的自测脚本（多数用假上游 / 临时端口，不会碰你的真实配置）：

```bash
node test-prompt.mjs      # 代理端：协议、提示词拼装、/config 契约、密钥掩码
node test-draft.mjs       # 草稿读取：Slate 结构解析
node test-panel.mjs       # 右键面板：回填、保存、密钥显示/隐藏、主题色
node test-watch.mjs       # 守护模式：补注入、单实例锁、残留锁自愈
node test-autostart.mjs   # 开机自启：VBS 内容与转义、幂等
node test-bat.mjs         # .bat 编码：真实 cmd 跑通且无幽灵命令
node test-e2e.mjs         # 端到端：真实写回（需要 WorkBuddy 窗口在前台，否则跳过）
```

---

## 已知限制

- **仅 Windows**：开机自启走启动文件夹 + VBS；`.bat` 相关逻辑是 Windows 专属。
- **依赖 WorkBuddy 的 DOM 结构**：编辑器是 Slate，按钮锚点、占位符节点都按 `data-slate-*` 属性定位。
  WorkBuddy 大版本更新后可能需要重新适配。
- **CDP 端口 9334 由 WorkBuddy 自己开放**，本工具不负责开启；WorkBuddy 未运行时无法注入。
- 每次 WorkBuddy 重开都会销毁页面里的按钮 —— 这正是 `watch` 守护模式存在的原因。

---

## 许可

[MIT](LICENSE)

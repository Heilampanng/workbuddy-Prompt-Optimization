# 排查参考

按现象对照处理。**每次只改一件事，改完重新跑 `scripts/check.mjs` 确认**。

## 1. 面板打开了，但里面是空的 / 保存没反应

**原因**：右键面板的数据来自本地代理，代理没运行时面板就是空的。

```bash
node cli.mjs setup        # 在安装目录内执行
```

或双击安装目录下的 `一键启动.bat`。之后 `check.mjs` 的 `proxy` 字段应不再为 `null`。

## 2. 输入框里没有 ✨ 按钮

| 检查项 | 命令 / 判断 |
|---|---|
| WorkBuddy 是否在运行 | `check.mjs` 的 `cdp` 字段，为 `null` 就是没运行 |
| 守护进程是否存活 | `check.mjs` 的 `daemon` 字段 |
| 按钮是否挂载 | `check.mjs` 的 `button` 字段 |

处理顺序：先确保 WorkBuddy 已打开 → 运行 `node cli.mjs apply` 手动注入 → 仍不行则重开 WorkBuddy（页面重建后守护会自动补注入）。

## 3. 提示「开机自启写入失败」或错误码 EPERM

**原因**：本机安全策略禁止向 Windows 启动文件夹写入 `.vbs` 脚本。这是环境限制，**不要去绕过它**。

**处理**：改用手动模式 —— 每次登录后运行一次 `一键启动.bat`（或在安装目录执行 `node cli.mjs setup`）。其余功能不受影响，如实告知用户即可。

## 4. 安装器下载失败（HTTP 404 / 超时）

```bash
node install.mjs --tag main
```

安装器本身会自动按「Release 资产 → tag 源码归档 → main 分支」回退。全部失败通常是网络无法访问 GitHub，请用户检查网络或代理。

## 5. `checks.proxy` 为 false

查看安装目录下的 `.watch.log`（会记录守护进程每一轮的动作与错误）：

- 端口 9477 被占用 → 修改 `config.json` 的 `port`，或结束占用进程；
- 代理反复重启 → 把 `.watch.log` 里的关键报错原文交给用户。

## 6. `checks.cdp` / `checks.button` 为 false

若 WorkBuddy 当前没打开，这是**正常现象**，不算安装失败：

- 不要重复安装；
- 告知用户「打开 WorkBuddy 后会自动出现按钮」，由其下次启动验证。

## 7. 优化请求报错（点按钮后提示失败）

按顺序检查：

1. `check.mjs` 的 `proxy.hasKey` 是否为 `true` —— 为 `false` 说明还没填 API Key；
2. 右键面板里的「服务地址 / 模型」是否与服务商一致（OpenAI 兼容填 `https://api.xxx.com/v1`，Anthropic 兼容选 `anthropic` 协议）；
3. 服务商侧余额 / 配额是否正常；
4. 若改过「系统提示词」，点面板里的「恢复默认」排除提示词问题。

## 8. 移动了安装目录之后

开机自启仍指向旧路径（启动文件夹里的 VBS 记录了绝对路径）。在新目录重新执行一次：

```bash
node install.mjs
```

## 9. 卸载

**必须先征得用户同意**，再执行：

```bash
node cli.mjs uninstall
```

会关闭开机自启、移除按钮、停止守护与代理，**保留 `config.json`**。要彻底清理，另需手动删除安装目录。

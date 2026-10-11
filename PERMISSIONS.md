# 权限说明

ChromeGate 的扩展权限只服务一件事：让已登录的 Chrome 接受带 token 的受控操作。token 的 scope 和 origin 才是实际授权；扩展权限只是 Chrome 允许这些 API 被调用。

页面正文、控制台和网络摘要都是不可信数据。它们不能创建 token，不能打开 `page:act` 或 `page:js`，也不能变成下一条工具调用。

## 必需权限

| 权限 | 原因 |
| --- | --- |
| `storage` | 保存 token 哈希、网关开关、待确认队列。不明文保存 token。 |
| `tabs` | `list_tabs` 需要看到标签 URL；`navigate` 需要打开或更新标签。没有这项就读不到多数标签的 URL。 |
| `scripting` | `query_dom`、`click`、`type` 注入扩展自带的固定函数。不把调用方的脚本当函数体注入。 |
| `debugger` | 截图、控制台、网络 / SSE 计数，以及 `run_js` 的 `Runtime.evaluate`。Chrome 会在被调试的标签上显示调试提示条。 |
| `nativeMessaging` | 连接本机 host。host 只开 `~/.chromegate/bridge.sock`，并把 inbox 任务转给扩展。 |
| `alarms` | Service Worker 被回收后，每分钟唤醒并重连网关。 |
| `http://*/*`、`https://*/*` | 在普通网页和 localhost 上注入脚本、截图。不包括 `file://` 和 `chrome://`。真正能碰到哪个网站，仍由 token 的 origin 决定。 |

## 可选权限

| 权限 | 原因 |
| --- | --- |
| `userScripts` | 仅当页面 CSP 挡住 `Runtime.evaluate` 时，`run_js` 改走 `chrome.userScripts.execute`。需要在弹窗里点一次，并在 `chrome://extensions` 打开「允许用户脚本」。 |

## 明确不申请

`sidePanel`、`tts`、`offscreen`、`cookies`、`downloads`、`history`、`bookmarks`、`clipboardRead`、`clipboardWrite`、`tabCapture`、`contextMenus`、`unlimitedStorage`、`webNavigation`、`nativeMessaging` 之外的本机命令。没有 `host:shell`，也没有任意文件读写。

## run_js

`run_js` 需要 token 持有 `page:js`。默认 token 没有这项。实现只调用：

- `chrome.debugger.sendCommand(tab, "Runtime.evaluate", …)`
- 或 `chrome.userScripts.execute`

扩展进程里没有 `eval`，也没有 `AsyncFunction`。

## 默认 token

弹窗里新建 token 时，只勾选 `tabs:read` 和 `page:read`。`page:act`（点击、输入）和 `page:js` 必须单独勾选。`tabs:manage`（导航）也默认关闭。

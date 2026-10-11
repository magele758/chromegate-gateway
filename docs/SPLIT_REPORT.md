# ChromeGate Gateway 拆分报告

日期：2026-10-11  
新目录：`/Users/example/developer/self-test-grounding/chromegate`（开始时不存在，本次新建）  
来源：open-chrome-ai / PageLens v0.12.1（Apache-2.0，copyright 2026 lei peng）  
老仓库：`/Users/example/developer/self-test-grounding/chrome-plugin-gemini` 只读。开始和结束时 `git status --short` 都只有 `?? yarn.lock`。没有切分支、没有提交、没有推送、没有 PR。  
运行时目录：`~/.chromegate-gw/`。没有读写 `~/.pagelens/`，没有向 Chrome 注册 Native Messaging host，没有改 Cursor / Claude / Codex 的 MCP 配置，没有在真实 Chrome 里加载扩展，没有上传商店。  
本地 git：只在新目录 `git init` 并提交。没有 remote，没有 push。  
首次提交（代码与本报告初稿）：`1533ed7cbcedb98226339d314d79a27cfbab095c`  
补记提交只把上一行的占位换成这个 hash，见 `git log`。没有 remote。

## 复制了什么

用 `diff -q` 对照老仓库。下面这些是复制后保留的。

原样复制：

- `LICENSE`
- `extension/icons/icon16.png`、`icon48.png`、`icon128.png`（仍是老占位图）
- `extension/lib/bridge/protocol.js`
- `extension/lib/bridge/token-store.js`
- `extension/lib/bridge/jobs.js`
- `extension/lib/agent/trust/approval-queue.js` → `extension/lib/trust/approval-queue.js`

复制后改过：

- `extension/lib/bridge/policy.js`：默认 origin 只留 `http://localhost:*` 和 `http://127.0.0.1:*`。去掉微信、知乎、B 站、小红书、抖音。
- `extension/lib/bridge/auth.js`：前缀 `cgk_`。scope 只留五个页面/标签项。未传 scopes 时默认 `tabs:read` + `page:read`。
- `extension/lib/bridge/audit.js`：注释改为 chromegate-gw-data。
- `extension/lib/bridge/leases.js`：租约范围是 `page:act`、`page:js`、`tabs:manage`。剪贴板工具列表为空。只有 `navigate` 且 `result.created` 才记新标签。
- `extension/lib/bridge/events.js`：`agent_task.*` 不再要求 `agent:delegate`。下载事件仍要求 `downloads`，但没有 token 持有这个 scope，所以会被丢掉。
- `extension/lib/idb-kv.js`：IndexedDB 名 `chromegate-gw-data`。
- `extension/lib/bridge/session-tools.js`：文案改为 navigate。
- `native/gateway.mjs`：socket 改为 `~/.chromegate-gw/bridge.sock`（可用 `CHROMEGATE_GW_SOCKET`）。增加 `localCall()`，给 inbox 用，不另开 socket 客户端。

新写（不是整文件搬过来）：

- 扩展：`manifest.json`、`sw.js`、`popup/`、`lib/storage.js`、`lib/urls.js`、`lib/page-actions.js`、`lib/run-js.js`、`lib/observe.js`、`lib/browser-env.js`、`lib/native-host.js`、`lib/native-port.js`、`lib/bridge/index.js`、`lib/bridge/tools.js`、`lib/bridge/trust-guard.js`、`lib/bridge/gateway.js`、`lib/trust/irreversible.js`
- 本机：`native/host.mjs`、`native/mcp.mjs`、`native/inbox.mjs`、`native/framing.mjs`、`native/verify.mjs`、`native/cli.mjs`
- 场景：`scenarios/identity.json`、`stream-integrity.json`、`dialog-state.json`
- 测试：`test/test_auth_scope.mjs`、`test_bridge.mjs`、`test_gateway.mjs`、`test_hygiene.mjs`、`test_inbox.mjs`、`test_page_actions.mjs`、`test_verify.mjs`、`test/helpers.mjs`、`scripts/run-tests.mjs`
- 文档：`README.md`、`NOTICE`、`PERMISSIONS.md`、本文件
- `package.json`、`package-lock.json`、`.gitignore`

老仓库里仍适用的契约（scope、origin、HITL 一次消费、租约、无 token 拒绝）在新测试里重写了。没有整份复制 `extension/tools/test_*.mjs`，因为那些文件 import 了已删除的模块。

## 剥掉了什么

没有复制，新仓库里这些路径不存在：

- 同传 / 配音 / 语音：`interpret*`、`planned-interpret`、`dub-*`、`tts.js`、`asr`、`offscreen/`、`audio.*`、`tools/media_helper.py`
- 翻译、读页问答、视频总结、剪藏
- 公众号和多平台发布、侧栏聊天（`extension/sidepanel`）
- JEV、Langfuse
- 本机 Shell / 任意文件：`host:shell`、`host:fs`，以及老的 `native/pagelens-host.mjs`
- `extension/lib/agent/tools.js`（1872 行那份，里面直接 import 语音模块）

网关行为上还关掉了：

- 无 token 的旧入口。`agentBridgeEnabled` 被强制为 false。没有 session token 的 hello 不暴露工具，call 返回 `UNAUTHORIZED`。
- MCP `tools/list` 只返回扩展按 scope 过滤后的工具，并隐藏 `list_tools`。不再附加本机 shell/fs 工具。`--mcp` 缺少 token 时进程退出 1，不退回 shell。
- host 拒绝 `exec`、`fs`、`shell`、`clipboard_write`。不 `import child_process`。
- inbox 只在 `~/.chromegate-gw/inbox|outbox` 搬 JSON。拒绝符号链接。outbox 不回写 token。

## tts 依赖怎么解的

老文件 `extension/lib/agent/tools.js` 第 6 行是：

```js
import { captureVoiceRefFromTab, synthesizeTts } from "../tts.js";
```

这份文件没有复制。新的页面工具在 `extension/lib/bridge/tools.js`，只 import `protocol.js`、`policy.js`、`urls.js`、`page-actions.js`。仓库里没有 `tts.js`。点击、输入、读 DOM 走 `page-actions.js` 里的固定函数；`run_js` 走 `run-js.js`。两边都不引用语音模块。

## 权限与 token

扩展 `manifest.json`（MV3，`minimum_chrome_version` 120）：

| 种类 | 项 | 用途 |
| --- | --- | --- |
| 必需 | `storage` | token 哈希、网关开关、待确认队列。不明文存 token。 |
| 必需 | `tabs` | `list_tabs`、`navigate` |
| 必需 | `scripting` | 注入扩展自带的固定函数（读 DOM、点击、输入） |
| 必需 | `debugger` | 截图、控制台、网络 / SSE、`run_js` 的 `Runtime.evaluate` |
| 必需 | `nativeMessaging` | 连接 `com.chromegate.gateway` |
| 必需 | `alarms` | Service Worker 回收后重连网关 |
| host | `http://*/*`、`https://*/*` | 普通网页和 localhost。不含 `file://`、`chrome://` |
| 可选 | `userScripts` | 仅当 CSP 挡住 `Runtime.evaluate` 时的 `run_js` 回退 |

不申请：`sidePanel`、`tts`、`offscreen`、`cookies`、`downloads`、`history`、`bookmarks`、`clipboardRead`、`clipboardWrite`、`tabCapture`、`contextMenus`、`unlimitedStorage`、`webNavigation`。逐条说明在 `PERMISSIONS.md`。

token scope（实际授权，比扩展权限更窄）：

| scope | 工具 | 默认 |
| --- | --- | --- |
| `tabs:read` | `list_tabs` | 开 |
| `page:read` | `query_dom`、`screenshot`、`read_console`、`read_network` | 开 |
| `tabs:manage` | `navigate` | 关 |
| `page:act` | `click`、`type` | 关，必须显式勾选 |
| `page:js` | `run_js` | 关，必须显式勾选 |

未知 scope（含 `clipboard`、`cookies`、`host:shell`、`host:fs`）会被丢掉。只存 SHA-256。空 origin 匹配不到任何站。弹窗要求至少一个 origin。用户如果亲手输入 `*`，语法上仍接受，这是显式的宽范围，README 里标了风险。页面返回值带 `untrusted: true`，不能改 scope。密码框读 DOM 时不带 value，输入时不回显。

`run_js` 只调用 `chrome.debugger` 的 `Runtime.evaluate`，CSP 失败才走 `chrome.userScripts.execute`。扩展进程里没有 `eval`，也没有 `AsyncFunction`。

HITL：可见文案像发布 / 发送 / 提交 / 删除，或导航到结账 URL，返回 `CONFIRMATION_REQUIRED`。批准只消费一次。scope 检查在 HITL 和注入之前，只读 token 的点击不会注入。

## verify

`node native/cli.mjs verify scenario.json` 不调模型，经网关回放。

步骤白名单：`list_tabs`、`navigate`、`click`、`type`、`screenshot`、`query_dom`、`run_js`。  
断言：`identity`、`stream_integrity`（DOM 与 SSE 计数相等且序号连续）、`dialog_state`、`dom_text`、`dom_attr`、`no_console_errors`、`network_count`、`screenshot`。断言只能调用只读观察工具。

模板：

- `scenarios/identity.json`：两个页面的用户 id 一致
- `scenarios/stream-integrity.json`：流式序号
- `scenarios/dialog-state.json`：弹窗开合（点击步骤需要 `page:act`）

失败时写 markdown 证据包到 outbox（截图、console、网络摘要、DOM 片段），`healed` 恒为 false。断言失败后停止，不跑后续步骤，也不重试失败的写操作。证据采集是额外的只读调用，不是自愈。白名单外的步骤不调用网关；若指定了 outbox，仍写失败包。观察结果不跨步骤缓存。

`mcp-config` 只打印片段，不写编辑器配置，不注册 host。

## 测试

在新目录执行 `npm install`（仅 devDependency `jsdom`）和 `npm test`。

```
7 passed, 0 failed
```

`test_auth_scope`、`test_bridge`、`test_gateway`、`test_hygiene`、`test_inbox`、`test_page_actions`、`test_verify`。  
socket 和 inbox 都用临时目录。`defaultSocketPath` 的测试传入假 home，不创建 `~/.chromegate-gw`。

## grep 证据

在新目录、排除 `node_modules` 和 `.git`：

```
rg -n -i --glob '!node_modules/**' --glob '!.git/**' \
  'interpret|planned-interpret|dub-|tts|asr|langfuse|jev|wechat|host:shell|host:fs|AsyncFunction|offscreen|media_helper|pagelens|PageLens|eval\(' .
```

写本报告之前的命中只有文档和卫生测试构造串，没有实现文件：

- `NOTICE`、`README.md`：写明源自 PageLens，且不读写 `~/.pagelens/`
- `PERMISSIONS.md`：列出明确不申请的 `tts`、`offscreen`，以及没有 `host:shell`
- `test/test_hygiene.mjs`：用字符串拼接构造禁词，避免测试文件自身包含这些词；该测试扫描 `extension`、`native`、`test`、`scenarios`、`scripts`，跳过自身，结果为空

`extension`、`native`、`scenarios`、`scripts` 以及除卫生测试外的测试里，没有 `tts.js` import，没有同传/配音实现。本报告为了说明剥掉了什么，会再次出现这些词；那是文档，不是代码。

另一次确认：`extension/lib/agent/tools.js`、`tts.js`、`asr.js`、`tools/media_helper.py`、`extension/offscreen`、`extension/sidepanel`、`native/pagelens-host.mjs` 在新目录均为 ABSENT。

## 遗留

- 图标仍是 PageLens 占位 PNG。
- 没有真实 Chrome 端到端测试（本次约束禁止加载扩展和注册 host）。
- `userScriptWrapper` 把调用方源码插进包装字符串。源码若提前闭合包装，这条 CSP 回退会坏。主路径是 debugger，不走包装。
- 复制来的 `events.js` 仍认识 `download.*` 和 `agent_task.*`，以及一段指向已删除 `delegate.js` 的注释。没有工具发出这些事件。
- origin 语法仍接受用户显式输入的 `*`，以及 pattern 里的 `file://`。manifest 没有 `file://` host 权限，显式 `*` 能匹配任意 http/https。
- inbox 轮询 2 秒，且只在 host 已连接、弹窗里打开 inbox 时运行。
- 证据采集会多打几次只读调用。它不重试失败步骤，也不改页面。
- `full` 预设包含 `page:js`。弹窗默认不勾选它。
- 老的大测试文件没有原样搬过来。

## lei 在真实 Chrome 里验证

这些步骤本仓库没有替你做。

1. `chrome://extensions` 打开开发者模式，加载已解压的扩展，目录选 `chromegate/extension`。抄下扩展 ID。
2. 确认 `native/host.mjs` 可执行（仓库已带 shebang）。你自己写  
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromegate.gateway.json`  
   `name` 为 `com.chromegate.gateway`，`path` 指向 `native/host.mjs` 的绝对路径，`type` 为 `stdio`，`allowed_origins` 为 `chrome-extension://扩展ID/`。然后重新加载扩展。
3. 打开弹窗，打开网关。新建只读 token（不要勾 `page:act` / `page:js`）。明文只显示一次，自己存到 `~/.chromegate-gw/agents/<名字>.token`，权限 `0600`。
4. `node native/cli.mjs mcp-config` 只打印。把片段自己贴进 Cursor / Claude Code / Codex。
5. 用只读 token 调 `list_tabs`。再用它调 `click`，应被 scope 拒绝，页面不应被点到。
6. 另建一个显式打开 `page:act` 的 token，origin 只填你控制的站。对删除类按钮点击应得到 `CONFIRMATION_REQUIRED`，在弹窗里允许一次后才能执行；再点一次应重新要求确认。
7. `node native/cli.mjs verify scenarios/identity.json --dry-run`，然后带 `--token-file` 和 `--var base=...` 对你自己的本地页跑。`dialog-state.json` 需要 `page:act`。故意让断言失败时，应在 `~/.chromegate-gw/outbox` 看到 markdown（和可能的 jpeg），并且后面的步骤不再执行。
8. 确认运行时文件在 `~/.chromegate-gw/`，`~/.pagelens/` 没有被这次使用碰到。
9. 可选：弹窗打开 inbox 后，`node native/cli.mjs inbox enqueue` 只写 `~/.chromegate-gw/`。网关连着时 host 才转发。
10. `userScripts` 是可选权限，只给 CSP 回退。不授予它时，debugger 路径仍可用于没有拦住 `Runtime.evaluate` 的页面。被观察的标签上会出现 Chrome 调试提示条。

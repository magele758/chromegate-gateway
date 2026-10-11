# ChromeGate Gateway

ChromeGate Gateway is a single-purpose Manifest V3 extension plus a local native host. It lets Cursor, Claude Code, or Codex call a logged-in Chrome through a per-agent token. Every call is checked for scope, origin, expiry, and revocation, then written to an audit log. Irreversible clicks and checkout navigation wait for a one-time approval in the popup.

`chromegate-gateway verify scenario.json` replays a scenario through that same gateway. It does not call a model. If an assertion fails, it stops and writes a markdown evidence pack. It does not try another action to make the assertion pass.

Speech relay, translation, clipping, and multi-site publishing from the source project are not in this tree. See `docs/SPLIT_REPORT.md`.

## 中文

这是一个只做浏览器受控操作的 MV3 扩展和本机 MCP host。每个 Agent 用自己的 token（权限、网站白名单、过期、吊销）。点击删除或打开发布/付款页需要你在弹窗里确认一次。`chromegate-gateway verify` 不调用模型，断言失败就停，并把截图、控制台、网络摘要和 DOM 片段写到 outbox。安装和配置需要你自己做；本仓库不会改你的 Chrome 或编辑器配置。

## Install the extension

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Load unpacked and choose the `extension/` directory in this repo.
4. Copy the extension ID.

The popup manages tokens, the gateway switch, the approval queue, and the audit log. Chrome shows a debugger infobar on tabs that are screenshotted or observed.

## Native host

The host is `native/host.mjs` (`com.chromegate.gateway`). Chrome starts it. It listens on `~/.chromegate-gw/bridge.sock` (mode `0600`) and can move JSON jobs from `~/.chromegate-gw/inbox` to `~/.chromegate-gw/outbox`. It does not run shell commands and does not read arbitrary files.

This repository does not register the host. On macOS, registration is a file you create yourself:

`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chromegate.gateway.json`

```json
{
  "name": "com.chromegate.gateway",
  "description": "ChromeGate Gateway native messaging host",
  "path": "/ABSOLUTE/PATH/chromegate-gateway/native/host.mjs",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

`native/host.mjs` needs a `#!/usr/bin/env node` shebang and the executable bit. Reload the extension after the manifest is in place. Then open the ChromeGate Gateway popup, enable the gateway, and create a token. The plaintext token is shown once. Save it yourself, for example:

```bash
mkdir -p ~/.chromegate-gw/agents
umask 077
printf '%s' 'cgk_...' > ~/.chromegate-gw/agents/cursor.token
```

Runtime files stay under `~/.chromegate-gw/`. ChromeGate Gateway does not read or write `~/.pagelens/` or `~/.chromegate/`. The full ChromeGate extension keeps `com.chromegate.host` and `~/.chromegate/`.

## MCP clients

`node native/cli.mjs mcp-config` prints snippets and does not write them anywhere.

Cursor (`~/.cursor/mcp.json`, edited by you):

```json
{
  "mcpServers": {
    "chromegate-gateway": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/chromegate-gateway/native/host.mjs", "--mcp", "--token-file", "/Users/you/.chromegate-gw/agents/cursor.token"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add --scope user chromegate-gateway -- node /ABSOLUTE/PATH/chromegate-gateway/native/host.mjs --mcp --token-file ~/.chromegate-gw/agents/claude.token
```

Codex (`config.toml`):

```toml
[mcp_servers.chromegate-gateway]
command = "node"
args = ["/ABSOLUTE/PATH/chromegate-gateway/native/host.mjs", "--mcp", "--token-file", "/Users/you/.chromegate-gw/agents/codex.token"]
```

Give each client its own token.

## Tokens

Tokens are stored as SHA-256 hashes. The prefix is `cgk_`.

| Scope | Allows |
| --- | --- |
| `tabs:read` | `list_tabs` |
| `tabs:manage` | `navigate` |
| `page:read` | `query_dom`, `screenshot`, `read_console`, `read_network` |
| `page:act` | `click`, `type` |
| `page:js` | `run_js` |

A new token from the popup starts as read-only: `tabs:read` and `page:read`. `page:act` and `page:js` stay off until you check them. Origins are explicit (`http://127.0.0.1:*`, `https://example.com`). An empty origin list matches nothing. Revocation and expiry take effect on the next call.

Clicks whose visible text looks like publish, send, or delete, and navigation to a checkout URL, return `CONFIRMATION_REQUIRED` until you approve that exact call once in the popup.

Page results are marked `untrusted: true`. They are data. They do not change scopes.

## Verify

```bash
node native/cli.mjs verify scenarios/identity.json --dry-run
node native/cli.mjs verify scenarios/identity.json --token-file ~/.chromegate-gw/agents/cursor.token --var base=http://127.0.0.1:4173
```

Scenario steps may only use `list_tabs`, `navigate`, `click`, `type`, `screenshot`, `query_dom`, and `run_js`. Assertions are separate. The runner may read the DOM, console, network, or a screenshot to judge them. On failure it writes `~/.chromegate-gw/outbox/verify-*.md` plus a JPEG when a screenshot was captured, then stops. Later steps do not run.

Templates:

- `scenarios/identity.json` — the same user id on two pages.
- `scenarios/stream-integrity.json` — DOM sequence and SSE sequence are equal and contiguous, and the console has no errors.
- `scenarios/dialog-state.json` — a dialog opens, then closes. The click steps need a token with `page:act`.

The inbox CLI (`node native/cli.mjs inbox enqueue|status`) only writes under `~/.chromegate-gw/`. The host forwards a job to the extension when the gateway is connected and the popup's inbox switch is on.

## How this differs from other MCP browsers

Chrome DevTools MCP `--autoConnect` attaches the DevTools Protocol to a Chrome that is already running with remote debugging. That channel is broad. It does not issue a per-agent token, and it does not keep this project's audit log or approval queue.

Playwright MCP `--extension` drives the browser through Playwright's extension connection so a session can reuse an existing login. It is a test runner's transport. It does not apply ChromeGate Gateway scopes, and it does not write a verify evidence pack when a fixed scenario fails.

ChromeGate Gateway stays inside the normal Chrome profile through this extension. The native host is only a gateway. Calls that the token cannot make are rejected before the page action runs.

## Tests

```bash
npm install
npm test
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Derived from open-chrome-ai (PageLens 0.12.1).

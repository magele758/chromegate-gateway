import { tokenFileName } from "../lib/bridge/auth.js";

const $ = (id) => document.getElementById(id);

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function selectedScopes() {
  return [...document.querySelectorAll("#scopes input:checked")].map((input) => input.value);
}

async function refresh() {
  const [settingsRes, statusRes, tokensRes, approvalsRes, auditRes] = await Promise.all([
    send({ type: "cg.settings.get" }),
    send({ type: "cg.gateway.status" }),
    send({ type: "cg.tokens.list" }),
    send({ type: "cg.approvals.list" }),
    send({ type: "cg.audit.list", limit: 30 }),
  ]);
  $("gw-enabled").checked = settingsRes?.settings?.agentGatewayEnabled === true;
  $("inbox-enabled").checked = settingsRes?.settings?.agentInboxEnabled === true;
  const status = statusRes?.status;
  $("gw-status").textContent = status?.state === "connected" ? "网关已连接" : status?.error || status?.state || "网关未连接";
  $("tok-list").replaceChildren(
    ...(tokensRes?.tokens || []).map((token) => {
      const li = document.createElement("li");
      li.textContent = `${token.name} · ${token.state} · ${token.scopes.join(", ")}`;
      if (token.state === "active") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "吊销";
        button.addEventListener("click", async () => {
          await send({ type: "cg.tokens.revoke", id: token.id });
          await refresh();
        });
        li.append(button);
      }
      return li;
    }),
  );
  $("approvals").replaceChildren(
    ...(approvalsRes?.entries || []).map((entry) => {
      const li = document.createElement("li");
      li.textContent = entry.reason || entry.toolName;
      for (const [allow, label] of [[true, "允许"], [false, "拒绝"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", async () => {
          await send({ type: "cg.approvals.resolve", id: entry.id, allow });
          await refresh();
        });
        li.append(button);
      }
      return li;
    }),
  );
  if (!(approvalsRes?.entries || []).length) $("approvals").textContent = "无";
  $("audit").replaceChildren(
    ...(auditRes?.entries || []).map((entry) => {
      const li = document.createElement("li");
      li.textContent = `${entry.ok ? "ok" : entry.code || "fail"} · ${entry.agent} · ${entry.tool}`;
      return li;
    }),
  );
}

async function saveFlags() {
  await send({
    type: "cg.settings.set",
    settings: { agentGatewayEnabled: $("gw-enabled").checked, agentInboxEnabled: $("inbox-enabled").checked },
  });
  await send({ type: "cg.gateway.reconnect" });
  await refresh();
}

$("gw-enabled").addEventListener("change", saveFlags);
$("inbox-enabled").addEventListener("change", saveFlags);
$("tok-create").addEventListener("click", async () => {
  const hours = Number($("tok-hours").value);
  const created = await send({
    type: "cg.tokens.create",
    name: $("tok-name").value,
    scopes: selectedScopes(),
    origins: $("tok-origins").value.split(/\s+/),
    expiresAt: Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3600 * 1000 : null,
  });
  const box = $("tok-once");
  if (!created?.ok) {
    box.hidden = false;
    box.textContent = created?.error || "创建失败";
    return;
  }
  const file = `~/.chromegate-gw/agents/${tokenFileName($("tok-name").value)}.token`;
  box.hidden = false;
  box.textContent = `明文只显示一次。保存到 ${file}（权限 0600）：\n${created.token}`;
  await refresh();
});
$("allow-userscripts").addEventListener("click", () => {
  chrome.permissions.request({ permissions: ["userScripts"] });
});
refresh().catch((err) => {
  $("gw-status").textContent = err?.message || String(err);
});

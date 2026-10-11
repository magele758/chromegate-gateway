import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { clickSelector, queryDom, typeInto } from "../extension/lib/page-actions.js";

const dom = new JSDOM(`<!doctype html><body>
  <span data-user-id="u-1" data-testid="user-id">alice</span>
  <input id="name" />
  <input id="pw" type="password" value="secret" />
  <button id="go">删除</button>
  <div id="modal" role="dialog" hidden>确认</div>
</body>`);
const { document } = dom.window;
let clicked = 0;
document.getElementById("go").addEventListener("click", () => {
  clicked += 1;
});

const prevDocument = globalThis.document;
const prevStyle = globalThis.getComputedStyle;
globalThis.document = document;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
try {
  const nodes = queryDom("[data-testid=user-id]", 5);
  assert.equal(nodes.nodes[0].attrs["data-user-id"], "u-1");
  assert.equal(nodes.nodes[0].text, "alice");
  const secret = queryDom("#pw", 1);
  assert.equal(secret.nodes[0].attrs.type, "password");
  assert.equal(secret.nodes[0].text, "");
  assert.equal("value" in secret.nodes[0].attrs, false);
  const typed = typeInto("#name", "lei", true);
  assert.equal(typed.ok, true);
  assert.equal(typed.value, "lei");
  const password = typeInto("#pw", "nope", true);
  assert.equal(password.matches, true);
  assert.equal("value" in password, false);
  const click = clickSelector("#go");
  assert.equal(click.ok, true);
  assert.equal(clicked, 1);
  const dialog = queryDom("[role=dialog]", 5);
  assert.equal(dialog.nodes[0].hidden, true);
} finally {
  globalThis.document = prevDocument;
  globalThis.getComputedStyle = prevStyle;
}

console.log("page actions ok");

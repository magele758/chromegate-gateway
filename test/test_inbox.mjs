import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { enqueueJob, inboxStatus, processInboxOnce } from "../native/inbox.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-inbox-"));
const token = `cgk_${"a".repeat(43)}`;
const queued = enqueueJob({ root, tool: "list_tabs", args: {}, token, agentName: "cursor" });
assert.equal(fs.existsSync(queued.jobPath), true);
assert.equal(inboxStatus(root).inbox, 1);

const seen = [];
const done = await processInboxOnce({
  root,
  call: async (job) => {
    seen.push(job.token);
    assert.equal(job.request.tool, "list_tabs");
    return { ok: true, result: { tabs: [] } };
  },
});
assert.equal(done[0].ok, true);
assert.equal(seen[0], token);
const out = JSON.parse(fs.readFileSync(path.join(root, "outbox", `${queued.id}.json`), "utf8"));
assert.equal(out.ok, true);
assert.equal(JSON.stringify(out).includes(token), false);
assert.equal(inboxStatus(root).inbox, 0);
assert.equal(inboxStatus(root).outbox, 1);

console.log("inbox ok");

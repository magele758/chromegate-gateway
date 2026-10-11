import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function chromegateHome(env = process.env, home = os.homedir()) {
  if (env.CHROMEGATE_GW_HOME) return path.resolve(env.CHROMEGATE_GW_HOME);
  return path.join(home, ".chromegate-gw");
}

export function inboxPaths(root) {
  const inbox = path.join(root, "inbox");
  return {
    root,
    inbox,
    processing: path.join(inbox, "processing"),
    processed: path.join(inbox, "processed"),
    outbox: path.join(root, "outbox"),
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function safeId(id) {
  const clean = String(id || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return clean || "job";
}

function writeOut(outbox, id, body) {
  ensureDir(outbox);
  const file = path.join(outbox, `${safeId(id)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function enqueueJob({ root, tool, args = {}, token, agentName = "inbox" }) {
  const paths = inboxPaths(root);
  ensureDir(paths.inbox);
  const id = `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  const job = {
    id,
    token: String(token || ""),
    agentName: String(agentName || "inbox"),
    request: { v: 1, id, tool: String(tool || ""), args: args || {} },
  };
  const jobPath = path.join(paths.inbox, `${id}.json`);
  fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  return { id, jobPath, outboxPath: path.join(paths.outbox, `${id}.json`) };
}

export function inboxStatus(root) {
  const paths = inboxPaths(root);
  const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length : 0);
  return { inboxDir: paths.inbox, outboxDir: paths.outbox, inbox: count(paths.inbox), outbox: count(paths.outbox) };
}

export async function processInboxOnce({ root, call }) {
  if (!root) throw new Error("inbox root 必填。");
  const paths = inboxPaths(root);
  if (!fs.existsSync(paths.inbox)) return [];
  ensureDir(paths.processing);
  ensureDir(paths.processed);
  ensureDir(paths.outbox);
  const names = fs.readdirSync(paths.inbox).filter((name) => name.endsWith(".json"));
  const results = [];
  for (const name of names) {
    const src = path.join(paths.inbox, name);
    let stat;
    try {
      stat = fs.lstatSync(src);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const id = safeId(name.replace(/\.json$/, ""));
      writeOut(paths.outbox, id, { id, ok: false, error: { code: "BAD_REQUEST", message: "inbox 只接受普通 JSON 文件。" } });
      try {
        fs.renameSync(src, path.join(paths.processed, `${id}.json`));
      } catch {
        /* ignore */
      }
      results.push({ id, ok: false });
      continue;
    }
    const dest = path.join(paths.processing, name);
    try {
      fs.renameSync(src, dest);
    } catch {
      continue;
    }
    const fallbackId = safeId(name.replace(/\.json$/, ""));
    let job;
    try {
      job = JSON.parse(fs.readFileSync(dest, "utf8"));
    } catch {
      writeOut(paths.outbox, fallbackId, { id: fallbackId, ok: false, error: { code: "BAD_REQUEST", message: "inbox 文件不是 JSON。" } });
      fs.renameSync(dest, path.join(paths.processed, `${fallbackId}.json`));
      results.push({ id: fallbackId, ok: false });
      continue;
    }
    const id = safeId(job?.id || fallbackId);
    try {
      if (!job?.request?.tool) throw new Error("inbox job 缺少 request.tool。");
      const response = await call(job);
      writeOut(paths.outbox, id, { id, ok: Boolean(response?.ok), response, finishedAt: Date.now() });
      results.push({ id, ok: Boolean(response?.ok) });
    } catch (err) {
      writeOut(paths.outbox, id, {
        id,
        ok: false,
        error: { code: "TOOL_FAILED", message: err?.message || String(err) },
        finishedAt: Date.now(),
      });
      results.push({ id, ok: false });
    }
    fs.renameSync(dest, path.join(paths.processed, `${id}.json`));
  }
  return results;
}

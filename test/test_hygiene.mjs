import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const banned = [
  ["inter", "pret"].join(""),
  ["planned-", "interpret"].join(""),
  ["d", "ub-"].join(""),
  ["tt", "s"].join(""),
  ["a", "sr"].join(""),
  ["lang", "fuse"].join(""),
  ["j", "ev"].join(""),
  ["we", "chat"].join(""),
  ["host:", "shell"].join(""),
  ["host:", "fs"].join(""),
  ["Async", "Function"].join(""),
  ["off", "screen"].join(""),
  ["media", "_helper"].join(""),
];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...files(full));
    else if (/\.(js|mjs|json|css|html|md)$/.test(name)) out.push(full);
  }
  return out;
}

const roots = ["extension", "native", "test", "scenarios", "scripts"].map((dir) => join(root, dir));
const hits = [];
for (const dir of roots) {
  for (const file of files(dir)) {
    if (file.endsWith("test_hygiene.mjs")) continue;
    const text = readFileSync(file, "utf8");
    for (const word of banned) {
      if (text.includes(word)) hits.push(`${relative(root, file)}: ${word}`);
    }
  }
}
assert.deepEqual(hits, []);
console.log("hygiene ok");

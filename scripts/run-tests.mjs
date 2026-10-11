#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(fileURLToPath(new URL(".", import.meta.url)), "../test");
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const files = readdirSync(dir)
  .filter((file) => file.startsWith("test_") && file.endsWith(".mjs"))
  .filter((file) => !filters.length || filters.some((filter) => file.includes(filter)))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const file of files) {
  const name = basename(file, ".mjs");
  process.stdout.write(`  RUN   ${name} ... `);
  try {
    execFileSync(process.execPath, [resolve(dir, file)], { timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    passed += 1;
    console.log("PASS");
  } catch (err) {
    failed += 1;
    const stderr = [err.stdout?.toString(), err.stderr?.toString()].filter(Boolean).join("\n").slice(-3000);
    failures.push({ name, stderr });
    console.log("FAIL");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  for (const failure of failures) {
    console.log(`\n✗ ${failure.name}\n${failure.stderr}`);
  }
  process.exit(1);
}

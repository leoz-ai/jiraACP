#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const d = new Date();
const dateStr = `${d.getFullYear()}.${(d.getMonth() + 1) * 100 + d.getDate()}`;

const cur = pkg.version;
const patch = cur.startsWith(dateStr)
  ? parseInt(cur.split(".").pop()) + 1
  : 1;

const next = `${dateStr}.${patch}`;
execFileSync("npm", ["version", next, "--no-git-tag-version"], { stdio: "inherit" });
console.log(`Bumped: ${cur} → ${next}`);

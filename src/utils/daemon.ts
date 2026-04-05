import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME_DIR = path.join(os.homedir(), ".jira-acp");
const PID_FILE = path.join(HOME_DIR, "jira-acp.pid");
const LOG_FILE = path.join(HOME_DIR, "logs", "jira-acp.log");

export function getPidFile(): string {
  return PID_FILE;
}

export function getLogFile(): string {
  return LOG_FILE;
}

function readPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

function writePid(pid: number): void {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid));
}

function removePid(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getStatus(): { running: boolean; pid?: number } {
  const pid = readPid();
  if (pid === null) return { running: false };
  if (isAlive(pid)) return { running: true, pid };
  removePid();
  return { running: false };
}

export function startDaemon(port: number): { pid: number } | { error: string } {
  const status = getStatus();
  if (status.running) {
    return { error: `Already running (PID ${status.pid})` };
  }

  const logDir = path.dirname(LOG_FILE);
  fs.mkdirSync(logDir, { recursive: true });

  const cliPath = path.resolve(process.argv[1]!);
  const out = fs.openSync(LOG_FILE, "a");
  const err = fs.openSync(LOG_FILE, "a");

  const child = spawn(
    process.execPath,
    [cliPath, "--daemon-child", String(port)],
    {
      detached: true,
      stdio: ["ignore", out, err],
    },
  );

  fs.closeSync(out);
  fs.closeSync(err);

  if (!child.pid) return { error: "Failed to spawn daemon" };

  writePid(child.pid);
  child.unref();

  return { pid: child.pid };
}

export async function stopDaemon(): Promise<{
  stopped: boolean;
  pid?: number;
  error?: string;
}> {
  const pid = readPid();
  if (pid === null) return { stopped: false, error: "Not running" };
  if (!isAlive(pid)) {
    removePid();
    return { stopped: false, error: "Not running (stale PID removed)" };
  }

  process.kill(pid, "SIGTERM");

  // Wait up to 5s for clean exit
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!isAlive(pid)) {
      removePid();
      return { stopped: true, pid };
    }
  }

  // Force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  removePid();
  return { stopped: true, pid };
}

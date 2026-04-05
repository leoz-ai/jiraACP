import fs from "node:fs";
import path from "node:path";

export interface Lock {
  release(): void;
}

interface LockData {
  pid: number;
  startedAt: string;
  stage: string;
}

export async function acquireLock(
  lockPath: string,
  stage = "init",
): Promise<Lock> {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });

  const data: LockData = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    stage,
  };

  try {
    fs.writeFileSync(lockPath, JSON.stringify(data), { flag: "wx" }); // O_EXCL — fail if exists
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "EEXIST") {
      const existing = readLockData(lockPath);
      if (existing && isProcessAlive(existing.pid)) {
        throw new Error(
          `Pipeline already running (PID ${existing.pid}, stage: ${existing.stage})`,
        );
      }
      // Dead process — steal lock
      fs.writeFileSync(lockPath, JSON.stringify(data));
    } else {
      throw err;
    }
  }

  // Release on exit
  const cleanup = (): void => {
    tryUnlink(lockPath);
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  return {
    release() {
      tryUnlink(lockPath);
      process.removeListener("exit", cleanup);
    },
  };
}

export function readLockData(lockPath: string): LockData | null {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockData;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

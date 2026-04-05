import pino from "pino";

export const logger = pino({
  transport: process.stdout.isTTY
    ? {
        target: "pino-pretty",
        options: { colorize: true, ignore: "pid,hostname" },
      }
    : undefined,
  level: process.env["LOG_LEVEL"] ?? "info",
});

export function createLogger(name: string): pino.Logger {
  return logger.child({ name });
}

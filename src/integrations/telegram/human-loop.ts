import fs from "node:fs";
import path from "node:path";
import { getBot } from "./bot.js";

export type TimeoutAction = "skip" | "abort" | "proceed-with-warning";

interface PendingClarification {
  ticketKey: string;
  messageId: number;
  questions: string[];
  createdAt: string;
  expiresAt: string;
}

interface PendingEntry extends PendingClarification {
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, PendingEntry>();

export function loadPendingStore(storeDir: string): void {
  const storePath = path.join(storeDir, "pending-clarifications.json");
  if (!fs.existsSync(storePath)) return;

  const items = JSON.parse(
    fs.readFileSync(storePath, "utf8"),
  ) as PendingClarification[];
  for (const item of items) {
    if (new Date(item.expiresAt) > new Date()) {
      // Re-register as expired-on-start (will be resolved via /answer or timeout)
      pending.set(item.ticketKey, {
        ...item,
        resolve: () => {
          /* will be overwritten when pipeline resumes */
        },
        reject: () => {
          /* will be overwritten when pipeline resumes */
        },
      });
    }
  }
}

function savePendingStore(storeDir: string): void {
  const storePath = path.join(storeDir, "pending-clarifications.json");
  const items: PendingClarification[] = Array.from(pending.values()).map(
    ({ resolve: _r, reject: _j, ...rest }) => rest,
  );
  fs.writeFileSync(storePath, JSON.stringify(items, null, 2));
}

export async function requestClarification(
  token: string,
  chatId: number | string,
  ticketKey: string,
  questions: string[],
  storeDir: string,
  opts: { timeoutMs: number; onTimeout: TimeoutAction; topicId?: number },
): Promise<string> {
  const bot = getBot(token);
  const threadOpts = opts.topicId ? { message_thread_id: opts.topicId } : {};

  const formatted = [
    `⚠️ <b>${ticketKey}</b> — Cần clarify trước khi code`,
    "",
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    "",
    "Reply với:",
    `<code>/answer ${ticketKey}</code>`,
    ...questions.map((_, i) => `${i + 1}. (your answer)`),
  ].join("\n");

  const msg = await bot.api.sendMessage(chatId, formatted, {
    parse_mode: "HTML",
    ...threadOpts,
  });

  const expiresAt = new Date(Date.now() + opts.timeoutMs).toISOString();

  return new Promise((resolve, reject) => {
    pending.set(ticketKey, {
      ticketKey,
      messageId: msg.message_id,
      questions,
      createdAt: new Date().toISOString(),
      expiresAt,
      resolve,
      reject,
    });
    savePendingStore(storeDir);

    // Reminders at 50% and 80% of timeout
    setTimeout(async () => {
      if (pending.has(ticketKey)) {
        await bot.api.sendMessage(
          chatId,
          `⏰ <b>${ticketKey}</b> — Nhắc lại: cần clarify (còn ${Math.round((opts.timeoutMs * 0.5) / 60000)}min)`,
          { parse_mode: "HTML", ...threadOpts },
        );
      }
    }, opts.timeoutMs * 0.5);

    setTimeout(async () => {
      if (!pending.has(ticketKey)) return;
      pending.delete(ticketKey);
      savePendingStore(storeDir);

      if (opts.onTimeout === "abort") {
        reject(new Error(`Clarification timeout for ${ticketKey}`));
      } else if (opts.onTimeout === "skip") {
        reject(new Error(`SKIP:Clarification timeout — ticket skipped`));
      } else {
        resolve(
          "(No clarification received — proceeding with original description)",
        );
      }
    }, opts.timeoutMs);
  });
}

export function registerAnswerHandler(token: string, storeDir: string): void {
  const bot = getBot(token);

  bot.command("answer", async (ctx) => {
    const text = ctx.message?.text ?? "";
    const lines = text.replace(/^\/answer(?:@\S+)?\s*/, "").split("\n");
    const ticketKey = lines[0]?.trim();
    const answers = lines.slice(1).join("\n").trim();

    if (!ticketKey) return;

    const entry = pending.get(ticketKey);
    if (entry) {
      pending.delete(ticketKey);
      savePendingStore(storeDir);
      entry.resolve(answers);
      await ctx.reply(
        `✅ Answers received for ${ticketKey}. Pipeline continues.`,
      );
    } else {
      await ctx.reply(`No pending clarification found for ${ticketKey}.`);
    }
  });
}

// ── Review approval flow ──────────────────────────────────────────────────

export type ApprovalTimeoutAction = "abort" | "merge-anyway";

interface PendingApproval {
  ticketKey: string;
  messageId: number;
  createdAt: string;
  expiresAt: string;
}

interface PendingApprovalEntry extends PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (reason: Error) => void;
}

const pendingApprovals = new Map<string, PendingApprovalEntry>();

export async function requestApproval(
  token: string,
  chatId: number | string,
  ticketKey: string,
  issues: Array<{ severity: string; message: string }>,
  opts: {
    timeoutMs: number;
    onTimeout: ApprovalTimeoutAction;
    topicId?: number;
  },
): Promise<boolean> {
  const bot = getBot(token);
  const threadOpts = opts.topicId ? { message_thread_id: opts.topicId } : {};

  const issueLines = issues
    .filter((i) => i.severity === "major")
    .map((i) => `• ${i.message}`)
    .join("\n");

  const text = [
    `⚠️ <b>${ticketKey}</b> — Review found major issues`,
    "",
    issueLines,
    "",
    "Approve to merge or reject to abort pipeline.",
    `Use /approve ${ticketKey} or /reject ${ticketKey}`,
  ].join("\n");

  const msg = await bot.api.sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve & Merge", callback_data: `approve:${ticketKey}` },
          { text: "❌ Reject", callback_data: `reject:${ticketKey}` },
        ],
      ],
    },
    ...threadOpts,
  });

  const expiresAt = new Date(Date.now() + opts.timeoutMs).toISOString();

  return new Promise((resolve, reject) => {
    pendingApprovals.set(ticketKey, {
      ticketKey,
      messageId: msg.message_id,
      createdAt: new Date().toISOString(),
      expiresAt,
      resolve,
      reject,
    });

    setTimeout(() => {
      if (!pendingApprovals.has(ticketKey)) return;
      pendingApprovals.delete(ticketKey);

      if (opts.onTimeout === "merge-anyway") {
        resolve(true);
      } else {
        reject(new Error(`REVIEW_APPROVAL_TIMEOUT:${ticketKey}`));
      }
    }, opts.timeoutMs);
  });
}

export function registerApprovalHandlers(token: string): void {
  const bot = getBot(token);

  // Inline keyboard callback handler
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    if (data.startsWith("approve:")) {
      const ticketKey = data.slice("approve:".length);
      const entry = pendingApprovals.get(ticketKey);
      if (entry) {
        pendingApprovals.delete(ticketKey);
        entry.resolve(true);
        await ctx.answerCallbackQuery({ text: `✅ Approved ${ticketKey}` });
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await ctx.answerCallbackQuery({ text: "No pending approval found." });
      }
      return;
    }

    if (data.startsWith("reject:")) {
      const ticketKey = data.slice("reject:".length);
      const entry = pendingApprovals.get(ticketKey);
      if (entry) {
        pendingApprovals.delete(ticketKey);
        entry.resolve(false);
        await ctx.answerCallbackQuery({ text: `❌ Rejected ${ticketKey}` });
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: [] },
        });
      } else {
        await ctx.answerCallbackQuery({ text: "No pending approval found." });
      }
    }
  });

  // Text command fallback
  bot.command("approve", async (ctx) => {
    const ticketKey = ctx.message?.text
      ?.replace(/^\/approve(?:@\S+)?\s*/, "")
      .trim();
    if (!ticketKey) return;
    const entry = pendingApprovals.get(ticketKey);
    if (entry) {
      pendingApprovals.delete(ticketKey);
      entry.resolve(true);
      await ctx.reply(`✅ ${ticketKey} approved — proceeding to merge.`);
    } else {
      await ctx.reply(`No pending approval for ${ticketKey}.`);
    }
  });

  bot.command("reject", async (ctx) => {
    const ticketKey = ctx.message?.text
      ?.replace(/^\/reject(?:@\S+)?\s*/, "")
      .trim();
    if (!ticketKey) return;
    const entry = pendingApprovals.get(ticketKey);
    if (entry) {
      pendingApprovals.delete(ticketKey);
      entry.resolve(false);
      await ctx.reply(`❌ ${ticketKey} rejected — pipeline will abort.`);
    } else {
      await ctx.reply(`No pending approval for ${ticketKey}.`);
    }
  });
}

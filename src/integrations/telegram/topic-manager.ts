import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Bot } from "grammy";

const STORE_PATH = path.join(os.homedir(), ".jira-acp", "telegram-topics.json");

type TopicStore = Record<string, number>; // "projectName:ticketKey" => message_thread_id

function loadStore(): TopicStore {
  if (!fs.existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as TopicStore;
  } catch {
    return {};
  }
}

function saveStore(store: TopicStore): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

export async function getOrCreateTopic(
  bot: Bot,
  chatId: number | string,
  ticketKey: string,
  projectName: string,
): Promise<number | undefined> {
  const store = loadStore();
  const key = `${projectName}:${ticketKey}`;

  if (store[key] !== undefined) return store[key];

  try {
    const topic = await bot.api.createForumTopic(chatId, ticketKey);
    store[key] = topic.message_thread_id;
    saveStore(store);
    return topic.message_thread_id;
  } catch {
    // Chat is not a forum supergroup — topic creation not supported
    return undefined;
  }
}

/** Get or create a persistent "🔔 Notifications" topic for system-level messages. */
export async function getOrCreateSystemTopic(
  bot: Bot,
  chatId: number | string,
  projectName: string,
): Promise<number | undefined> {
  const store = loadStore();
  const key = `${projectName}:__notifications__`;

  if (store[key] !== undefined) return store[key];

  try {
    const topic = await bot.api.createForumTopic(chatId, "🔔 Notifications", {
      icon_color: 0x6fb9f0, // light blue
    });
    store[key] = topic.message_thread_id;
    saveStore(store);
    return topic.message_thread_id;
  } catch {
    return undefined;
  }
}

export async function archiveTopic(
  bot: Bot,
  chatId: number | string,
  ticketKey: string,
  projectName: string,
): Promise<void> {
  const store = loadStore();
  const key = `${projectName}:${ticketKey}`;
  const threadId = store[key];
  if (threadId === undefined) return;

  try {
    await bot.api.closeForumTopic(chatId, threadId);
  } catch {
    // Topic may already be closed or deleted
  }

  delete store[key];
  saveStore(store);
}

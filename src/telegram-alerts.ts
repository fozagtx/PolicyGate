/**
 * hyperflow.telegram-alerts — thin wrapper around Telegram Bot API.
 * Every alert is prefixed with config.telegram.alertPrefix.
 */

import { appConfig, optionalSecretEnv } from "./config.js";

const telegramAlertPrefix = appConfig.telegram.alertPrefix;

export enum AlertLevel {
  INFO = "ℹ️",
  WARN = "⚠️",
  KILL = "🛑",
  WIN = "✅",
  ERROR = "❌",
}

export async function alert(level: AlertLevel, message: string): Promise<boolean> {
  const formatted = `${level} ${telegramAlertPrefix} ${message}`;
  const telegramBotToken = optionalSecretEnv("TG_BOT_TOKEN");
  const telegramChatId = optionalSecretEnv("TG_CHAT_ID");
  if (!telegramBotToken || !telegramChatId) {
    console.warn("Telegram alert skipped: TG_BOT_TOKEN or TG_CHAT_ID not set");
    return false;
  }

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChatId,
          text: formatted,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!resp.ok) {
      console.error("Telegram send failed:", resp.status, await resp.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("Telegram alert exception:", e);
    return false;
  }
}

export async function info(msg: string): Promise<boolean> {
  return alert(AlertLevel.INFO, msg);
}
export async function warn(msg: string): Promise<boolean> {
  return alert(AlertLevel.WARN, msg);
}
export async function kill(msg: string): Promise<boolean> {
  return alert(AlertLevel.KILL, msg);
}
export async function win(msg: string): Promise<boolean> {
  return alert(AlertLevel.WIN, msg);
}
export async function error(msg: string): Promise<boolean> {
  return alert(AlertLevel.ERROR, msg);
}

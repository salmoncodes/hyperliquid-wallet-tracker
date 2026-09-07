import { Bot } from 'grammy';
import type { DatabaseManager } from '../db/database.js';
import type { HyperliquidService } from '../services/hyperliquid.js';
import { BotHandlers } from './handlers.js';
import type { AppConfig } from '../config.js';

export function createTelegramBot(config: AppConfig, db: DatabaseManager, hlService: HyperliquidService): { bot: Bot; handlers: BotHandlers } {
  if (!config.telegramBotToken) {
    console.warn('⚠️ No TELEGRAM_BOT_TOKEN provided. Running in headless/CLI tracker mode.');
  }

  const bot = new Bot(config.telegramBotToken || 'dummy_token');

  // Incoming message logger
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text || ctx.callbackQuery?.data;
    if (text) {
      console.log(`📩 Incoming from [${ctx.from?.id} @${ctx.from?.username || ctx.from?.first_name}]: ${text}`);
    }
    await next();
  });

  // Security / Admin Filter Middleware (if ADMIN_CHAT_ID is set)
  if (config.adminChatId || config.allowedChatIds.length > 0) {
    const allowed = new Set<string>();
    if (config.adminChatId) allowed.add(config.adminChatId);
    for (const id of config.allowedChatIds) allowed.add(id);

    bot.use(async (ctx, next) => {
      const chatId = String(ctx.from?.id || ctx.chat?.id || '');
      if (!allowed.has(chatId)) {
        console.log(`🚫 Dropping unauthorized message from ${chatId}`);
        return;
      }
      await next();
    });
  }
  // Uncaught polling and update error boundary
  bot.catch((err) => {
    console.error('⚠️ Telegram Bot update error caught by boundary:', err);
  });
  // Register all handlers
  const handlers = new BotHandlers(bot, db, hlService);

  return { bot, handlers };
}

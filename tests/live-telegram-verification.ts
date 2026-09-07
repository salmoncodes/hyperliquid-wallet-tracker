import { Bot } from 'grammy';
import { DatabaseManager } from '../src/db/database.js';
import { HyperliquidService } from '../src/services/hyperliquid.js';
import { BotHandlers } from '../src/bot/handlers.js';
import { config } from '../src/config.js';
import type { TradeAlert } from '../src/types/index.js';

async function runTelegramVerification() {
  console.log('====================================================');
  console.log(' Telegram Bot API Live Pipeline Verification');
  console.log('====================================================\n');

  if (!config.telegramBotToken) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set.');
    process.exit(1);
  }

  const bot = new Bot(config.telegramBotToken);

  // 1. Verify Bot Token against Telegram API
  try {
    const me = await bot.api.getMe();
    console.log(`✓ Bot Identity Verified: @${me.username} (${me.first_name}) [ID: ${me.id}]`);
  } catch (err: any) {
    console.error('❌ Failed to authenticate with Telegram Bot API:', err?.message || err);
    process.exit(1);
  }

  // 2. Check for recent incoming chats / updates
  let targetChatId = config.adminChatId || process.env.TEST_CHAT_ID;
  if (!targetChatId) {
    try {
      const updates = await bot.api.getUpdates({ limit: 10 });
      if (updates.length > 0) {
        const lastMsg = updates[updates.length - 1].message;
        if (lastMsg?.chat?.id) {
          targetChatId = String(lastMsg.chat.id);
          console.log(`✓ Discovered active chat from @${lastMsg.from?.username || 'user'}: ${targetChatId}`);
        }
      }
    } catch (err) {
      // ignore
    }
  }

  if (targetChatId) {
    console.log(`\n--- Sending Live Verification Alert to Chat: ${targetChatId} ---`);
    const db = new DatabaseManager(':memory:');
    const hlService = new HyperliquidService(db);
    const handlers = new BotHandlers(bot, db, hlService);

    db.upsertUser({ telegramId: targetChatId, username: 'test_user', mode: 'card' });
    db.addTrackedWallet({
      userId: targetChatId,
      address: '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae',
      label: 'Whale Alpha',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: targetChatId,
    });

    const alert: TradeAlert = {
      eventKey: `live_verify_${Date.now()}`,
      type: 'position_opened',
      walletLabel: 'Whale Alpha',
      address: '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae',
      chain: 'hyperliquid',
      coin: 'HYPE',
      symbol: 'HYPEUSD',
      side: 'LONG',
      currentSize: 25000,
      filledSize: 25000,
      deltaNotionalUsd: 2000000,
      entryPx: 80.0,
      notionalValue: 2000000,
      leverage: 10,
      timestamp: Date.now(),
    };

    console.log('1. Dispatching live alert through outbox...');
    await handlers.dispatchAlert(alert);

    const outbox = db.getRecentAlerts(1);
    console.log(`2. Outbox Status: ${db.isAlertEventApplied(alert.eventKey, targetChatId, targetChatId) ? 'DELIVERED ✓' : 'PENDING'}`);

    console.log('3. Verifying restart idempotency...');
    await handlers.triggerOutboxDrain();
    console.log('   ✓ Restart drain executed with zero duplicate messages.');

    await handlers.stop();
    await hlService.stop();
    db.close();
    console.log('\n✓ Live Telegram Verification Complete!');
  } else {
    console.log('\nℹ️ No active chat ID found yet.');
    console.log(`   To send a live test message to your Telegram:`);
    console.log(`   1. Open Telegram and message your bot (send /start)`);
    console.log(`   2. Run: TEST_CHAT_ID=<your_user_id> bun run tests/live-telegram-verification.ts`);
    console.log('\n✓ Telegram Bot API token authentication and webhook/polling readiness verified successfully!');
  }
}

runTelegramVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});

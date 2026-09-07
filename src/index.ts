import { config } from './config.js';
import { DatabaseManager } from './db/database.js';
import { HyperliquidService } from './services/hyperliquid.js';
import { createTelegramBot } from './bot/index.js';
import { AlertFormatter } from './services/formatter.js';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('⚡ Hyperliquid Smart Money & Whale Tracker Bot Starting...');
  console.log('═══════════════════════════════════════════════════════════════');

  // 1. Initialize SQLite Database
  const db = new DatabaseManager(config.dbPath);
  console.log(`📁 Database initialized at ${config.dbPath}`);

  // 2. Initialize Hyperliquid Service with DatabaseManager and network configuration
  console.log(`🌐 Hyperliquid Network: ${config.hyperliquidNetwork.toUpperCase()} (${config.hyperliquidWsUrl})`);
  const hlService = new HyperliquidService(db, {
    network: config.hyperliquidNetwork,
    wsUrl: config.hyperliquidWsUrl,
    httpUrl: config.hyperliquidHttpUrl,
  });
  // 3. Register Delivery Sinks BEFORE seeding or starting WebSocket
  let bot: ReturnType<typeof createTelegramBot>['bot'] | null = null;
  let handlers: ReturnType<typeof createTelegramBot>['handlers'] | null = null;
  if (config.telegramBotToken) {
    const botSetup = createTelegramBot(config, db, hlService);
    bot = botSetup.bot;
    handlers = botSetup.handlers;

    bot.catch((err) => {
      console.error('Telegram bot error caught in boundary:', err);
    });

    try {
      await bot.api.setMyCommands([
        { command: 'start', description: 'Main control dashboard' },
        { command: 'add', description: 'Add a wallet address to track' },
        { command: 'list', description: 'View tracked wallets & live positions' },
        { command: 'summary', description: 'Hyperdash 24h market summary report' },
        { command: 'positions', description: 'Check open positions & uPnL for any trader' },
        { command: 'top', description: 'Discover top active Hyperliquid whales' },
        { command: 'filter', description: 'Set minimum trade size filter' },
        { command: 'demo', description: 'Simulate live test alerts' },
        { command: 'help', description: 'Command manual' },
      ]);
    } catch (err) {
      console.warn('Could not set Telegram commands:', err);
    }
  } else {
    console.log('⚠️ TELEGRAM_BOT_TOKEN not provided in .env - registering console logger sink');
    hlService.onAlert((alert) => {
      console.log('──────────────────────────────────────────────────');
      console.log(AlertFormatter.formatAlert(alert).replace(/<[^>]*>/g, ''));
      console.log('──────────────────────────────────────────────────');
    });
  }

  // 4. Load and Pre-seed distinct active tracked addresses
  const distinctAddresses = db.getActiveDistinctAddresses('hyperliquid');
  console.log(`📋 Found ${distinctAddresses.length} distinct active addresses in database.`);

  for (const address of distinctAddresses) {
    console.log(`🌱 Pre-seeding position state for ${address}...`);
    try {
      await hlService.seedAndSubscribe(address);
    } catch (err) {
      console.warn(`Could not seed ${address}:`, err);
    }
  }

  // 5. Start WebSocket feed, reconciliation, and pending inbox replay
  hlService.start(config.reconcileIntervalSeconds);

  // 6. Start Telegram Bot Polling if enabled
  if (bot) {
    console.log('🤖 Starting Telegram Bot polling...');
    bot.start({
      onStart(botInfo) {
        console.log(`✅ Telegram Bot @${botInfo.username} is running and listening for trades!`);
      },
    });
  }

  // Clean Async Graceful Shutdown (Idempotent)
  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    if (handlers) {
      await handlers.stop();
    }
    await hlService.stop();
    if (bot) {
      await bot.stop();
    }
    db.close();
    console.log('✅ Graceful shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });
}

main().catch((err) => {
  console.error('Fatal error starting tracker:', err);
  process.exit(1);
});

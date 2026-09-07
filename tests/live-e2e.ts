import { HyperliquidService } from '../src/services/hyperliquid.js';
import { DatabaseManager } from '../src/db/database.js';
import { AlertFormatter } from '../src/services/formatter.js';
import type { TradeAlert } from '../src/types/index.js';

async function runLiveTest() {
  console.log('====================================================');
  console.log('⚡ Running Live Hyperliquid Ingestion & Verification');
  console.log('====================================================\n');

  // Initialize in-memory test database
  const db = new DatabaseManager(':memory:');
  const hlService = new HyperliquidService(db);

  const receivedAlerts: TradeAlert[] = [];

  hlService.onAlert((alert) => {
    receivedAlerts.push(alert);
    console.log(`\n🚨 [LIVE ALERT RECEIVED] ${alert.type.toUpperCase()}`);
    console.log(`   Trader:  ${alert.walletLabel} (${alert.address.slice(0, 8)}...${alert.address.slice(-6)})`);
    console.log(`   Symbol:  ${alert.symbol} | Action: ${alert.side}`);
    console.log(`   Size:    ${alert.currentSize} (Delta: ${alert.filledSize})`);
    console.log(`   Entry:   $${alert.entryPx.toLocaleString()} | Notional: $${alert.notionalValue.toLocaleString()}`);
    if (alert.closedPnl !== undefined) {
      console.log(`   PnL:     $${alert.closedPnl.toFixed(2)}`);
    }

    // Format into actual Telegram HTML
    const formatted = AlertFormatter.formatAlert(alert);
    console.log('\n--- Telegram Message Output Preview ---');
    console.log(formatted);
    console.log('---------------------------------------\n');
  });

  // Track active hyperliquid smart money wallets
  const activeWallets = [
    { address: '0xadd12adbbd5db87674b38af99b6dd34dd2a45e0d', label: 'Hyper Alpha MM' },
    { address: '0x2d99fe0f36c1aebd28a1a2c0e82e8ca13c2ea351', label: 'Whale 0x2d99' },
    { address: '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae', label: 'Whale 0x8def' },
  ];

  try {
    // 1. Start WebSocket engine
    hlService.start(30);

    console.log('1. Waiting for Hyperliquid WebSocket connection and initial heartbeat...');
    const startWait = Date.now();
    while ((!hlService.getIsConnected() || hlService.getFeedHealth().lastMessageTime === 0) && Date.now() - startWait < 10000) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!hlService.getIsConnected()) {
      throw new Error('Failed to establish live Hyperliquid WebSocket connection within 10s timeout.');
    }
    if (hlService.getFeedHealth().lastMessageTime === 0) {
      throw new Error('Connected to WebSocket but received zero heartbeat messages within 10s timeout.');
    }
    console.log('   ✓ Connected to Hyperliquid WebSocket feed and verified live message receipt.');

    console.log('\n2. Subscribing to active live wallets on Hyperliquid...');
    for (const w of activeWallets) {
      db.upsertUser({ telegramId: 'test_user_1', username: 'tester', mode: 'feed' });
      db.addTrackedWallet({
        userId: 'test_user_1',
        address: w.address,
        label: w.label,
        chain: 'hyperliquid',
        isActive: true,
        minNotionalUsd: 0,
        alertChatId: 'test_chat_1',
      });
      await hlService.subscribe(w.address, w.label);
      console.log(`   ✓ Subscribed to ${w.label} (${w.address})`);
    }

    console.log('\n3. Listening for live WebSocket trade executions (15s sample window)...');
    await new Promise((resolve) => setTimeout(resolve, 15000));

    console.log('\n4. Execution Summary:');
    console.log(`   Total Live Alerts Triggered: ${receivedAlerts.length}`);
    console.log(`   Database Outbox Pending: ${db.getUndeliveredOutboxAlerts().length}`);
    console.log(`   Database Ingest History: ${db.getRecentAlerts(5).length}`);
    console.log('\n✓ Live Hyperliquid pipeline executed successfully!');
  } catch (err: any) {
    console.error('❌ Live test error:', err?.message || err);
    process.exitCode = 1;
  } finally {
    await hlService.stop();
    db.close();
  }
}

runLiveTest();

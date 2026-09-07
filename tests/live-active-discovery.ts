import { HyperliquidService } from '../src/services/hyperliquid.js';
import { DatabaseManager } from '../src/db/database.js';
import { AlertFormatter } from '../src/services/formatter.js';
import type { TradeAlert } from '../src/types/index.js';

async function runDynamicLiveDiscoveryTest() {
  console.log('===============================================================');
  console.log('⚡ Live Dynamic Trader Discovery & Live Execution Verification');
  console.log('===============================================================\n');

  const db = new DatabaseManager(':memory:');
  const hlService = new HyperliquidService(db);
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
    console.log('   ✓ Connected to Hyperliquid WebSocket feed and verified live message receipt.\n');
    // 2. Fetch recent trades across top markets to discover currently active addresses
    console.log('2. Discovering active traders currently executing on Hyperliquid...');
    const activeAddresses = new Set<string>();

    const coins = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP'];
  for (const coin of coins) {
    try {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'recentTrades', coin }),
      });
      if (res.ok) {
        const trades = (await res.json()) as Array<{ users: string[] }>;
        for (const t of trades) {
          if (Array.isArray(t.users)) {
            for (const u of t.users) {
              if (u && u.startsWith('0x')) activeAddresses.add(u.toLowerCase());
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const traderList = Array.from(activeAddresses).slice(0, 15);
  console.log(`   Found ${activeAddresses.size} active traders. Monitoring top ${traderList.length} wallets:\n`);

  let alertCount = 0;

  hlService.onAlert((alert: TradeAlert) => {
    alertCount++;
    console.log(`\n===============================================================`);
    console.log(`🚨 [LIVE ON-CHAIN/DEX ALERT #${alertCount}] ${alert.type.toUpperCase()}`);
    console.log(`===============================================================`);
    console.log(`Trader Label:   ${alert.walletLabel}`);
    console.log(`Address:        ${alert.address}`);
    console.log(`Market:         ${alert.symbol} (${alert.coin})`);
    console.log(`Action:         ${alert.side} | Direction: ${alert.type}`);
    console.log(`Current Size:   ${alert.currentSize} (Delta: ${alert.filledSize})`);
    console.log(`Entry Price:    $${alert.entryPx.toLocaleString()}`);
    console.log(`Notional Value: $${alert.notionalValue.toLocaleString()}`);
    if (alert.closedPnl !== undefined) {
      console.log(`Realized PnL:   $${alert.closedPnl.toFixed(2)}`);
    }

    console.log('\n--- Rendered Telegram HTML Message ---');
    console.log(AlertFormatter.formatAlert(alert));
    console.log('--------------------------------------');
  });
    // 3. Subscribe to all discovered active wallets
    for (let i = 0; i < traderList.length; i++) {
      const addr = traderList[i];
      const label = `Smart Trader #${i + 1}`;
      db.upsertUser({ telegramId: 'test_admin', username: 'admin', mode: 'feed' });
      db.addTrackedWallet({
        userId: 'test_admin',
        address: addr,
        label,
        chain: 'hyperliquid',
        isActive: true,
        minNotionalUsd: 0,
        alertChatId: 'test_channel',
      });
      await hlService.subscribe(addr, label);
      console.log(`   ✓ Subscribed to ${label}: ${addr}`);
    }

    console.log('\n4. Listening for incoming live trade fills (30-second live capture window)...');
    await new Promise((resolve) => setTimeout(resolve, 30000));

    console.log('\n===============================================================');
    console.log('📊 Live Verification Summary');
    console.log('===============================================================');
    console.log(`Live Alerts Received & Formatted: ${alertCount}`);
    console.log(`SQLite Outbox Records:            ${db.getUndeliveredOutboxAlerts().length}`);
    console.log(`SQLite Ingested History:         ${db.getRecentAlerts(10).length}`);
    console.log('===============================================================\n');
  } catch (err: any) {
    console.error('❌ Live discovery error:', err?.message || err);
    process.exitCode = 1;
  } finally {
    await hlService.stop();
    db.close();
  }
}

runDynamicLiveDiscoveryTest();

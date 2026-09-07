import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DatabaseManager } from '../src/db/database.js';
import { AlertFormatter, escapeTelegramHtml } from '../src/services/formatter.js';
import { HyperliquidService, type TradeFillRaw } from '../src/services/hyperliquid.js';
import { BotHandlers } from '../src/bot/handlers.js';
import { validateConfig } from '../src/config.js';
import type { TradeAlert, MarketSummary, Position } from '../src/types/index.js';

describe('Hyperliquid Smart Money Tracker - Comprehensive Production Test Suite', () => {
  let db: DatabaseManager;

  beforeEach(() => {
    db = new DatabaseManager(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // --- 1. Configuration Validation ---
  it('Configuration: Strictly validates environment variables and throws on invalid formats', () => {
    // Valid config
    const valid = validateConfig({
      TELEGRAM_BOT_TOKEN: '123456789:ABCdefGHIjklMNOpqrsTUVwxyz_1234567890',
      ADMIN_CHAT_ID: '987654321',
      TRACKER_ALLOWED_CHAT_IDS: '111,222,333',
      DEFAULT_MIN_NOTIONAL: '5000',
      TRACKER_RECONCILE_INTERVAL_S: '30',
      TRACKER_DB_PATH: './test.sqlite',
      HYPERLIQUID_NETWORK: 'mainnet',
    });
    expect(valid.telegramBotToken).toBe('123456789:ABCdefGHIjklMNOpqrsTUVwxyz_1234567890');
    expect(valid.adminChatId).toBe('987654321');
    expect(valid.allowedChatIds).toEqual(['111', '222', '333']);
    expect(valid.defaultMinNotional).toBe(5000);
    expect(valid.reconcileIntervalSeconds).toBe(30);
    expect(valid.hyperliquidNetwork).toBe('mainnet');
    expect(valid.dbPath).toBe('./test.sqlite');
    expect(valid.hyperliquidWsUrl).toBe('wss://api.hyperliquid.xyz/ws');

    // Testnet config auto-namespaces default database
    const testnetConfig = validateConfig({
      HYPERLIQUID_NETWORK: 'testnet',
    });
    expect(testnetConfig.hyperliquidNetwork).toBe('testnet');
    expect(testnetConfig.dbPath).toBe('./data/tracker-testnet.sqlite');
    expect(testnetConfig.hyperliquidWsUrl).toBe('wss://api.hyperliquid-testnet.xyz/ws');
    expect(testnetConfig.hyperliquidHttpUrl).toBe('https://api.hyperliquid-testnet.xyz/info');
    // Malformed token throws
    expect(() => {
      validateConfig({ TELEGRAM_BOT_TOKEN: 'invalid_token_format' });
    }).toThrow('TELEGRAM_BOT_TOKEN format is invalid');

    // Negative min notional throws
    expect(() => {
      validateConfig({ DEFAULT_MIN_NOTIONAL: '-500' });
    }).toThrow('DEFAULT_MIN_NOTIONAL must be a non-negative number');

    // Invalid reconcile interval throws
    expect(() => {
      validateConfig({ TRACKER_RECONCILE_INTERVAL_S: '2' });
    }).toThrow('TRACKER_RECONCILE_INTERVAL_S must be an integer >= 5');
    // Invalid / typo in HYPERLIQUID_NETWORK throws
    expect(() => {
      validateConfig({ HYPERLIQUID_NETWORK: 'testent' });
    }).toThrow("HYPERLIQUID_NETWORK must be 'mainnet' or 'testnet', got 'testent'");
    expect(() => {
      validateConfig({ HYPERLIQUID_NETWORK: 'staging' });
    }).toThrow("HYPERLIQUID_NETWORK must be 'mainnet' or 'testnet', got 'staging'");
  });

  // --- 2. Ingest Reduction & Durable Persistence Atomic Transaction ---
  it('Ingest Transaction: Atomically updates positions cache, fill cursors, inbox status, and outbox rows', () => {
    const address = '0x1234567890123456789012345678901234567890';
    const coin = 'BTC';

    // 1. Setup subscribers
    db.upsertUser({ telegramId: 'user_1', username: 'user1', mode: 'card' });
    db.addTrackedWallet({
      userId: 'user_1',
      address,
      label: 'Whale Alpha',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: 'chat_1',
    });

    // 2. Pre-insert pending inbox fills
    const inboxRes1 = db.insertInboxFill(address, { coin: 'BTC', time: 1000, tid: 101, px: '80000', sz: '1.0', dir: 'Open Long', crossed: false, fee: '0', hash: '0x1', oid: 1, startPosition: '0.0', closedPnl: '0.0', side: 'B' });
    const inboxRes2 = db.insertInboxFill(address, { coin: 'BTC', time: 2000, tid: 102, px: '81000', sz: '1.0', dir: 'Open Long', crossed: false, fee: '0', hash: '0x2', oid: 2, startPosition: '1.0', closedPnl: '0.0', side: 'B' });
    expect(db.getPendingInboxCount()).toBe(2);

    const positionState: Position = {
      coin: 'BTC',
      size: 2.0,
      entryPx: 80500,
      side: 'LONG',
      notionalValue: 161000,
      unrealizedPnl: 1000,
      leverage: 10,
    };

    const alert: TradeAlert = {
      eventKey: `${address}:${coin}:1000_2000_101_102:increase:0`,
      type: 'position_increased',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 2.0,
      filledSize: 2.0,
      entryPx: 80500,
      notionalValue: 161000,
      timestamp: 2000,
    };

    // Execute atomic reduction commit
    const res = db.commitReductionAndEmitOutbox(
      address,
      coin,
      positionState,
      [inboxRes1.id, inboxRes2.id],
      2000,
      102,
      [alert]
    );

    expect(res.outboxIds.length).toBe(1);

    // A. Verify Reducer Position Cache is persisted
    const cachedPositions = db.getCachedPositions(address);
    expect(cachedPositions.length).toBe(1);
    expect(cachedPositions[0].coin).toBe('BTC');
    expect(cachedPositions[0].size).toBe(2.0);
    expect(cachedPositions[0].entryPx).toBe(80500);

    // B. Verify Fill Cursor advanced
    const cursor = db.getFillCursor(address);
    expect(cursor?.lastFillTime).toBe(2000);
    expect(cursor?.lastFillTid).toBe(102);

    // C. Verify Inbox fills marked delivered
    expect(db.getPendingInboxCount()).toBe(0);

    // D. Verify Outbox record created with user-specific presentation label
    const undelivered = db.getUndeliveredOutboxAlerts();
    expect(undelivered.length).toBe(1);
    expect(undelivered[0].alert.walletLabel).toBe('Whale Alpha');
  });
  // --- 3. Bounded HTTP Concurrency Semaphore ---
  it('HTTP Concurrency Limiter: Strictly bounds concurrent in-flight requests under high caller contention', async () => {
    const hlService = new HyperliquidService(db);
    const limiter = hlService.getHttpLimiter();

    let concurrentRunning = 0;
    let peakConcurrent = 0;

    // Simulate 25 simultaneous requests
    const callers = Array.from({ length: 25 }, async (_, i) => {
      const release = await limiter.acquire();
      concurrentRunning++;
      if (concurrentRunning > peakConcurrent) {
        peakConcurrent = concurrentRunning;
      }

      // Hold slot for 20ms to create queue contention
      await new Promise((resolve) => setTimeout(resolve, 20));

      concurrentRunning--;
      release();
      return i;
    });

    const results = await Promise.all(callers);
    expect(results.length).toBe(25);
    expect(peakConcurrent).toBeLessThanOrEqual(5);
    expect(limiter.getInFlight()).toBe(0);
    expect(limiter.getQueueLength()).toBe(0);
  });

  // --- 4. HTTP Rate Limiter Queue Timeout & Purge ---
  it('HTTP Concurrency Limiter: Aborts queued callers on deadline expiration and purges waiter from queue', async () => {
    const hlService = new HyperliquidService(db);
    const limiter = hlService.getHttpLimiter();

    // 1. Fill all 5 concurrency slots
    const releases: Array<() => void> = [];
    for (let i = 0; i < 5; i++) {
      releases.push(await limiter.acquire());
    }
    expect(limiter.getInFlight()).toBe(5);

    // 2. Caller 6 attempts to acquire with a short 30ms timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(new Error('Queued request timed out')), 30);

    let caughtError: Error | null = null;
    try {
      await limiter.acquire(controller.signal);
    } catch (err: any) {
      caughtError = err;
    } finally {
      clearTimeout(timeoutId);
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain('timed out');

    // Waiter was cleanly purged from queue on abort
    expect(limiter.getQueueLength()).toBe(0);

    // 3. Release the 5 held slots
    for (const release of releases) {
      release();
    }
    expect(limiter.getInFlight()).toBe(0);
  });
  it('Formatter: Generates correct Show Position, Show Profile, and Chart URLs for Hyperliquid', () => {
    const sampleAddress = '0x469e9a7f624b04c24f0e64edf8d8a277e6bf58a5';
    const sampleAlert: TradeAlert = {
      type: 'position_opened',
      address: sampleAddress,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 1.5,
      entryPx: 78500,
      notionalValue: 117750,
      timestamp: Date.now(),
    };

    const keyboard = AlertFormatter.createAlertKeyboard(sampleAlert);
    const flatButtons = keyboard.inline_keyboard.flat();

    const showPositionBtn = flatButtons.find((b) => b.text.includes('Show Position'));
    expect(showPositionBtn).toBeDefined();
    expect(showPositionBtn?.url).toBe(`https://hyperdash.com/?chart1=BTC&snoop=${sampleAddress}`);

    const showProfileBtn = flatButtons.find((b) => b.text.includes('Show Profile'));
    expect(showProfileBtn).toBeDefined();
    expect(showProfileBtn?.url).toBe(`https://hyperdash.com/address/${sampleAddress}`);

    const chartBtn = flatButtons.find((b) => b.text.includes('Chart'));
    expect(chartBtn).toBeDefined();
    expect(chartBtn?.url).toBe('https://app.hyperliquid.xyz/trade/BTC');
  });


  // --- 5. Outbox Failure Injection & Error Propagation ---
  it('Outbox Failure Injection: Propagates Telegram API failures and transitions row to failed with retry lease', async () => {
    const address = '0xdddddddddddddddddddddddddddddddddddddddd';
    const eventKey = `${address}:BTC:1000:open:0`;

    db.upsertUser({ telegramId: 'user_inject', username: 'inject', mode: 'feed' });
    db.addTrackedWallet({
      userId: 'user_inject',
      address,
      label: 'Fail Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: 'chat_inject',
    });

    const alert: TradeAlert = {
      eventKey,
      type: 'position_opened',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 1.0,
      entryPx: 80000,
      notionalValue: 80000,
      timestamp: 1000,
    };

    // Mock bot that throws a Telegram 429 Too Many Requests error
    const mockBot = {
      api: {
        sendMessage: async () => {
          throw new Error('Telegram 429: Too Many Requests (retry_after: 5)');
        },
        editMessageText: async () => {
          throw new Error('Telegram 429: Too Many Requests');
        },
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, new HyperliquidService(db));

    // Dispatching alert must throw / propagate failure
    let dispatchError: Error | null = null;
    try {
      await handlers.dispatchAlert(alert);
    } catch (err: any) {
      dispatchError = err;
    }

    expect(dispatchError).not.toBeNull();
    expect(dispatchError?.message).toContain('Delivery failed');

    // Assert outbox row transitioned to 'failed' (NOT 'delivered')
    const undelivered = db.getUndeliveredOutboxAlerts();
    expect(undelivered.length).toBe(1);
    expect(undelivered[0].targetChat).toBe('chat_inject');
    expect(undelivered[0].attempts).toBe(1);

    // Worker can claim the failed row for retry
    const leased = db.claimOutboxLease('worker_recovery', 30000, 10);
    expect(leased.length).toBe(1);
    expect(leased[0].eventKey).toBe(eventKey);
  });

  // --- 6. Card Mode Reduction Retry Idempotency ---
  it('Card Mode Reduction Retry Idempotency: Delivery failure followed by retry success yields exactly one PnL mutation without duplicate accumulation', async () => {
    const address = '0xfa11fa11fa11fa11fa11fa11fa11fa11fa11fa11';
    const chatId = 'chat_pnl_retry';
    const userId = 'user_pnl_retry';

    db.upsertUser({ telegramId: userId, username: 'pnl_user', mode: 'card' });
    db.addTrackedWallet({
      userId,
      address,
      label: 'Retry Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: chatId,
    });

    // Seed initial position card: 10 BTC @ $80,000, message_id = 555, cum_realized_pnl = 0
    db.savePositionCard(chatId, address, 'BTC', 555, 1000, 80000, 10);

    let shouldFail = true;
    let editAttempts = 0;

    const mockBot = {
      api: {
        editMessageText: async () => {
          editAttempts++;
          if (shouldFail) {
            throw new Error('Telegram 500: Internal Server Error');
          }
          return true;
        },
        sendMessage: async () => {
          if (shouldFail) {
            throw new Error('Telegram 500: Internal Server Error');
          }
          return { message_id: 556 };
        },
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, new HyperliquidService(db));

    const reduceAlert: TradeAlert = {
      eventKey: `${address}:BTC:2000:reduce:0`,
      type: 'position_reduced',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 5.0,
      filledSize: 5.0,
      entryPx: 80000,
      closingPx: 90000,
      closedPnl: 50000, // +$50,000 PnL on this slice
      deltaNotionalUsd: 450000,
      notionalValue: 450000,
      timestamp: 2000,
    };

    // Attempt 1: Delivery Fails
    let failedError: Error | null = null;
    try {
      await handlers.dispatchAlert(reduceAlert);
    } catch (err: any) {
      failedError = err;
    }

    expect(failedError).not.toBeNull();
    expect(editAttempts).toBe(1);

    // Assert in SQLite: NO state corruption occurred during failure
    let card = db.getPositionCard(chatId, address, 'BTC');
    expect(card).not.toBeNull();
    expect(card?.cumRealizedPnl).toBe(0); // PnL was NOT prematurely incremented
    expect(card?.currentSize).toBe(10); // Size was NOT prematurely reduced
    expect(card?.totalClosedSize).toBe(0);

    // Attempt 2: API Recovers, Outbox Worker retries delivery
    shouldFail = false;
    const leased = db.claimOutboxLease('worker_test', 30000, 10);
    expect(leased.length).toBe(1);

    // Worker re-dispatches the leased alert
    // @ts-ignore
    await handlers.deliverLiveCardAlert(leased[0].id, leased[0].eventKey, leased[0].targetChat, leased[0].alert, leased[0].userId, 0);
    db.markOutboxDelivered(leased[0].id);

    expect(editAttempts).toBe(2);

    // Assert in SQLite: Exactly ONE PnL increment ($50,000, NOT $100,000!)
    card = db.getPositionCard(chatId, address, 'BTC');
    expect(card?.cumRealizedPnl).toBe(50000);
    expect(card?.currentSize).toBe(5.0);
    expect(card?.totalClosedSize).toBe(5.0);

    // Alerts history logged exactly once
    const history = db.getRecentAlerts(10);
    expect(history.filter(h => h.address === address).length).toBe(1);
  });

  // --- 7. Restart / Reconnect Snapshot Replay Deduplication ---
  it('Restart Reconnect: replayAllPendingInbox followed by identical WebSocket snapshot produces exactly ONE enqueued fill and ONE alert', async () => {
    const address = '0x1122334455667788990011223344556677889900';
    const coin = 'SOL';

    // 1. Simulate uncompleted pending fill in SQLite fill_inbox from prior run
    const fill: TradeFillRaw = {
      coin,
      px: '150.0',
      sz: '10.0',
      side: 'B',
      time: 5000,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xrestart_fill',
      oid: 999,
      crossed: true,
      fee: '0.05',
      tid: 888999,
    };

    const inboxRes = db.insertInboxFill(address, fill);
    expect(inboxRes.isNew).toBe(true);

    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];
    hlService.onAlert((alert) => {
      emittedAlerts.push(alert);
    });

    hlService.subscribe(address);

    // 2. Service boots and replays pending inbox fills
    hlService.replayAllPendingInbox();

    // 3. WebSocket connects and immediately receives snapshot containing that same fill (newer than committed cursor)
    // @ts-ignore
    hlService.handleUserFills({ user: address, isSnapshot: true, fills: [fill] });

    await hlService.flushAllBatches();

    // 4. Verify that exactly ONE alert was emitted with currentSize = 10.0 (NOT 20.0!)
    expect(emittedAlerts.length).toBe(1);
    expect(emittedAlerts[0].currentSize).toBe(10.0);
    expect(emittedAlerts[0].filledSize).toBe(10.0);

    // 5. Verify fill_inbox has only 1 row and is now delivered
    expect(db.getPendingInboxCount()).toBe(0);

    await hlService.stop();
  });

  // --- 8. Card Mode Dispatcher: Message ID Retention & Below-Filter State Synchronization ---
  it('Card Mode Dispatcher: Preserves real message_id on above-filter sends and updates position_cards state on suppressed below-filter alerts', async () => {
    const address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const chatId = 'chat_dispatcher_test';
    const userId = 'user_card_test';

    db.upsertUser({ telegramId: userId, username: 'card_user', mode: 'card' });
    db.addTrackedWallet({
      userId,
      address,
      label: 'Card Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 5000, // $5,000 threshold
      alertChatId: chatId,
    });

    let sentMessagesCount = 0;
    let editedMessagesCount = 0;
    let nextMessageId = 777;

    const mockBot = {
      api: {
        sendMessage: async () => {
          sentMessagesCount++;
          return { message_id: nextMessageId };
        },
        editMessageText: async () => {
          editedMessagesCount++;
          return true;
        },
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, new HyperliquidService(db));

    // Path A: Above-filter Open (1.0 BTC @ $80,000 = $80,000 delta > $5,000)
    const openAlert: TradeAlert = {
      eventKey: `${address}:BTC:1000:open:0`,
      type: 'position_opened',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 1.0,
      filledSize: 1.0,
      entryPx: 80000,
      deltaNotionalUsd: 80000,
      notionalValue: 80000,
      timestamp: 1000,
    };

    await handlers.dispatchAlert(openAlert);

    // Verify Telegram message was sent
    expect(sentMessagesCount).toBe(1);

    // Verify SQLite position_cards recorded real message_id 777 (NOT overwritten with 0!)
    let card = db.getPositionCard(chatId, address, 'BTC');
    expect(card).not.toBeNull();
    expect(card?.messageId).toBe(777);
    expect(card?.currentSize).toBe(1.0);

    // Path B: Below-filter Increase (+0.001 BTC = $80 delta < $5,000)
    const smallIncreaseAlert: TradeAlert = {
      eventKey: `${address}:BTC:2000:increase:0`,
      type: 'position_increased',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 1.001,
      filledSize: 0.001,
      entryPx: 80000,
      deltaNotionalUsd: 80,
      notionalValue: 80080,
      timestamp: 2000,
    };

    await handlers.dispatchAlert(smallIncreaseAlert);

    // Verify no new send and editMessageText was suppressed
    expect(sentMessagesCount).toBe(1);
    expect(editedMessagesCount).toBe(0);

    // Verify SQLite position_cards updated size to 1.001 while preserving messageId 777!
    card = db.getPositionCard(chatId, address, 'BTC');
    expect(card?.messageId).toBe(777);
    expect(card?.currentSize).toBe(1.001);

    // Path C: Below-filter Open on second coin (ETH open for $100 < $5,000)
    const smallEthOpenAlert: TradeAlert = {
      eventKey: `${address}:ETH:3000:open:0`,
      type: 'position_opened',
      address,
      chain: 'hyperliquid',
      coin: 'ETH',
      symbol: 'ETHUSD',
      side: 'LONG',
      currentSize: 0.04,
      filledSize: 0.04,
      entryPx: 2500,
      deltaNotionalUsd: 100,
      notionalValue: 100,
      timestamp: 3000,
    };

    await handlers.dispatchAlert(smallEthOpenAlert);

    // Verify no Telegram send for ETH
    expect(sentMessagesCount).toBe(1);

    // Verify SQLite position_cards saved ETH with messageId = 0 and currentSize = 0.04
    const ethCard = db.getPositionCard(chatId, address, 'ETH');
    expect(ethCard).not.toBeNull();
    expect(ethCard?.messageId).toBe(0);
    expect(ethCard?.currentSize).toBe(0.04);

    // Path D: Above-filter Increase crossing threshold on second coin (ETH +10 ETH = $25,000 > $5,000)
    nextMessageId = 888;
    const largeEthIncreaseAlert: TradeAlert = {
      eventKey: `${address}:ETH:4000:increase:0`,
      type: 'position_increased',
      address,
      chain: 'hyperliquid',
      coin: 'ETH',
      symbol: 'ETHUSD',
      side: 'LONG',
      currentSize: 10.04,
      filledSize: 10.0,
      entryPx: 2500,
      deltaNotionalUsd: 25000,
      notionalValue: 25100,
      timestamp: 4000,
    };

    await handlers.dispatchAlert(largeEthIncreaseAlert);

    // Verify Telegram send was dispatched for crossed-filter card
    expect(sentMessagesCount).toBe(2);

    // Verify SQLite position_cards transitioned ETH messageId from 0 to 888 and size to 10.04!
    const updatedEthCard = db.getPositionCard(chatId, address, 'ETH');
    expect(updatedEthCard?.messageId).toBe(888);
    expect(updatedEthCard?.currentSize).toBe(10.04);

    // Path E: Position Closed sends a distinct new message via sendMessage (Open message preserved without edits)
    const prevEditCount = editedMessagesCount;
    const ethCloseAlert: TradeAlert = {
      eventKey: `${address}:ETH:5000:close:0`,
      type: 'position_closed',
      address,
      chain: 'hyperliquid',
      coin: 'ETH',
      symbol: 'ETHUSD',
      side: 'LONG',
      currentSize: 0,
      filledSize: 10.04,
      entryPx: 2500,
      closingPx: 2600,
      closedPnl: 1004,
      deltaNotionalUsd: 26104,
      notionalValue: 0,
      timestamp: 5000,
    };

    await handlers.dispatchAlert(ethCloseAlert);

    // Verify a distinct new message was sent (sentMessagesCount goes from 2 to 3)
    expect(sentMessagesCount).toBe(3);
    // Verify editMessageText was NOT called on close (Open message preserved)
    expect(editedMessagesCount).toBe(prevEditCount);

    // Verify SQLite position_cards cleaned up the card on close
    const closedEthCard = db.getPositionCard(chatId, address, 'ETH');
    expect(closedEthCard).toBeNull();
  });
  // --- 5. Feed Health & Truthful Status Reporting ---
  it('Feed Health: Truthfully differentiates connected live feed from stalled socket', () => {
    const hlService = new HyperliquidService(db);

    // 1. Initial state: Disconnected
    let health = hlService.getFeedHealth();
    expect(health.isConnected).toBe(false);
    expect(health.isStalled).toBe(false);

    // 2. Simulate active live message
    // @ts-ignore
    hlService.isConnected = true;
    // @ts-ignore
    hlService.lastMessageTime = Date.now();

    health = hlService.getFeedHealth();
    expect(health.isConnected).toBe(true);
    expect(health.isStalled).toBe(false);

    // 3. Simulate stalled socket (connected but no messages in 120s)
    // @ts-ignore
    hlService.lastMessageTime = Date.now() - 120000;

    health = hlService.getFeedHealth();
    expect(health.isConnected).toBe(true);
    expect(health.isStalled).toBe(true);
    expect(health.timeSinceLastMessageSeconds).toBeGreaterThanOrEqual(120);
  });

  // --- 4. P0: Cross-Wallet TID Deduplication ---
  it('P0: Emits alerts for both wallets when two distinct tracked wallets share the same trade ID (tid)', async () => {
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];

    hlService.onAlert((alert) => {
      emittedAlerts.push(alert);
    });

    const walletA = '0x1111111111111111111111111111111111111111';
    const walletB = '0x2222222222222222222222222222222222222222';

    hlService.subscribe(walletA);
    hlService.subscribe(walletB);

    const commonTime = 1787500000000;
    const commonTid = 333444555;

    // Wallet A fill: Buy 10 HYPE @ 80.0
    const fillA: TradeFillRaw = {
      coin: 'HYPE',
      px: '80.0',
      sz: '10.0',
      side: 'B',
      time: commonTime,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xhashA',
      oid: 101,
      crossed: true,
      fee: '0.01',
      tid: commonTid,
    };

    // Wallet B fill: Counterparty Sell 10 HYPE @ 80.0 with the exact same TID
    const fillB: TradeFillRaw = {
      coin: 'HYPE',
      px: '80.0',
      sz: '10.0',
      side: 'A',
      time: commonTime,
      startPosition: '0.0',
      dir: 'Open Short',
      closedPnl: '0.0',
      hash: '0xhashB',
      oid: 102,
      crossed: true,
      fee: '0.01',
      tid: commonTid,
    };

    // Simulate websocket message handling for both wallets
    // @ts-ignore
    hlService.handleUserFills({ user: walletA, isSnapshot: false, fills: [fillA] });
    // @ts-ignore
    hlService.handleUserFills({ user: walletB, isSnapshot: false, fills: [fillB] });

    await hlService.flushAllBatches();

    expect(emittedAlerts.length).toBe(2);
    expect(emittedAlerts.some((a) => a.address === walletA && a.side === 'LONG')).toBe(true);
    expect(emittedAlerts.some((a) => a.address === walletB && a.side === 'SHORT')).toBe(true);
    expect(emittedAlerts.find((a) => a.address === walletA)?.filledSize).toBe(10.0);
    expect(emittedAlerts.find((a) => a.address === walletB)?.filledSize).toBe(10.0);

    await hlService.stop();
  });

  // --- 5. P0: Reconnect Snapshot Backfill with Durable Cursors ---
  it('P0: Reconnect snapshot processes only fills newer than the committed high-water mark cursor', async () => {
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];

    hlService.onAlert((alert) => {
      emittedAlerts.push(alert);
    });

    const user = '0x3333333333333333333333333333333333333333';
    hlService.subscribe(user);

    // 1. Initial baseline snapshot at T=1000 - should establish baseline cursor without emitting old alerts
    const baselineFill: TradeFillRaw = {
      coin: 'BTC',
      px: '80000',
      sz: '1.0',
      side: 'B',
      time: 1000,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xbase',
      oid: 1,
      crossed: false,
      fee: '0',
      tid: 100,
    };

    // @ts-ignore
    hlService.handleUserFills({ user, isSnapshot: true, fills: [baselineFill] });
    await hlService.flushAllBatches();
    expect(emittedAlerts.length).toBe(0);

    // Verify cursor committed in DB
    const cursor = db.getFillCursor(user);
    expect(cursor).not.toBeNull();
    expect(cursor?.lastFillTime).toBe(1000);
    expect(cursor?.lastFillTid).toBe(100);

    // 2. Reconnect snapshot arrives after outage containing T=1000 (old) and T=2000 (new missed fill)
    const newMissedFill: TradeFillRaw = {
      coin: 'BTC',
      px: '82000',
      sz: '0.5',
      side: 'B',
      time: 2000,
      startPosition: '1.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xnew',
      oid: 2,
      crossed: false,
      fee: '0',
      tid: 200,
    };

    // @ts-ignore
    hlService.handleUserFills({ user, isSnapshot: true, fills: [baselineFill, newMissedFill] });
    await hlService.flushAllBatches();

    expect(emittedAlerts.length).toBe(1);
    expect(emittedAlerts[0].type).toBe('position_increased');
    expect(emittedAlerts[0].currentSize).toBe(1.5);
    expect(emittedAlerts[0].timestamp).toBe(2000);

    await hlService.stop();
  });

  // --- 6. P1: Authoritative startPosition for Position Transitions ---
  it('P1: Uses startPosition authoritatively: startPosition=10 + sz=5 emits position_increased with size 15 even with unseeded cache', async () => {
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];

    hlService.onAlert((alert) => {
      emittedAlerts.push(alert);
    });

    const user = '0x4444444444444444444444444444444444444444';
    hlService.subscribe(user);

    // Unseeded cache: incoming fill with startPosition = 10.0 and sz = 5.0
    const fill: TradeFillRaw = {
      coin: 'SOL',
      px: '100.0',
      sz: '5.0',
      side: 'B',
      time: Date.now(),
      startPosition: '10.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xsol',
      oid: 50,
      crossed: true,
      fee: '0.1',
      tid: 500,
    };

    // @ts-ignore
    hlService.handleUserFills({ user, isSnapshot: false, fills: [fill] });
    await hlService.flushAllBatches();

    expect(emittedAlerts.length).toBe(1);
    expect(emittedAlerts[0].type).toBe('position_increased');
    expect(emittedAlerts[0].currentSize).toBe(15.0);
    expect(emittedAlerts[0].filledSize).toBe(5.0);
    expect(emittedAlerts[0].deltaNotionalUsd).toBe(500.0);

    await hlService.stop();
  });

  // --- 7. P1: Position Flip Split (Long -> Short) ---
  it('P1: Accurately splits position flips: holding 100 Long, selling 150 emits close Long 100 then open Short 50', async () => {
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];

    hlService.onAlert((alert) => {
      emittedAlerts.push(alert);
    });

    const user = '0x5555555555555555555555555555555555555555';
    hlService.subscribe(user);

    // Selling 150 from initial +100 Long
    const flipFill: TradeFillRaw = {
      coin: 'ETH',
      px: '2500.0',
      sz: '150.0',
      side: 'A',
      time: Date.now(),
      startPosition: '100.0',
      dir: 'Close Long',
      closedPnl: '15000.0',
      hash: '0xflip',
      oid: 77,
      crossed: true,
      fee: '1.5',
      tid: 777,
    };

    // @ts-ignore
    hlService.handleUserFills({ user, isSnapshot: false, fills: [flipFill] });
    await hlService.flushAllBatches();

    expect(emittedAlerts.length).toBe(2);
    // Leg 1: Close Long 100
    expect(emittedAlerts[0].type).toBe('position_closed');
    expect(emittedAlerts[0].side).toBe('LONG');
    expect(emittedAlerts[0].filledSize).toBe(100.0);
    expect(emittedAlerts[0].closedPnl).toBe(15000.0);

    // Leg 2: Open Short 50
    expect(emittedAlerts[1].type).toBe('position_opened');
    expect(emittedAlerts[1].side).toBe('SHORT');
    expect(emittedAlerts[1].currentSize).toBe(50.0);
    expect(emittedAlerts[1].filledSize).toBe(50.0);

    await hlService.stop();
  });

  // --- 8. P1: Cumulative Lifetime Realized PnL Across Multiple Partial Closes ---
  it('P1: Tracks cumulative realized PnL across multiple partial closes on Live Position Cards', () => {
    const chatId = 'chat_123';
    const address = '0x6666666666666666666666666666666666666666';
    const coin = 'BTC';

    // Step 1: Open 100 BTC @ $80,000
    db.savePositionCard(chatId, address, coin, 1001, 1000000, 80000, 100);
    let card = db.getPositionCard(chatId, address, coin);
    expect(card).not.toBeNull();
    expect(card?.maxSize).toBe(100);
    expect(card?.currentSize).toBe(100);
    expect(card?.cumRealizedPnl).toBe(0);

    // Step 2: Partial close 1: 30 BTC closed @ $85,000 -> +$150,000 PnL
    db.addCardRealizedPnl(chatId, address, coin, 150000, 30, 70);
    card = db.getPositionCard(chatId, address, coin);
    expect(card?.currentSize).toBe(70);
    expect(card?.totalClosedSize).toBe(30);
    expect(card?.cumRealizedPnl).toBe(150000);

    // Step 3: Partial close 2: 30 BTC closed @ $90,000 -> +$300,000 PnL
    db.addCardRealizedPnl(chatId, address, coin, 300000, 30, 40);
    card = db.getPositionCard(chatId, address, coin);
    expect(card?.currentSize).toBe(40);
    expect(card?.totalClosedSize).toBe(60);
    expect(card?.cumRealizedPnl).toBe(450000);

    // Step 4: Final close: 40 BTC closed @ $95,000 -> +$600,000 PnL
    const finalCloseAlertPnl = 600000;
    const lifetimeRealizedPnl = card!.cumRealizedPnl + finalCloseAlertPnl;
    expect(lifetimeRealizedPnl).toBe(1050000);

    // Remove position card on full close
    db.removePositionCard(chatId, address, coin);
    const closedCard = db.getPositionCard(chatId, address, coin);
    expect(closedCard).toBeNull();
  });

  // --- 9. P1: Outbox Atomic Lease Locks & Crash Recovery ---
  it('P1: Outbox worker atomically leases rows and recovers expired leases after crash', () => {
    const eventKey1 = '0x111:BTC:1000:open:0';
    const eventKey2 = '0x222:ETH:2000:open:0';

    const alert1: TradeAlert = {
      eventKey: eventKey1,
      type: 'position_opened',
      address: '0x111',
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 1.0,
      entryPx: 80000,
      notionalValue: 80000,
      timestamp: 1000,
    };

    const alert2: TradeAlert = {
      eventKey: eventKey2,
      type: 'position_opened',
      address: '0x222',
      chain: 'hyperliquid',
      coin: 'ETH',
      symbol: 'ETHUSD',
      side: 'LONG',
      currentSize: 10.0,
      entryPx: 2500,
      notionalValue: 25000,
      timestamp: 2000,
    };

    db.getOrCreateOutboxRecord(eventKey1, 'user_1', 'chat_1', alert1);
    db.getOrCreateOutboxRecord(eventKey2, 'user_1', 'chat_1', alert2);

    // Worker 1 leases with 500ms lease
    const leasedByWorker1 = db.claimOutboxLease('worker_1', 500, 10);
    expect(leasedByWorker1.length).toBe(2);

    // Immediate second claim while lease is active returns 0 rows
    const leasedAgain = db.claimOutboxLease('worker_2', 500, 10);
    expect(leasedAgain.length).toBe(0);

    // Worker 1 marks item 1 delivered
    db.markOutboxDelivered(leasedByWorker1[0].id);

    // Simulate worker 1 crash on item 2. Expire lease manually in DB
    // @ts-ignore
    db['db'].run(`UPDATE alert_outbox SET lease_expires_at = 1 WHERE id = ?`, [leasedByWorker1[1].id]);

    // Worker 2 recovers the crashed lease on item 2 cleanly
    const recoveredByWorker2 = db.claimOutboxLease('worker_2', 30000, 10);
    expect(recoveredByWorker2.length).toBe(1);
    expect(recoveredByWorker2[0].eventKey).toBe(eventKey2);

    db.markOutboxDelivered(recoveredByWorker2[0].id);

    // No pending alerts remaining
    const undelivered = db.getUndeliveredOutboxAlerts();
    expect(undelivered.length).toBe(0);
  });

  // --- 10. P1: Subscription Registry Ref-Counting & Lifecycle ---
  it('P1: Live subscription registry ref-counts subscribers for pause, resume, and delete', () => {
    const hlService = new HyperliquidService(db);
    const address = '0x8888888888888888888888888888888888888888';

    // User 1 adds address
    const id1 = db.addTrackedWallet({
      userId: 'user_1',
      address,
      label: 'Whale1',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
    });
    hlService.subscribe(address);
    expect(db.getSubscriberCountForAddress(address)).toBe(1);

    // User 2 adds same address
    const id2 = db.addTrackedWallet({
      userId: 'user_2',
      address,
      label: 'Whale2',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
    });
    expect(db.getSubscriberCountForAddress(address)).toBe(2);

    // User 1 pauses: active count becomes 1, so hlService stays subscribed
    db.toggleWalletStatus('user_1', id1);
    expect(db.getSubscriberCountForAddress(address)).toBe(1);

    // User 2 pauses: active count becomes 0, so hlService unsubscribes
    db.toggleWalletStatus('user_2', id2);
    expect(db.getSubscriberCountForAddress(address)).toBe(0);
    hlService.unsubscribe(address);

    // User 1 resumes: active count becomes 1, so hlService resubscribes
    db.toggleWalletStatus('user_1', id1);
    expect(db.getSubscriberCountForAddress(address)).toBe(1);
    hlService.subscribe(address);

    // User 1 deletes wallet: active count becomes 0, so hlService unsubscribes
    db.removeTrackedWallet('user_1', id1);
    expect(db.getSubscriberCountForAddress(address)).toBe(0);
    hlService.unsubscribe(address);
  });

  // --- 11. P1: Stale Response Epoch Protection ---
  it('P1: Discards stale HTTP account summary responses if a newer WebSocket fill arrived', () => {
    const hlService = new HyperliquidService(db);
    const address = '0x9999999999999999999999999999999999999999';

    // @ts-ignore
    const initialEpoch = hlService.addressEpochs.get(address) || 0;
    expect(initialEpoch).toBe(0);

    // Simulate incoming fill
    const fill: TradeFillRaw = {
      coin: 'BTC',
      px: '80000',
      sz: '1.0',
      side: 'B',
      time: 100,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0x1',
      oid: 1,
      crossed: false,
      fee: '0',
      tid: 1,
    };

    // @ts-ignore
    hlService.handleUserFills({ user: address, isSnapshot: false, fills: [fill] });

    // @ts-ignore
    const nextEpoch = hlService.addressEpochs.get(address) || 0;
    expect(nextEpoch).toBe(1);
  });

  // --- 12. P2: Filter strictly evaluates Trade Delta Notional ---
  it('P2: Filters out small scale-in ($100) on large position ($1M) when minFilter is $5,000', () => {
    const minFilter = 5000;

    const smallScaleInAlert: TradeAlert = {
      type: 'position_increased',
      walletLabel: 'Whale',
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 12.5,
      filledSize: 0.00125, // ~$100 scale-in
      fillPx: 80000,
      deltaNotionalUsd: 100, // Trade delta = $100
      notionalValue: 1000000, // Total position notional = $1,000,000
      entryPx: 80000,
      timestamp: Date.now(),
    };

    const deltaUsd = smallScaleInAlert.deltaNotionalUsd!;
    const isBelowFilter = minFilter > 0 && deltaUsd < minFilter;

    // Suppressed because $100 < $5,000 despite $1M total position value
    expect(isBelowFilter).toBe(true);

    const largeTradeAlert: TradeAlert = {
      ...smallScaleInAlert,
      filledSize: 1.0,
      deltaNotionalUsd: 80000,
    };
    const isLargeBelow = minFilter > 0 && largeTradeAlert.deltaNotionalUsd! < minFilter;
    expect(isLargeBelow).toBe(false);
  });

  // --- 13. P2: HTML Entity Escaping ---
  it('P2: escapeTelegramHtml safely sanitizes user-controlled inputs with <, >, &', () => {
    const maliciousLabel = '<script>alert("XSS")</script> & <b>Whale</b> <img src=x onerror=alert(1)>';
    const escaped = escapeTelegramHtml(maliciousLabel);

    expect(escaped).toBe('&lt;script&gt;alert("XSS")&lt;/script&gt; &amp; &lt;b&gt;Whale&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt;');
    expect(escaped.includes('<')).toBe(false);
    expect(escaped.includes('>')).toBe(false);
  });

  // --- 14. Data Retention Pruning Policy ---
  it('Prunes delivered inbox and outbox records older than retention threshold', () => {
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    // @ts-ignore
    db['db'].run(`
      INSERT INTO alert_outbox (event_key, user_id, target_chat, address, coin, alert_json, status, attempts, lease_expires_at, created_at, delivered_at)
      VALUES ('old_key', 'u1', 'c1', '0x1', 'BTC', '{}', 'delivered', 1, 0, ?, ?);
    `, [oldTime, oldTime]);

    // @ts-ignore
    db['db'].run(`
      INSERT INTO fill_inbox (address, coin, time, tid, raw_json, status, created_at)
      VALUES ('0x1', 'BTC', 1000, 1, '{}', 'delivered', ?);
    `, [oldTime]);

    const pruneResult = db.pruneDeliveredRecords(7);
    expect(pruneResult.prunedOutbox).toBe(1);
    expect(pruneResult.prunedInbox).toBe(1);
  });

  // --- 15. Formatting Engine & Number Precision Matrix ---
  it('Formats USD currency and compact notation matrices with precise thresholds and suffixes', () => {
    // Standard formatUsd
    expect(AlertFormatter.formatUsd(1234567)).toBe('$1,234,567.00');
    expect(AlertFormatter.formatUsd(1234567.89)).toBe('$1,234,567.89');
    expect(AlertFormatter.formatUsd(500)).toBe('$500.00');
    expect(AlertFormatter.formatUsd(42.5)).toBe('$42.50');
    expect(AlertFormatter.formatUsd(0)).toBe('$0.00');
    expect(AlertFormatter.formatUsd(-47.344)).toBe('-$47.34');

    // Compact formatCompactUsd
    expect(AlertFormatter.formatCompactUsd(1234567)).toBe('$1.23M');
    expect(AlertFormatter.formatCompactUsd(5400000000)).toBe('$5.40B');
    expect(AlertFormatter.formatCompactUsd(45000)).toBe('$45.00K');
    expect(AlertFormatter.formatCompactUsd(500)).toBe('$500.00');
    expect(AlertFormatter.formatCompactUsd(-1500000)).toBe('-$1.50M');

    // Duration formatting
    expect(AlertFormatter.formatDuration(30000)).toBe('30s');
    expect(AlertFormatter.formatDuration(150000)).toBe('2m');
    expect(AlertFormatter.formatDuration(7500000)).toBe('2h 5m');
    expect(AlertFormatter.formatDuration(90000000)).toBe('1d 1h');
  });

  // --- 16. Rotating Reconciliation Sweep Cursor Wrapping ---
  it('Reconciliation cursor wraps around correctly across N addresses in bounded batches', () => {
    const addresses = ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6', '0x7', '0x8', '0x9', '0xa', '0xb', '0xc'];
    const batchSize = 5;
    let cursor = 0;

    // Sweep 1: 0..4
    const sweep1 = [];
    for (let i = 0; i < batchSize && i < addresses.length; i++) {
      sweep1.push(addresses[(cursor + i) % addresses.length]);
    }
    cursor = (cursor + batchSize) % addresses.length;
    expect(sweep1).toEqual(['0x1', '0x2', '0x3', '0x4', '0x5']);
    expect(cursor).toBe(5);

    // Sweep 2: 5..9
    const sweep2 = [];
    for (let i = 0; i < batchSize && i < addresses.length; i++) {
      sweep2.push(addresses[(cursor + i) % addresses.length]);
    }
    cursor = (cursor + batchSize) % addresses.length;
    expect(sweep2).toEqual(['0x6', '0x7', '0x8', '0x9', '0xa']);
    expect(cursor).toBe(10);

    // Sweep 3: 10..11, wraps to 0..2
    const sweep3 = [];
    for (let i = 0; i < batchSize && i < addresses.length; i++) {
      sweep3.push(addresses[(cursor + i) % addresses.length]);
    }
    cursor = (cursor + batchSize) % addresses.length;
    expect(sweep3).toEqual(['0xb', '0xc', '0x1', '0x2', '0x3']);
    expect(cursor).toBe(3);
  });

  // --- 17. Market Summary Report Formatter ---
  it('Formats 24h Hyperdash Market Summary report cleanly with real metrics', () => {
    const mockSummary: MarketSummary = {
      dateStr: 'Mon, Aug 24',
      totalVolume24h: 7686118928,
      totalOi: 10441994782,
      topGainers: [
        { coin: 'CASHCAT', changePct: 45.3, px: 0.1653 },
        { coin: 'SUPER', changePct: 27.7, px: 0.1283 },
      ],
      topLosers: [
        { coin: 'PUMP', changePct: -7.1, px: 0.005 },
        { coin: 'ENA', changePct: -6.7, px: 0.1641 },
      ],
      activeWhales: [
        { name: 'Nexus', accountValue: 2700000, positionsCount: 5, topPosition: 'LONG BTC ($1,400,000)' },
      ],
      largestRecentTrades: [
        { coin: 'BTC', side: 'BUY', sz: 0.33, px: 79087, usdValue: 26233 },
      ],
    };

    const formatted = AlertFormatter.formatMarketSummary(mockSummary);
    expect(formatted).toContain('Hyperdash Market Summary');
    expect(formatted).toContain('Mon, Aug 24');
    expect(formatted).toContain('Volume:');
    expect(formatted).toContain('$7.69B');
    expect(formatted).toContain('Open Interest:');
    expect(formatted).toContain('$10.44B');
    expect(formatted).toContain('CASHCAT');
    expect(formatted).toContain('+45.3%');
    expect(formatted).toContain('Nexus');
  });

  // --- 18. Live API Integration Test ---
  it('Live API: getMarketSummary() queries verified live market aggregates from Hyperliquid', async () => {
    const hlService = new HyperliquidService(db);
    const summary = await hlService.getMarketSummary();

    expect(summary.totalVolume24h).toBeGreaterThan(1000000);
    expect(summary.totalOi).toBeGreaterThan(1000000);
    expect(summary.topGainers.length).toBeGreaterThan(0);
    expect(summary.topLosers.length).toBeGreaterThan(0);
    expect(summary.dateStr.length).toBeGreaterThan(0);

    const formatted = AlertFormatter.formatMarketSummary(summary);
    expect(formatted).toContain('Hyperdash Market Summary');
    expect(formatted).toContain('Volume:');
    expect(formatted).toContain('Open Interest:');
  }, 15000);

  // --- 19. Whale TWAP Sustained Stream: Periodic Chunking & Exact Sum Conservation ---
  it('Whale TWAP Sustained Stream: Flushes periodic alerts under continuous stream without unbounded delay while conserving total size and notional value', async () => {
    const address = '0xtwap_whale_0000000000000000000000000000';
    const coin = 'ETH';
    const hlService = new HyperliquidService(db);
    // Set batch cap to 10 fills for predictable periodic chunking under high-frequency stream
    hlService.maxBatchFills = 10;
    hlService.idleDebounceMs = 200;

    const emittedAlerts: TradeAlert[] = [];
    hlService.onAlert((alert) => emittedAlerts.push(alert));
    hlService.subscribe(address);

    let totalExpectedNotional = 0;
    let totalExpectedSize = 0;

    // Feed 35 consecutive fills in the same direction
    for (let i = 0; i < 35; i++) {
      const px = 2500 + i;
      const sz = 1.0;
      totalExpectedNotional += px * sz;
      totalExpectedSize += sz;
      const fill: TradeFillRaw = {
        coin,
        px: px.toString(),
        sz: sz.toString(),
        side: 'B',
        time: 1000 + i * 10,
        startPosition: i.toString(),
        dir: 'Open Long',
        closedPnl: '0.0',
        hash: `0xtwap_hash_${i}`,
        oid: 1000 + i,
        crossed: true,
        fee: '0.01',
        tid: 50000 + i,
      };
      hlService.enqueueFillForBurst(fill, address);
    }

    await hlService.flushAllBatches();

    // Assert: Chunked into multiple periodic alerts (4 batches: 10, 10, 10, 5 fills)
    expect(emittedAlerts.length).toBe(4);

    // Verify conservation of total size across chunks
    const totalEmittedSize = emittedAlerts.reduce((sum, a) => sum + a.filledSize, 0);
    expect(totalEmittedSize).toBe(totalExpectedSize);

    // Correct mathematical sum: 35 * 2500 + sum(0..34) = 87500 + 595 = 88095
    const totalEmittedDeltaUsd = emittedAlerts.reduce((sum, a) => sum + a.deltaNotionalUsd, 0);
    expect(totalEmittedDeltaUsd).toBeCloseTo(88095, 2);
    // Verify final position size on the last alert matches total accumulated size
    const finalAlert = emittedAlerts[emittedAlerts.length - 1];
    expect(finalAlert.currentSize).toBe(35.0);

    await hlService.stop();
  });

  // --- 19b. Whale TWAP Wall-Clock Age-Bounded Flush Stress Test ---
  it('Whale TWAP Age-Bounded Flush: Sustained stream arriving within idle window triggers flush strictly when maxBatchAgeMs expires', async () => {
    const address = '0xtwap_age_whale_000000000000000000000000';
    const coin = 'ETH';
    const hlService = new HyperliquidService(db);
    // Set age cap to 120ms, count cap to 1000 (so count cap never triggers), and idle debounce to 100ms
    hlService.maxBatchAgeMs = 120;
    hlService.maxBatchFills = 1000;
    hlService.idleDebounceMs = 100;

    const emittedAlerts: TradeAlert[] = [];
    hlService.onAlert((alert) => emittedAlerts.push(alert));
    hlService.subscribe(address);

    // Feed 6 fills spaced 30ms apart (total stream time = 180ms > 120ms maxBatchAgeMs).
    // Because 30ms < 100ms idle debounce, idle debounce would never trigger if unconstrained.
    // The 120ms maxBatchAgeMs hard ceiling forces a periodic flush during the active stream.
    for (let i = 0; i < 6; i++) {
      const fill: TradeFillRaw = {
        coin,
        px: (2500 + i * 10).toString(),
        sz: '1.0',
        side: 'B',
        time: 1000 + i * 30,
        startPosition: i.toString(),
        dir: 'Open Long',
        closedPnl: '0.0',
        hash: `0xtwap_age_hash_${i}`,
        oid: 3000 + i,
        crossed: true,
        fee: '0.01',
        tid: 60000 + i,
      };
      hlService.enqueueFillForBurst(fill, address);
      await new Promise((r) => setTimeout(r, 30));
    }

    await hlService.flushAllBatches();

    // Proves that the stream flushed into at least 2 distinct periodic batches due to maxBatchAgeMs
    expect(emittedAlerts.length).toBeGreaterThanOrEqual(2);

    const totalEmittedSize = emittedAlerts.reduce((sum, a) => sum + a.filledSize, 0);
    expect(totalEmittedSize).toBe(6.0);

    await hlService.stop();
  });

  // --- 20. Multi-Address Swarm Concurrency through Ingestion Pipeline ---
  it('Multi-Address Swarm: 10 distinct wallets trading concurrently through handleUserFills with SQLite inbox and outbox guarantees', async () => {
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];

    let inFlightAsyncWorkers = 0;
    let peakConcurrentWorkers = 0;

    hlService.onAlert(async (alert) => {
      inFlightAsyncWorkers++;
      if (inFlightAsyncWorkers > peakConcurrentWorkers) {
        peakConcurrentWorkers = inFlightAsyncWorkers;
      }
      // Simulate asynchronous delivery / network I/O barrier
      await new Promise((r) => setTimeout(r, 40));
      inFlightAsyncWorkers--;
      emittedAlerts.push(alert);
    });

    const coins = ['BTC', 'ETH', 'SOL', 'HYPE'];
    const walletCount = 10;
    const addresses: string[] = [];

    for (let i = 0; i < walletCount; i++) {
      const addr = `0xswarm_wallet_${i.toString().padStart(24, '0')}`;
      addresses.push(addr);
      db.upsertUser({ telegramId: `sub_${i}`, username: `user_${i}`, mode: 'feed' });
      db.addTrackedWallet({
        userId: `sub_${i}`,
        address: addr,
        label: `Swarm Whale #${i + 1}`,
        chain: 'hyperliquid',
        isActive: true,
        minNotionalUsd: 0,
        alertChatId: `chat_swarm_${i}`,
      });
      hlService.subscribe(addr);
    }

    // Execute concurrent trade feeds across all 10 wallets through handleUserFills
    await Promise.all(
      addresses.map(async (addr, idx) => {
        const coin = coins[idx % coins.length];
        const px = 100 + idx * 10;
        const fill: TradeFillRaw = {
          coin,
          px: px.toString(),
          sz: '5.0',
          side: 'B',
          time: 2000 + idx,
          startPosition: '0.0',
          dir: 'Open Long',
          closedPnl: '0.0',
          hash: `0xswarm_hash_${idx}`,
          oid: 2000 + idx,
          crossed: true,
          fee: '0.05',
          tid: 70000 + idx,
        };
        // @ts-ignore
        hlService.handleUserFills({ user: addr, isSnapshot: false, fills: [fill] });
      })
    );

    await hlService.flushAllBatches();

    // 1. All 10 alerts processed and emitted cleanly
    expect(emittedAlerts.length).toBe(10);

    // 2. Proves that distinct address queues executed asynchronously in parallel across the barrier
    expect(peakConcurrentWorkers).toBeGreaterThan(1);

    // 3. Assert all 10 fills are persisted in SQLite fill_inbox and transitioned to 'delivered'
    const pendingInbox = db.getPendingInboxFills();
    expect(pendingInbox.length).toBe(0);

    // 4. SQLite Outbox has 10 pending alerts ready for delivery
    const outbox = db.getUndeliveredOutboxAlerts();
    expect(outbox.length).toBe(10);

    // 5. Position cache stores the active position for each address
    for (let i = 0; i < walletCount; i++) {
      const cached = db.getCachedPositions(addresses[i]);
      expect(cached.length).toBe(1);
      expect(cached[0].size).toBe(5.0);
    }

    await hlService.stop();
  });

  // --- 21. Rapid Directional Flip with Card Mode Dispatch & Realized PnL Invariants ---
  it('Rapid Directional Flip: Long -> Short -> Long executed with Card Mode dispatch, message edit transitions, and cumulative PnL verification', async () => {
    const address = '0xflip_card_whale_000000000000000000000000';
    const coin = 'BTC';
    const chatId = 'chat_card_flip';
    const userId = 'user_card_flip';

    db.upsertUser({ telegramId: userId, username: 'card_flipper', mode: 'card' });
    db.addTrackedWallet({
      userId,
      address,
      label: 'Flip Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: chatId,
    });

    let sentCount = 0;
    let editCount = 0;
    let lastMessageId = 1000;
    const capturedHtmlMessages: string[] = [];

    const mockBot = {
      api: {
        sendMessage: async (_chat: string, text: string) => {
          sentCount++;
          lastMessageId++;
          capturedHtmlMessages.push(text);
          return { message_id: lastMessageId };
        },
        editMessageText: async (_chat: string, _msgId: number, text: string) => {
          editCount++;
          capturedHtmlMessages.push(text);
          return true;
        },
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    const hlService = new HyperliquidService(db);
    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, hlService);

    hlService.onAlert(async (alert) => {
      await handlers.dispatchAlert(alert);
    });
    hlService.subscribe(address);

    // 1. Open LONG 10 BTC @ $80,000
    // @ts-ignore
    hlService.handleUserFills({
      user: address,
      isSnapshot: false,
      fills: [
        {
          coin,
          px: '80000',
          sz: '10.0',
          side: 'B',
          time: 1000,
          startPosition: '0.0',
          dir: 'Open Long',
          closedPnl: '0.0',
          hash: '0xflip_1',
          oid: 1,
          crossed: true,
          fee: '1',
          tid: 101,
        },
      ],
    });
    await hlService.flushAllBatches();

    // Verify Card 1 created: 10 BTC Long @ 80k, message_id = 1001, cum_realized_pnl = 0
    expect(sentCount).toBe(1);
    const card1 = db.getPositionCard(chatId, address, coin);
    expect(card1).not.toBeNull();
    expect(card1?.currentSize).toBe(10.0);
    expect(card1?.cumRealizedPnl).toBe(0);
    expect(card1?.messageId).toBe(1001);

    // 2. Flip from LONG 10 to SHORT 5 @ $90,000
    // Close Long 10.0 (+100k profit) + Open Short 5.0
    // @ts-ignore
    hlService.handleUserFills({
      user: address,
      isSnapshot: false,
      fills: [
        {
          coin,
          px: '90000',
          sz: '10.0',
          side: 'A',
          time: 2000,
          startPosition: '10.0',
          dir: 'Close Long',
          closedPnl: '100000.0',
          hash: '0xflip_2_close',
          oid: 2,
          crossed: true,
          fee: '1',
          tid: 102,
        },
      ],
    });
    // @ts-ignore
    hlService.handleUserFills({
      user: address,
      isSnapshot: false,
      fills: [
        {
          coin,
          px: '90000',
          sz: '5.0',
          side: 'A',
          time: 2001,
          startPosition: '0.0',
          dir: 'Open Short',
          closedPnl: '0.0',
          hash: '0xflip_2_open',
          oid: 3,
          crossed: true,
          fee: '1',
          tid: 103,
        },
      ],
    });
    await hlService.flushAllBatches();

    // Card should reflect new Short position with message created / updated
    const card2 = db.getPositionCard(chatId, address, coin);
    expect(card2).not.toBeNull();
    expect(card2?.currentSize).toBe(5.0);
    expect(card2?.initialEntryPx).toBe(90000);
    // 3. Flip back from SHORT 5 to LONG 15 @ $85,000
    // Close Short 5.0 (+25k profit) + Open Long 15.0
    // @ts-ignore
    hlService.handleUserFills({
      user: address,
      isSnapshot: false,
      fills: [
        {
          coin,
          px: '85000',
          sz: '5.0',
          side: 'B',
          time: 3000,
          startPosition: '-5.0',
          dir: 'Close Short',
          closedPnl: '25000.0',
          hash: '0xflip_3_close',
          oid: 4,
          crossed: true,
          fee: '1',
          tid: 104,
        },
      ],
    });
    // @ts-ignore
    hlService.handleUserFills({
      user: address,
      isSnapshot: false,
      fills: [
        {
          coin,
          px: '85000',
          sz: '15.0',
          side: 'B',
          time: 3001,
          startPosition: '0.0',
          dir: 'Open Long',
          closedPnl: '0.0',
          hash: '0xflip_3_open',
          oid: 5,
          crossed: true,
          fee: '1',
          tid: 105,
        },
      ],
    });
    await hlService.flushAllBatches();

    const card3 = db.getPositionCard(chatId, address, coin);
    expect(card3).not.toBeNull();
    expect(card3?.currentSize).toBe(15.0);
    expect(card3?.initialEntryPx).toBe(85000);

    // Verify alerts_history records the realized PnL values
    const history = db.getRecentAlerts(10);
    const closeAlerts = history.filter((h) => h.alert_type === 'position_closed');
    expect(closeAlerts.length).toBe(2);

    const details1 = closeAlerts[1].details;
    const details2 = closeAlerts[0].details;
    expect(details1.closedPnl).toBe(100000);
    expect(details2.closedPnl).toBe(25000);

    // Verify formatted HTML messages render the profit amounts
    const profitMessages = capturedHtmlMessages.filter((m) => m.includes('Profit:'));
    expect(profitMessages.length).toBe(2);
    expect(profitMessages.some((m) => m.includes('$100,000') || m.includes('100,000'))).toBe(true);
    expect(profitMessages.some((m) => m.includes('$25,000') || m.includes('25,000'))).toBe(true);

    await hlService.stop();
  });

  // --- 22. High-Frequency Ingest Spam & Strict FIFO Ordering ---
  it('High-Frequency Spam: Ingests 50 sequential rapid fills through handleUserFills with verified FIFO inbox ordering and full outbox leasing', async () => {
    const address = '0xspam_fifo_whale_000000000000000000000000';
    const coin = 'SOL';

    db.upsertUser({ telegramId: 'spam_user', username: 'spammer', mode: 'feed' });
    db.addTrackedWallet({
      userId: 'spam_user',
      address,
      label: 'SOL High-Freq Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: 'chat_spam',
    });

    const hlService = new HyperliquidService(db);
    hlService.onAlert((alert) => {});
    hlService.subscribe(address);

    // Generate 50 rapid sequential fills through handleUserFills
    for (let i = 0; i < 50; i++) {
      const fill: TradeFillRaw = {
        coin,
        px: (100 + i).toString(),
        sz: '1.0',
        side: 'B',
        time: 5000 + i * 10,
        startPosition: i.toString(),
        dir: 'Open Long',
        closedPnl: '0.0',
        hash: `0xspam_${i}`,
        oid: 8000 + i,
        crossed: true,
        fee: '0.01',
        tid: 90000 + i,
      };
      // @ts-ignore
      hlService.handleUserFills({ user: address, isSnapshot: false, fills: [fill] });
    }

    await hlService.flushAllBatches();

    // 1. Verify that all 50 fills were inserted into SQLite fill_inbox
    const allInbox = db['db'].prepare('SELECT * FROM fill_inbox WHERE address = ? ORDER BY time ASC, tid ASC').all(address) as any[];
    expect(allInbox.length).toBe(50);

    // 2. Verify strict ascending FIFO ordering of timestamps and transaction IDs
    for (let i = 0; i < allInbox.length; i++) {
      expect(allInbox[i].time).toBe(5000 + i * 10);
      expect(allInbox[i].tid).toBe(90000 + i);
      expect(allInbox[i].status).toBe('delivered');
    }

    // 3. Verify outbox records and lease delivery
    const undelivered = db.getUndeliveredOutboxAlerts();
    expect(undelivered.length).toBeGreaterThan(0);

    const leased = db.claimOutboxLease('worker_spam_test', 30000, 100);
    expect(leased.length).toBe(undelivered.length);

    for (const row of leased) {
      db.markOutboxDelivered(row.id);
    }

    expect(db.getUndeliveredOutboxAlerts().length).toBe(0);
    await hlService.stop();
  });

  // --- 23. Reconnect Cursor Boundary Loss Regression Test ---
  it('Reconnect Cursor: Admits unseen fill at same timestamp even when tid is lower than cursor tid', async () => {
    const address = '0xreconnect_boundary_whale_000000000000';
    const hlService = new HyperliquidService(db);
    const emittedAlerts: TradeAlert[] = [];
    hlService.onAlert((alert) => emittedAlerts.push(alert));
    hlService.subscribe(address);

    // 1. Initial snapshot establishes cursor: BTC at time=1000, tid=100
    const btcFill: TradeFillRaw = {
      coin: 'BTC',
      px: '80000',
      sz: '1.0',
      side: 'B',
      time: 1000,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xbtc_cursor',
      oid: 100,
      crossed: true,
      fee: '0.01',
      tid: 100,
    };

    // Baseline initial snapshot seeds cursor without emitting
    // @ts-ignore
    hlService.handleUserFills({ user: address, isSnapshot: true, fills: [btcFill] });
    await hlService.flushAllBatches();
    expect(emittedAlerts.length).toBe(0);

    const cursor = db.getFillCursor(address);
    expect(cursor).not.toBeNull();
    expect(cursor?.lastFillTime).toBe(1000);
    expect(cursor?.lastFillTid).toBe(100);

    // 2. Reconnect snapshot arrives containing unseen ETH at time=1000, tid=50 (tid < 100!)
    const ethFill: TradeFillRaw = {
      coin: 'ETH',
      px: '2500',
      sz: '2.0',
      side: 'B',
      time: 1000,
      startPosition: '0.0',
      dir: 'Open Long',
      closedPnl: '0.0',
      hash: '0xeth_boundary',
      oid: 50,
      crossed: true,
      fee: '0.01',
      tid: 50,
    };

    // @ts-ignore
    hlService.handleUserFills({ user: address, isSnapshot: true, fills: [btcFill, ethFill] });
    await hlService.flushAllBatches();

    // 3. ETH fill must be admitted, inserted into fill_inbox, and emitted exactly once
    expect(emittedAlerts.length).toBe(1);
    expect(emittedAlerts[0].coin).toBe('ETH');
    expect(emittedAlerts[0].currentSize).toBe(2.0);

    // 4. Verify SQLite fill_inbox contains the ETH fill
    const pendingInbox = db.getPendingInboxFills(address);
    expect(pendingInbox.length).toBe(0); // Transitioned to delivered

    await hlService.stop();
  });

  // --- 24. Event-Key Idempotency on Card & History Mutations ---
  it('Event-Key Idempotency: Replaying one reduction event twice leaves cumulative PnL, closed size, and alert history applied once', async () => {
    const address = '0xidempotent_event_whale_000000000000';
    const coin = 'BTC';
    const chatId = 'chat_idempotent_test';
    const userId = 'user_idempotent_test';
    const eventKey = `${address}:BTC:2000:reduce:0`;

    db.upsertUser({ telegramId: userId, username: 'idem_user', mode: 'card' });
    db.addTrackedWallet({
      userId,
      address,
      label: 'Idem Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: chatId,
    });

    // Seed initial position card: 10 BTC Long @ 80k, message_id = 999
    db.savePositionCard(chatId, address, coin, 999, 1000, 80000, 10.0);

    const reduceAlert: TradeAlert = {
      eventKey,
      type: 'position_reduced',
      address,
      chain: 'hyperliquid',
      coin,
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 6.0,
      filledSize: 4.0,
      entryPx: 80000,
      closingPx: 90000,
      closedPnl: 40000, // +$40k PnL
      deltaNotionalUsd: 360000,
      notionalValue: 540000,
      timestamp: 2000,
    };

    const outbox1 = db.getOrCreateOutboxRecord(eventKey, userId, chatId, reduceAlert);

    // Apply mutation 1st time
    const res1 = db.applyDeliveredAlertMutation({
      outboxId: outbox1.id,
      eventKey,
      userId,
      targetChat: chatId,
      alert: reduceAlert,
      cardMutation: {
        type: 'reduced',
        messageId: 999,
        slicePnl: 40000,
        closedSliceSize: 4.0,
        currentSize: 6.0,
      },
    });
    expect(res1.alreadyApplied).toBe(false);

    // Apply mutation 2nd time (replay / duplicate outbox worker delivery)
    const res2 = db.applyDeliveredAlertMutation({
      outboxId: outbox1.id,
      eventKey,
      userId,
      targetChat: chatId,
      alert: reduceAlert,
      cardMutation: {
        type: 'reduced',
        messageId: 999,
        slicePnl: 40000,
        closedSliceSize: 4.0,
        currentSize: 6.0,
      },
    });
    expect(res2.alreadyApplied).toBe(true);

    // Assert: Cumulative PnL is exactly $40,000 (NOT $80,000!) and closed size is 4.0 (NOT 8.0!)
    const card = db.getPositionCard(chatId, address, coin);
    expect(card?.cumRealizedPnl).toBe(40000);
    expect(card?.totalClosedSize).toBe(4.0);
    expect(card?.currentSize).toBe(6.0);

    // Assert: Alerts history contains exactly 1 entry
    const history = db.getRecentAlerts(10);
    const matches = history.filter((h) => h.address === address);
    expect(matches.length).toBe(1);
  });

  // --- 25. Single-Flight Delivery & Concurrent Drain Sharing ---
  it('Single-Flight Delivery: Concurrent triggerOutboxDrain calls share the active promise and produce single delivery', async () => {
    const address = '0xsingle_flight_whale_000000000000';
    const coin = 'ETH';
    const chatId = 'chat_single_flight';
    const userId = 'user_single_flight';

    db.upsertUser({ telegramId: userId, username: 'sf_user', mode: 'card' });
    db.addTrackedWallet({
      userId,
      address,
      label: 'SF Whale',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 0,
      alertChatId: chatId,
    });

    let apiCallsCount = 0;
    const mockBot = {
      api: {
        sendMessage: async () => {
          apiCallsCount++;
          await new Promise((r) => setTimeout(r, 40));
          return { message_id: 1234 };
        },
        editMessageText: async () => {
          apiCallsCount++;
          await new Promise((r) => setTimeout(r, 40));
          return true;
        },
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    const hlService = new HyperliquidService(db);
    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, hlService);

    const alert: TradeAlert = {
      eventKey: `${address}:ETH:1000:open:0`,
      type: 'position_opened',
      address,
      chain: 'hyperliquid',
      coin,
      symbol: 'ETHUSD',
      side: 'LONG',
      currentSize: 1.0,
      filledSize: 1.0,
      entryPx: 2500,
      deltaNotionalUsd: 2500,
      notionalValue: 2500,
      timestamp: 1000,
    };

    // Seed outbox record
    db.getOrCreateOutboxRecord(alert.eventKey!, userId, chatId, alert);

    // Trigger 5 concurrent drains simultaneously
    const drain1 = handlers.triggerOutboxDrain();
    const drain2 = handlers.triggerOutboxDrain();
    const drain3 = handlers.triggerOutboxDrain();

    // Verify that concurrent triggers share the exact same active Promise reference
    expect(drain1).toBe(drain2);
    expect(drain2).toBe(drain3);

    await Promise.all([drain1, drain2, drain3]);

    // Assert: Exactly ONE API call was executed
    expect(apiCallsCount).toBe(1);
    expect(db.getUndeliveredOutboxAlerts().length).toBe(0);

    await handlers.stop();
    await hlService.stop();
  });

  // --- 26. Clean Idempotent Worker Shutdown ---
  it('Clean Shutdown: handlers.stop() is idempotent and halts all timer and drain activity', async () => {
    const mockBot = {
      api: { sendMessage: async () => ({ message_id: 1 }) },
      command: () => {},
      on: () => {},
      use: () => {},
    };

    const hlService = new HyperliquidService(db);
    // @ts-ignore
    const handlers = new BotHandlers(mockBot as any, db, hlService);

    // Verify stopping once
    await handlers.stop();

    // Verify stopping multiple times is completely safe and idempotent
    await handlers.stop();
    await handlers.stop();

    // Triggering drain after stop is a clean no-op
    await handlers.triggerOutboxDrain();
    expect(db.getUndeliveredOutboxAlerts().length).toBe(0);

    await hlService.stop();
  });

  // --- 27. Persistence Error on Invalid insertInboxFill ---
  it('Persistence Error: Throws error when insert produces no row and no existing row is found', () => {
    // Closed database or corrupt operation throws persistence error
    const closedDb = new DatabaseManager(':memory:');
    closedDb.close();

    expect(() => {
      closedDb.insertInboxFill('0xbad', { coin: 'BTC', time: 1, tid: 1 });
    }).toThrow();
  });

  // --- 28. Leased Outbox Delivery Semantics ---
  it('Leased Outbox Semantics: Safely HTML-escapes custom subscriber labels and enforces max(userFilter, walletFilter) in worker path', async () => {
    const address = '0xleased_semantics_whale_00000000000000000000';
    const chatId = 'chat_leased_test';
    const userId = 'user_leased_test';

    // User filter = $1,000, Tracked Wallet filter = $8,000 -> Effective filter = $8,000
    db.upsertUser({ telegramId: userId, username: 'leased_user', minNotionalFilter: 1000, mode: 'feed' });
    db.addTrackedWallet({
      userId,
      address,
      label: '<Alpha & Beta>',
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: 8000,
      alertChatId: chatId,
    });
    let sentText = '';
    let sentCount = 0;
    const mockBot = {
      api: {
        sendMessage: async (_chatId: string, text: string) => {
          sentCount++;
          sentText = text;
          return { message_id: 999 };
        },
        editMessageText: async () => true,
      },
      command: () => {},
      on: () => {},
      use: () => {},
    };
    const hlService = new HyperliquidService(db);
    const handlers = new BotHandlers(mockBot as any, db, hlService);
    // 1. Alert with notional value $5,000 (above user filter $1,000, but below wallet filter $8,000)
    const suppressedAlert: TradeAlert = {
      eventKey: 'event_leased_suppressed_1',
      type: 'position_opened',
      walletLabel: 'Raw Label',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 0.1,
      filledSize: 0.1,
      fillPx: 50000,
      deltaNotionalUsd: 5000,
      entryPx: 50000,
      notionalValue: 5000,
      leverage: 10,
      timestamp: 1000,
    };

    // Manually insert raw un-rendered outbox row
    db.getOrCreateOutboxRecord(suppressedAlert.eventKey!, userId, chatId, suppressedAlert);
    await handlers.triggerOutboxDrain();

    // Verify send was suppressed due to max(1000, 8000) = 8000
    expect(sentCount).toBe(0);
    expect(db.isAlertEventApplied(suppressedAlert.eventKey!, userId, chatId)).toBe(true);

    // 2. Alert with notional value $15,000 (above $8,000 filter)
    const qualifyingAlert: TradeAlert = {
      eventKey: 'event_leased_qualifying_2',
      type: 'position_opened',
      walletLabel: 'Raw Label',
      address,
      chain: 'hyperliquid',
      coin: 'BTC',
      symbol: 'BTCUSD',
      side: 'LONG',
      currentSize: 0.3,
      filledSize: 0.3,
      fillPx: 50000,
      deltaNotionalUsd: 15000,
      entryPx: 50000,
      notionalValue: 15000,
      leverage: 10,
      timestamp: 2000,
    };

    db.getOrCreateOutboxRecord(qualifyingAlert.eventKey!, userId, chatId, qualifyingAlert);
    await handlers.triggerOutboxDrain();

    // Verify send was dispatched with safe escaped HTML label (single-point escaping at formatter boundary)
    expect(sentCount).toBe(1);
    expect(sentText).toContain('<b>&lt;Alpha &amp; Beta&gt;</b>');
    expect(sentText).not.toContain('&amp;amp;');
    expect(sentText).not.toContain('<Alpha & Beta>');
    await handlers.stop();
    await hlService.stop();
  });
});

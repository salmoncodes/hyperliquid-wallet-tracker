import WebSocket from 'ws';
import type { TradeAlert, Position, UserAccountSummary, LeaderboardTrader, MarketSummary } from '../types/index.js';
import type { DatabaseManager } from '../db/database.js';

export interface HyperliquidPositionRaw {
  type: string;
  position: {
    coin: string;
    szi: string;
    leverage: {
      type: string;
      value: number;
    };
    entryPx: string;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    marginUsed: string;
    maxLeverage: number;
    cumFunding: {
      allTime: string;
      sinceOpen: string;
      sinceChange: string;
    };
  };
}

export interface HyperliquidClearinghouseStateRaw {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMarginSummary?: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMaintenanceMarginUsed?: string;
  withdrawable?: string;
  assetPositions: HyperliquidPositionRaw[];
  time: number;
}

export interface TradeFillRaw {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  tid: number;
  cloid?: string;
  feeToken?: string;
}

export class HttpRateLimiter {
  private maxConcurrent: number;
  private running: number = 0;
  private queue: Array<{ resolve: (release: () => void) => void; reject: (err: any) => void }> = [];
  public peakInFlight: number = 0;

  constructor(maxConcurrent: number = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  public async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Request aborted before acquiring HTTP slot');
    }

    if (this.running < this.maxConcurrent) {
      this.running++;
      if (this.running > this.peakInFlight) {
        this.peakInFlight = this.running;
      }
      let released = false;
      return () => {
        if (!released) {
          released = true;
          this.release();
        }
      };
    }

    return new Promise<() => void>((resolve, reject) => {
      const item = {
        resolve: (release: () => void) => {
          if (signal) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve(release);
        },
        reject,
      };

      const onAbort = () => {
        const idx = this.queue.indexOf(item);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(signal?.reason || new Error('Request timed out while waiting in HTTP rate limiter queue'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push(item);
    });
  }

  private release(): void {
    this.running--;
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        this.running++;
        if (this.running > this.peakInFlight) {
          this.peakInFlight = this.running;
        }
        let released = false;
        next.resolve(() => {
          if (!released) {
            released = true;
            this.release();
          }
        });
      }
    }
  }

  public getInFlight(): number {
    return this.running;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }
}

interface PendingBurstBatch {
  userAddress: string;
  coin: string;
  dir: string;
  side: 'LONG' | 'SHORT';
  firstFillTime: number;
  latestFillTime: number;
  createdAt: number;
  fills: TradeFillRaw[];
  inboxIds: number[];
  timer: NodeJS.Timeout;
}
export type AlertCallback = (alert: TradeAlert) => Promise<void> | void;

export interface HyperliquidServiceOptions {
  network?: 'mainnet' | 'testnet';
  wsUrl?: string;
  httpUrl?: string;
}

export class HyperliquidService {
  private wsUrl: string = 'wss://api.hyperliquid.xyz/ws';
  private httpUrl: string = 'https://api.hyperliquid.xyz/info';
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private isStopping: boolean = false;
  private isReconciling: boolean = false;
  private reconcileCursor: number = 0;
  private lastMessageTime: number = 0;

  private subscribedAddresses: Set<string> = new Set();
  private alertListeners: Set<AlertCallback> = new Set();
  
  private processedFills: Set<string> = new Set();
  private committedCursors: Map<string, { time: number; tid: number }> = new Map();

  private pingInterval?: NodeJS.Timeout;
  private reconnectTimeout?: NodeJS.Timeout;
  private reconcileInterval?: NodeJS.Timeout;
  
  private inMemoryPositions: Map<string, Map<string, Position>> = new Map();
  private pendingBatches: Map<string, PendingBurstBatch> = new Map();
  private addressQueues: Map<string, Promise<void>> = new Map();
  private addressEpochs: Map<string, number> = new Map();

  public idleDebounceMs: number = 400;
  public maxBatchAgeMs: number = 2000;
  public maxBatchFills: number = 15;
  // In-memory buffer of live verified market trades from WebSocket
  private httpLimiter: HttpRateLimiter = new HttpRateLimiter(5);

  public getHttpLimiter(): HttpRateLimiter {
    return this.httpLimiter;
  }

  private liveRecentTrades: Array<{
    coin: string;
    side: 'BUY' | 'SELL';
    sz: number;
    px: number;
    usdValue: number;
  }> = [];

  private db?: DatabaseManager;

  constructor(db?: DatabaseManager, options?: HyperliquidServiceOptions) {
    this.db = db;
    const network = options?.network || (process.env.HYPERLIQUID_NETWORK?.toLowerCase() === 'testnet' ? 'testnet' : 'mainnet');
    this.wsUrl = options?.wsUrl || (network === 'testnet' ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws');
    this.httpUrl = options?.httpUrl || (network === 'testnet' ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info');
  }
  public getIsConnected(): boolean {
    return this.isConnected;
  }

  public getFeedHealth(): {
    isConnected: boolean;
    lastMessageTime: number;
    timeSinceLastMessageSeconds: number;
    isStalled: boolean;
    subscribedCount: number;
  } {
    const now = Date.now();
    const timeSinceLastMsg = this.lastMessageTime > 0 ? Math.round((now - this.lastMessageTime) / 1000) : 0;
    const isStalled = this.isConnected && this.lastMessageTime > 0 && timeSinceLastMsg > 60;

    return {
      isConnected: this.isConnected,
      lastMessageTime: this.lastMessageTime,
      timeSinceLastMessageSeconds: timeSinceLastMsg,
      isStalled,
      subscribedCount: this.subscribedAddresses.size,
    };
  }

  public onAlert(callback: AlertCallback): void {
    this.alertListeners.add(callback);
  }

  // --- WebSocket Connection Management ---
  public start(reconcileSeconds: number = 60): void {
    this.isStopping = false;
    this.connect();
    this.startReconciliation(reconcileSeconds);
    this.replayAllPendingInbox();
  }

  private connect(): void {
    if (this.isStopping) return;

    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }

    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      if (this.isStopping) {
        this.ws?.terminate();
        return;
      }

      this.isConnected = true;
      this.lastMessageTime = Date.now();
      console.log('⚡ Connected to Hyperliquid WebSocket feed');

      for (const address of this.subscribedAddresses) {
        this.sendSubscription(address);
      }

      // Also subscribe to major trade channels for live market summary feed
      const summaryCoins = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE'];
      for (const coin of summaryCoins) {
        try {
          this.ws?.send(
            JSON.stringify({
              method: 'subscribe',
              subscription: {
                type: 'trades',
                coin,
              },
            })
          );
        } catch {
          // ignore
        }
      }

      clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws && this.isConnected) {
          try {
            this.ws.send(JSON.stringify({ method: 'ping' }));
          } catch {
            // ignore
          }
        }
      }, 25000);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        if (this.isStopping) return;
        this.lastMessageTime = Date.now();
        const text = data.toString();
        if (text === 'pong') return;
        const msg = JSON.parse(text);

        if (msg.channel === 'subscriptionResponse') {
          return;
        }

        if (msg.channel === 'userFills' && msg.data) {
          this.handleUserFills(msg.data);
        } else if (msg.channel === 'trades' && Array.isArray(msg.data)) {
          for (const t of msg.data) {
            const px = parseFloat(t.px);
            const sz = parseFloat(t.sz);
            const usdValue = px * sz;
            if (usdValue >= 5000) {
              this.liveRecentTrades.push({
                coin: t.coin,
                side: t.side === 'B' ? 'BUY' : 'SELL',
                sz,
                px,
                usdValue,
              });
              if (this.liveRecentTrades.length > 100) {
                this.liveRecentTrades.shift();
              }
            }
          }
        }
      } catch (err) {
        console.error('Error handling WS message:', err);
      }
    });

    this.ws.on('error', (err) => {
      console.error('Hyperliquid WS error:', err.message);
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      clearInterval(this.pingInterval);
      if (this.isStopping) {
        return;
      }
      console.log('Hyperliquid WS closed. Reconnecting in 3s...');
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = setTimeout(() => {
        if (!this.isStopping) {
          this.connect();
        }
      }, 3000);
    });
  }

  // --- Subscriptions & Seeding ---
  public async seedAndSubscribe(address: string): Promise<void> {
    const normalized = address.toLowerCase();

    // 1. Seed from SQLite persistent cache if available
    if (this.db) {
      if (!this.committedCursors.has(normalized)) {
        const cursor = this.db.getFillCursor(normalized);
        if (cursor) {
          this.committedCursors.set(normalized, { time: cursor.lastFillTime, tid: cursor.lastFillTid });
        }
      }

      const cached = this.db.getCachedPositions(normalized);
      if (cached.length > 0) {
        const coinMap = new Map<string, Position>();
        for (const pos of cached) {
          coinMap.set(pos.coin, pos);
        }
        this.inMemoryPositions.set(normalized, coinMap);
      }
    }

    // 2. Fetch live account summary with stale-response protection
    const currentEpoch = this.addressEpochs.get(normalized) || 0;
    try {
      const summary = await this.getAccountSummary(normalized);
      if ((this.addressEpochs.get(normalized) || 0) === currentEpoch) {
        const coinMap = new Map<string, Position>();
        for (const pos of summary.positions) {
          coinMap.set(pos.coin, pos);
        }
        this.inMemoryPositions.set(normalized, coinMap);
      }
    } catch (err) {
      console.warn(`Cold-start seed warning for ${normalized}:`, err);
    }

    this.subscribedAddresses.add(normalized);
    if (this.isConnected && this.ws) {
      this.sendSubscription(normalized);
    }
  }

  public subscribe(address: string): void {
    const normalized = address.toLowerCase();
    this.subscribedAddresses.add(normalized);

    if (this.db && !this.committedCursors.has(normalized)) {
      const cursor = this.db.getFillCursor(normalized);
      if (cursor) {
        this.committedCursors.set(normalized, { time: cursor.lastFillTime, tid: cursor.lastFillTid });
      }
    }

    if (this.isConnected && this.ws) {
      this.sendSubscription(normalized);
    }
  }

  public unsubscribe(address: string): void {
    const normalized = address.toLowerCase();
    this.subscribedAddresses.delete(normalized);
    this.inMemoryPositions.delete(normalized);

    if (this.isConnected && this.ws) {
      try {
        this.ws.send(
          JSON.stringify({
            method: 'unsubscribe',
            subscription: {
              type: 'userFills',
              user: normalized,
            },
          })
        );
      } catch {
        // ignore
      }
    }
  }

  private sendSubscription(address: string): void {
    if (!this.ws || !this.isConnected) return;
    try {
      this.ws.send(
        JSON.stringify({
          method: 'subscribe',
          subscription: {
            type: 'userFills',
            user: address,
          },
        })
      );
    } catch (err) {
      console.error(`Failed to subscribe to ${address}:`, err);
    }
  }

  public replayAllPendingInbox(): void {
    if (!this.db || this.alertListeners.size === 0) return;
    const pending = this.db.getPendingInboxFills();
    for (const item of pending) {
      const key = `${item.address.toLowerCase()}:${item.coin}:${item.time}:${item.tid}`;
      this.processedFills.add(key);
      this.enqueueFillForBurst(item.fill, item.address, item.id);
    }
  }

  // --- Trade Fills & Position Calculations ---
  private handleUserFills(data: { user?: string; isSnapshot?: boolean; fills?: TradeFillRaw[] }): void {
    if (!data.fills || data.fills.length === 0 || this.isStopping) return;

    const userAddress = (data.user || '').toLowerCase();
    this.addressEpochs.set(userAddress, (this.addressEpochs.get(userAddress) || 0) + 1);
    const cursor = this.committedCursors.get(userAddress);

    if (data.isSnapshot) {
      if (!cursor) {
        let maxTime = 0;
        let maxTid = 0;
        for (const fill of data.fills) {
          const key = `${userAddress}:${fill.coin}:${fill.time}:${fill.tid}`;
          this.processedFills.add(key);
          if (fill.time > maxTime || (fill.time === maxTime && fill.tid > maxTid)) {
            maxTime = fill.time;
            maxTid = fill.tid;
          }
        }
        if (maxTime > 0) {
          this.committedCursors.set(userAddress, { time: maxTime, tid: maxTid });
          this.db?.saveFillCursor(userAddress, maxTime, maxTid);
        }
        return;
      }
      const newFills = data.fills.filter(f => f.time >= cursor.time);
      if (newFills.length === 0) return;
      newFills.sort((a, b) => (a.time - b.time) || (a.tid - b.tid));

      for (const fill of newFills) {
        const key = `${userAddress}:${fill.coin}:${fill.time}:${fill.tid}`;
        if (this.processedFills.has(key)) continue;
        this.processedFills.add(key);

        const insertRes = this.db ? this.db.insertInboxFill(userAddress, fill) : { id: 0, isNew: true };
        if (!insertRes.isNew) {
          continue;
        }
        this.enqueueFillForBurst(fill, userAddress, insertRes.id);
      }
      return;
    }

    for (const rawFill of data.fills) {
      const key = `${userAddress}:${rawFill.coin}:${rawFill.time}:${rawFill.tid}`;
      if (this.processedFills.has(key)) continue;
      this.processedFills.add(key);

      if (this.processedFills.size > 40000) {
        const firstKey = this.processedFills.values().next().value;
        if (firstKey !== undefined) this.processedFills.delete(firstKey);
      }

      const insertRes = this.db ? this.db.insertInboxFill(userAddress, rawFill) : { id: 0, isNew: true };
      if (!insertRes.isNew) {
        continue;
      }
      this.enqueueFillForBurst(rawFill, userAddress, insertRes.id);
    }
  }
  public enqueueFillForBurst(fill: TradeFillRaw, userAddress: string, inboxId?: number): void {
    if (this.isStopping) return;
    const coin = fill.coin;
    const key = `${userAddress.toLowerCase()}:${coin}`;
    const side: 'LONG' | 'SHORT' = fill.dir.includes('Long') ? 'LONG' : 'SHORT';
    const now = Date.now();

    const existing = this.pendingBatches.get(key);
    if (existing) {
      if (existing.dir === fill.dir) {
        existing.fills.push(fill);
        if (inboxId && inboxId > 0) existing.inboxIds.push(inboxId);
        existing.latestFillTime = fill.time || now;

        const batchAge = now - existing.createdAt;
        if (batchAge >= this.maxBatchAgeMs || existing.fills.length >= this.maxBatchFills) {
          this.triggerBatchFlush(key);
          return;
        }

        clearTimeout(existing.timer);
        const remainingUntilMax = Math.max(50, this.maxBatchAgeMs - batchAge);
        const timeoutMs = Math.min(this.idleDebounceMs, remainingUntilMax);
        existing.timer = setTimeout(() => {
          this.triggerBatchFlush(key);
        }, timeoutMs);
        return;
      } else {
        this.pendingBatches.delete(key);
        clearTimeout(existing.timer);
        this.dispatchBatch(existing);
      }
    }

    const timer = setTimeout(() => {
      this.triggerBatchFlush(key);
    }, this.idleDebounceMs);

    this.pendingBatches.set(key, {
      userAddress: userAddress.toLowerCase(),
      coin,
      dir: fill.dir,
      side,
      firstFillTime: fill.time || now,
      latestFillTime: fill.time || now,
      createdAt: now,
      fills: [fill],
      inboxIds: inboxId && inboxId > 0 ? [inboxId] : [],
      timer,
    });
  }

  private triggerBatchFlush(key: string): void {
    const batch = this.pendingBatches.get(key);
    if (!batch) return;
    this.pendingBatches.delete(key);
    clearTimeout(batch.timer);
    this.dispatchBatch(batch);
  }

  public async flushBurstBatch(key: string): Promise<void> {
    const batch = this.pendingBatches.get(key);
    if (batch) {
      this.pendingBatches.delete(key);
      clearTimeout(batch.timer);
      this.dispatchBatch(batch);
    }
    const userAddress = key.split(':')[0];
    const q = this.addressQueues.get(userAddress);
    if (q) await q;
  }

  public async flushAllBatches(): Promise<void> {
    for (const [key, batch] of Array.from(this.pendingBatches.entries())) {
      this.pendingBatches.delete(key);
      clearTimeout(batch.timer);
      this.dispatchBatch(batch);
    }
    await Promise.all(Array.from(this.addressQueues.values()));
  }

  private dispatchBatch(batch: PendingBurstBatch): void {
    const { userAddress, coin, fills, inboxIds } = batch;
    if (fills.length === 0) return;

    if (this.alertListeners.size === 0) {
      console.warn(`No delivery listener attached; keeping fills pending in inbox for ${userAddress}`);
      return;
    }

    const firstFill = fills[0];
    const latestFill = fills[fills.length - 1];
    const totalSz = fills.reduce((sum, f) => sum + parseFloat(f.sz), 0);
    const totalAddedUsd = fills.reduce((sum, f) => sum + parseFloat(f.sz) * parseFloat(f.px), 0);
    const vwap = totalSz > 0 ? totalAddedUsd / totalSz : parseFloat(latestFill.px);
    const totalClosedPnl = fills.reduce((sum, f) => sum + parseFloat(f.closedPnl || '0'), 0);
    const deltaNotionalUsd = totalAddedUsd;

    const minTime = fills[0].time;
    const maxTime = latestFill.time;
    const minTid = Math.min(...fills.map(f => f.tid));
    const maxTid = Math.max(...fills.map(f => f.tid));
    const fillKey = `${minTime}_${maxTime}_${minTid}_${maxTid}`;

    const initialStartPos = parseFloat(firstFill.startPosition);
    const initialAbsSize = Math.abs(initialStartPos);
    const symbol = `${coin}USD`;

    let coinMap = this.inMemoryPositions.get(userAddress);
    if (!coinMap) {
      coinMap = new Map<string, Position>();
      this.inMemoryPositions.set(userAddress, coinMap);
    }
    const cachedPos = coinMap.get(coin);
    const leverage = cachedPos?.leverage || 1;

    const dir = firstFill.dir;
    const alertsToEmit: TradeAlert[] = [];
    let resultingPosition: Position | null = null;

    if (dir === 'Open Long' || dir === 'Open Short') {
      const side: 'LONG' | 'SHORT' = dir === 'Open Long' ? 'LONG' : 'SHORT';
      const isNew = initialAbsSize === 0;
      const currentSize = isNew ? totalSz : initialAbsSize + totalSz;
      const notionalValue = currentSize * parseFloat(latestFill.px);

      if (isNew) {
        alertsToEmit.push({
          eventKey: `${userAddress}:${coin}:${fillKey}:open:0`,
          type: 'position_opened',
          address: userAddress,
          chain: 'hyperliquid',
          coin,
          symbol,
          side,
          currentSize,
          filledSize: totalSz,
          deltaNotionalUsd,
          entryPx: vwap,
          notionalValue,
          leverage,
          burstCount: fills.length > 1 ? fills.length : undefined,
          txHash: latestFill.hash,
          timestamp: latestFill.time || Date.now(),
        });
        resultingPosition = {
          coin,
          size: currentSize,
          entryPx: vwap,
          side,
          notionalValue,
          unrealizedPnl: 0,
          leverage,
        };
      } else {
        const prevEntry = cachedPos?.entryPx || vwap;
        const blendedEntry = currentSize > 0 ? (initialAbsSize * prevEntry + totalAddedUsd) / currentSize : vwap;

        alertsToEmit.push({
          eventKey: `${userAddress}:${coin}:${fillKey}:increase:0`,
          type: 'position_increased',
          address: userAddress,
          chain: 'hyperliquid',
          coin,
          symbol,
          side,
          currentSize,
          filledSize: totalSz,
          fillPx: vwap,
          addedUsd: totalAddedUsd,
          deltaNotionalUsd,
          entryPx: blendedEntry,
          notionalValue,
          leverage,
          burstCount: fills.length > 1 ? fills.length : undefined,
          txHash: latestFill.hash,
          timestamp: latestFill.time || Date.now(),
        });
        resultingPosition = {
          coin,
          size: currentSize,
          entryPx: blendedEntry,
          side,
          notionalValue,
          unrealizedPnl: cachedPos?.unrealizedPnl || 0,
          leverage,
        };
      }
      coinMap.set(coin, resultingPosition);
    } else if (dir === 'Close Long' || dir === 'Close Short') {
      const closingSide: 'LONG' | 'SHORT' = dir === 'Close Long' ? 'LONG' : 'SHORT';

      if (totalSz > initialAbsSize && initialAbsSize > 0) {
        const closeLegSize = initialAbsSize;
        const newLegSide: 'LONG' | 'SHORT' = closingSide === 'LONG' ? 'SHORT' : 'LONG';
        const newLegSize = totalSz - initialAbsSize;

        // Leg 1: Close
        alertsToEmit.push({
          eventKey: `${userAddress}:${coin}:${fillKey}:flip_close:0`,
          type: 'position_closed',
          address: userAddress,
          chain: 'hyperliquid',
          coin,
          symbol,
          side: closingSide,
          currentSize: 0,
          filledSize: closeLegSize,
          deltaNotionalUsd: closeLegSize * vwap,
          entryPx: cachedPos?.entryPx || vwap,
          closingPx: vwap,
          notionalValue: 0,
          closedPnl: totalClosedPnl,
          leverage,
          burstCount: fills.length > 1 ? fills.length : undefined,
          txHash: latestFill.hash,
          timestamp: latestFill.time || Date.now(),
        });

        // Leg 2: Open
        alertsToEmit.push({
          eventKey: `${userAddress}:${coin}:${fillKey}:flip_open:1`,
          type: 'position_opened',
          address: userAddress,
          chain: 'hyperliquid',
          coin,
          symbol,
          side: newLegSide,
          currentSize: newLegSize,
          filledSize: newLegSize,
          deltaNotionalUsd: newLegSize * vwap,
          entryPx: vwap,
          notionalValue: newLegSize * parseFloat(latestFill.px),
          leverage,
          burstCount: fills.length > 1 ? fills.length : undefined,
          txHash: latestFill.hash,
          timestamp: latestFill.time || Date.now(),
        });

        resultingPosition = {
          coin,
          size: newLegSize,
          entryPx: vwap,
          side: newLegSide,
          notionalValue: newLegSize * parseFloat(latestFill.px),
          unrealizedPnl: 0,
          leverage,
        };
        coinMap.set(coin, resultingPosition);
      } else {
        const remainingSize = Math.max(0, initialAbsSize - totalSz);
        const approxEntryPx = cachedPos?.entryPx || vwap;
        const isFullyClosed = remainingSize <= 0.000001;

        if (isFullyClosed) {
          alertsToEmit.push({
            eventKey: `${userAddress}:${coin}:${fillKey}:close:0`,
            type: 'position_closed',
            address: userAddress,
            chain: 'hyperliquid',
            coin,
            symbol,
            side: closingSide,
            currentSize: 0,
            filledSize: totalSz,
            deltaNotionalUsd: totalSz * vwap,
            entryPx: approxEntryPx,
            closingPx: vwap,
            notionalValue: 0,
            closedPnl: totalClosedPnl,
            leverage,
            burstCount: fills.length > 1 ? fills.length : undefined,
            txHash: latestFill.hash,
            timestamp: latestFill.time || Date.now(),
          });
          coinMap.delete(coin);
          resultingPosition = null;
        } else {
          alertsToEmit.push({
            eventKey: `${userAddress}:${coin}:${fillKey}:reduce:0`,
            type: 'position_reduced',
            address: userAddress,
            chain: 'hyperliquid',
            coin,
            symbol,
            side: closingSide,
            currentSize: remainingSize,
            filledSize: totalSz,
            deltaNotionalUsd: totalSz * vwap,
            entryPx: approxEntryPx,
            closingPx: vwap,
            notionalValue: remainingSize * parseFloat(latestFill.px),
            closedPnl: totalClosedPnl,
            leverage,
            burstCount: fills.length > 1 ? fills.length : undefined,
            txHash: latestFill.hash,
            timestamp: latestFill.time || Date.now(),
          });
          resultingPosition = {
            coin,
            size: remainingSize,
            entryPx: approxEntryPx,
            side: closingSide,
            notionalValue: remainingSize * parseFloat(latestFill.px),
            unrealizedPnl: cachedPos?.unrealizedPnl || 0,
            leverage,
          };
          coinMap.set(coin, resultingPosition);
        }
      }
    }

    const prevQueue = this.addressQueues.get(userAddress) || Promise.resolve();
    const nextQueue = prevQueue.then(async () => {
      // 1. Commit reduction, positions_cache, fill_cursors, fill_inbox delivered, and outbox rows in ONE atomic SQLite transaction!
      if (this.db) {
        this.db.commitReductionAndEmitOutbox(
          userAddress,
          coin,
          resultingPosition,
          inboxIds || [],
          latestFill.time,
          latestFill.tid,
          alertsToEmit
        );
      }
      this.committedCursors.set(userAddress, { time: latestFill.time, tid: latestFill.tid });

      // 2. Deliver to listeners (Telegram push)
      for (const alert of alertsToEmit) {
        for (const listener of this.alertListeners) {
          await listener(alert);
        }
      }
    }).catch(err => {
      console.error(`Error in address queue for ${userAddress}:`, err);
    });

    this.addressQueues.set(userAddress, nextQueue);
  }

  // --- Rotating Periodic Reconcile Sweep ---
  private startReconciliation(intervalSeconds: number): void {
    if (isNaN(intervalSeconds) || intervalSeconds <= 0) return;
    clearInterval(this.reconcileInterval);

    this.reconcileInterval = setInterval(async () => {
      if (this.isReconciling || this.isStopping) return;
      this.isReconciling = true;

      try {
        const addresses = Array.from(this.subscribedAddresses);
        if (addresses.length === 0) return;

        const batchSize = 5;
        const start = this.reconcileCursor % addresses.length;
        const sweepBatch = [];
        for (let i = 0; i < batchSize && i < addresses.length; i++) {
          sweepBatch.push(addresses[(start + i) % addresses.length]);
        }
        this.reconcileCursor = (start + batchSize) % addresses.length;

        await Promise.all(sweepBatch.map(async (address) => {
          const currentEpoch = this.addressEpochs.get(address) || 0;
          try {
            const summary = await this.getAccountSummary(address);
            if ((this.addressEpochs.get(address) || 0) === currentEpoch) {
              const coinMap = new Map<string, Position>();
              for (const pos of summary.positions) {
                coinMap.set(pos.coin, pos);
              }
              this.inMemoryPositions.set(address, coinMap);
            }
          } catch (err) {
            console.warn(`Reconciliation sweep warning for ${address}:`, err);
          }
        }));
      } finally {
        this.isReconciling = false;
      }
    }, intervalSeconds * 1000);
  }

  // --- REST API Endpoints with Total Deadline & Signal ---
  public async postInfo<T>(body: Record<string, unknown>, timeoutMs: number = 8000): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error(`Hyperliquid HTTP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let release: (() => void) | null = null;
    try {
      release = await this.httpLimiter.acquire(controller.signal);
      const response = await fetch(this.httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Hyperliquid HTTP error ${response.status}: ${await response.text()}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
      if (release) {
        release();
      }
    }
  }

  public async getAccountSummary(address: string): Promise<UserAccountSummary> {
    const raw = await this.postInfo<HyperliquidClearinghouseStateRaw>({
      type: 'clearinghouseState',
      user: address.toLowerCase(),
    });

    const positions: Position[] = [];
    for (const item of raw.assetPositions || []) {
      const p = item.position;
      const szi = parseFloat(p.szi);
      if (Math.abs(szi) < 0.0000001) continue;

      const side: 'LONG' | 'SHORT' = szi > 0 ? 'LONG' : 'SHORT';
      const size = Math.abs(szi);
      const entryPx = parseFloat(p.entryPx);
      const positionValue = parseFloat(p.positionValue);
      const unrealizedPnl = parseFloat(p.unrealizedPnl);
      const returnOnEquity = parseFloat(p.returnOnEquity || '0');
      const liquidationPx = p.liquidationPx ? parseFloat(p.liquidationPx) : null;
      const leverage = p.leverage?.value || 1;
      const marginUsed = parseFloat(p.marginUsed || '0');

      positions.push({
        coin: p.coin,
        size,
        entryPx,
        side,
        notionalValue: positionValue,
        unrealizedPnl,
        returnOnEquity,
        liquidationPx,
        leverage,
        marginUsed,
      });
    }

    return {
      accountValue: parseFloat(raw.marginSummary?.accountValue || '0'),
      totalNtlPos: parseFloat(raw.marginSummary?.totalNtlPos || '0'),
      totalRawUsd: parseFloat(raw.marginSummary?.totalRawUsd || '0'),
      totalMarginUsed: parseFloat(raw.marginSummary?.totalMarginUsed || '0'),
      positions,
    };
  }

  public async getRecentFills(address: string): Promise<TradeFillRaw[]> {
    return await this.postInfo<TradeFillRaw[]>({
      type: 'userFills',
      user: address.toLowerCase(),
    });
  }

  public async discoverActiveWhales(): Promise<LeaderboardTrader[]> {
    const candidates = new Set<string>();

    const majorCoins = ['BTC', 'ETH', 'SOL', 'HYPE', 'DOGE', 'XRP'];
    for (const coin of majorCoins) {
      try {
        const trades = await this.postInfo<Array<{ users: string[] }>>({
          type: 'recentTrades',
          coin,
        });

        for (const t of trades.slice(0, 10)) {
          if (t.users) {
            for (const u of t.users) {
              if (u) candidates.add(u.toLowerCase());
            }
          }
        }
      } catch {
        // ignore
      }
    }

    const traders: LeaderboardTrader[] = [];
    for (const address of Array.from(candidates).slice(0, 15)) {
      try {
        const summary = await this.getAccountSummary(address);
        if (summary.accountValue > 5000 || summary.positions.length > 0) {
          const topPos = summary.positions.sort((a, b) => b.notionalValue - a.notionalValue)[0];
          traders.push({
            address,
            name: address.slice(0, 6) + '...' + address.slice(-4),
            pnl: summary.positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0),
            accountValue: summary.accountValue,
            positionsCount: summary.positions.length,
            topPositions: topPos ? [`${topPos.side} ${topPos.coin} ($${Math.round(topPos.notionalValue).toLocaleString()})`] : [],
          });
        }
      } catch {
        // ignore
      }
    }

    traders.sort((a, b) => b.accountValue - a.accountValue);
    return traders;
  }

  public async getMarketSummary(): Promise<MarketSummary> {
    const rawData = await this.postInfo<[
      { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> },
      Array<{
        funding: string;
        openInterest: string;
        prevDayPx: string;
        dayNtlVlm: string;
        markPx: string;
        oraclePx: string;
      }>
    ]>({ type: 'metaAndAssetCtxs' });

    const universe = rawData[0]?.universe || [];
    const contexts = rawData[1] || [];

    let totalVolume24h = 0;
    let totalOi = 0;
    const movers: Array<{ coin: string; changePct: number; px: number; volume: number }> = [];

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      const ctx = contexts[i];
      if (!asset || !ctx) continue;

      const coin = asset.name;
      const markPx = parseFloat(ctx.markPx || '0');
      const prevDayPx = parseFloat(ctx.prevDayPx || '0');
      const oi = parseFloat(ctx.openInterest || '0');
      const dayNtlVol = parseFloat(ctx.dayNtlVlm || '0');

      totalVolume24h += dayNtlVol;
      totalOi += oi * markPx;

      if (prevDayPx > 0 && markPx > 0) {
        const changePct = ((markPx - prevDayPx) / prevDayPx) * 100;
        movers.push({
          coin,
          changePct,
          px: markPx,
          volume: dayNtlVol,
        });
      }
    }

    movers.sort((a, b) => b.changePct - a.changePct);
    const topGainers = movers.slice(0, 3).map((g) => ({ coin: g.coin, changePct: g.changePct, px: g.px }));
    const topLosers = movers.slice(-3).reverse().map((l) => ({ coin: l.coin, changePct: l.changePct, px: l.px }));

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    const whaleAddresses = Array.from(this.subscribedAddresses);
    const activeWhales: Array<{ name: string; accountValue: number; positionsCount: number; topPosition?: string }> = [];

    for (const addr of whaleAddresses.slice(0, 5)) {
      try {
        const summary = await this.getAccountSummary(addr);
        if (summary.accountValue > 0 || summary.positions.length > 0) {
          const top = summary.positions.sort((a, b) => b.notionalValue - a.notionalValue)[0];
          const topPosStr = top ? `${top.side} ${top.coin} ($${Math.round(top.notionalValue).toLocaleString()})` : undefined;
          activeWhales.push({
            name: addr.slice(0, 6) + '...' + addr.slice(-4),
            accountValue: summary.accountValue,
            positionsCount: summary.positions.length,
            topPosition: topPosStr,
          });
        }
      } catch {
        // ignore
      }
    }

    activeWhales.sort((a, b) => b.accountValue - a.accountValue);

    // Prefer live buffered WebSocket whale market trades; fallback to recentTrades HTTP query
    let topTrades = [...this.liveRecentTrades];
    if (topTrades.length === 0) {
      const checkCoins = ['BTC', 'ETH', 'SOL', 'HYPE'];
      for (const coin of checkCoins) {
        try {
          const trades = await this.postInfo<Array<{ side: 'B' | 'A'; sz: string; px: string }>>({
            type: 'recentTrades',
            coin,
          });

          for (const t of trades.slice(0, 5)) {
            const px = parseFloat(t.px);
            const sz = parseFloat(t.sz);
            const usdValue = px * sz;
            if (usdValue >= 5000) {
              topTrades.push({
                coin,
                side: t.side === 'B' ? 'BUY' : 'SELL',
                sz,
                px,
                usdValue,
              });
            }
          }
        } catch {
          // ignore
        }
      }
    }

    topTrades.sort((a, b) => b.usdValue - a.usdValue);
    const largestRecentTrades = topTrades.slice(0, 3);

    return {
      dateStr,
      totalVolume24h,
      totalOi,
      topGainers,
      topLosers,
      activeWhales,
      largestRecentTrades,
    };
  }

  public async stop(): Promise<void> {
    this.isStopping = true;
    clearInterval(this.pingInterval);
    clearInterval(this.reconcileInterval);
    clearTimeout(this.reconnectTimeout);

    for (const [key, batch] of Array.from(this.pendingBatches.entries())) {
      this.pendingBatches.delete(key);
      clearTimeout(batch.timer);
      this.dispatchBatch(batch);
    }

    await Promise.all(Array.from(this.addressQueues.values()));

    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

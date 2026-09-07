import { Database } from 'bun:sqlite';
import type { TrackedWallet, User, TradeAlert, Position, FillCursor } from '../types/index.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

interface UserRow {
  telegram_id: string;
  username: string | null;
  first_name: string | null;
  min_notional_filter: number;
  show_buttons: number;
  mode: string;
  created_at: number;
}

interface TrackedWalletRow {
  id: number;
  user_id: string;
  address: string;
  label: string;
  chain: string;
  is_active: number;
  min_notional_usd: number;
  alert_chat_id: string | null;
  created_at: number;
}

interface TableColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface PositionCardRow {
  id: number;
  chat_id: string;
  address: string;
  coin: string;
  message_id: number;
  initial_open_time: number;
  initial_entry_px: number;
  max_size: number;
  current_size: number;
  cum_realized_pnl: number;
  total_closed_size: number;
  created_at: number;
  updated_at: number;
}

interface FillCursorRow {
  address: string;
  last_fill_time: number;
  last_fill_tid: number;
  updated_at: number;
}

interface FillInboxRow {
  id: number;
  address: string;
  coin: string;
  time: number;
  tid: number;
  raw_json: string;
  status: string;
  created_at: number;
}

interface AlertOutboxRow {
  id: number;
  event_key: string;
  inbox_id: number | null;
  user_id: string;
  target_chat: string;
  address: string;
  coin: string;
  alert_json: string;
  status: string;
  attempts: number;
  lease_expires_at: number;
  locked_by: string | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath: string = './data/tracker.sqlite') {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.initTables(dbPath);
  }

  private initTables(dbPath?: string): void {
    if (dbPath !== ':memory:') {
      this.db.run(`PRAGMA journal_mode = WAL;`);
      this.db.run(`PRAGMA synchronous = NORMAL;`);
      this.db.run(`PRAGMA busy_timeout = 5000;`);
    }

    // Users table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        min_notional_filter REAL DEFAULT 0,
        show_buttons INTEGER DEFAULT 1,
        mode TEXT DEFAULT 'card',
        created_at INTEGER
      );
    `);

    const userColumns = this.db.prepare(`PRAGMA table_info(users)`).all() as TableColumnRow[];
    if (!userColumns.some(c => c.name === 'mode')) {
      this.db.run(`ALTER TABLE users ADD COLUMN mode TEXT DEFAULT 'card'`);
    }

    // Tracked Wallets table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tracked_wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        address TEXT NOT NULL,
        label TEXT NOT NULL,
        chain TEXT NOT NULL DEFAULT 'hyperliquid',
        is_active INTEGER DEFAULT 1,
        min_notional_usd REAL DEFAULT 0,
        alert_chat_id TEXT,
        created_at INTEGER,
        UNIQUE(user_id, address, chain)
      );
    `);

    // Positions cache table (persisted reducer state)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS positions_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        coin TEXT NOT NULL,
        size REAL NOT NULL,
        entry_px REAL NOT NULL,
        side TEXT NOT NULL,
        notional_value REAL NOT NULL,
        unrealized_pnl REAL DEFAULT 0,
        updated_at INTEGER,
        UNIQUE(address, coin)
      );
    `);

    // Position Cards table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS position_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        address TEXT NOT NULL,
        coin TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        initial_open_time INTEGER NOT NULL,
        initial_entry_px REAL NOT NULL DEFAULT 0,
        max_size REAL NOT NULL DEFAULT 0,
        current_size REAL NOT NULL DEFAULT 0,
        cum_realized_pnl REAL NOT NULL DEFAULT 0,
        total_closed_size REAL NOT NULL DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        UNIQUE(chat_id, address, coin)
      );
    `);

    const cardColumns = this.db.prepare(`PRAGMA table_info(position_cards)`).all() as TableColumnRow[];
    if (!cardColumns.some(c => c.name === 'cum_realized_pnl')) {
      this.db.run(`ALTER TABLE position_cards ADD COLUMN cum_realized_pnl REAL NOT NULL DEFAULT 0`);
    }
    if (!cardColumns.some(c => c.name === 'initial_entry_px')) {
      this.db.run(`ALTER TABLE position_cards ADD COLUMN initial_entry_px REAL NOT NULL DEFAULT 0`);
    }
    if (!cardColumns.some(c => c.name === 'max_size')) {
      this.db.run(`ALTER TABLE position_cards ADD COLUMN max_size REAL NOT NULL DEFAULT 0`);
    }
    if (!cardColumns.some(c => c.name === 'current_size')) {
      this.db.run(`ALTER TABLE position_cards ADD COLUMN current_size REAL NOT NULL DEFAULT 0`);
    }
    if (!cardColumns.some(c => c.name === 'total_closed_size')) {
      this.db.run(`ALTER TABLE position_cards ADD COLUMN total_closed_size REAL NOT NULL DEFAULT 0`);
    }

    // Versioned backfill for current_size on existing cards
    this.db.run(`
      UPDATE position_cards
      SET current_size = MAX(0, max_size - total_closed_size)
      WHERE current_size = 0 AND max_size > 0;
    `);

    // Durable Fill Inbox: Persists incoming fills before reduction and dispatch
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fill_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        coin TEXT NOT NULL,
        time INTEGER NOT NULL,
        tid INTEGER NOT NULL,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        UNIQUE(address, coin, time, tid)
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_fill_inbox_pending ON fill_inbox(address, status, time, tid);
    `);

    // Durable Alert Outbox: Deterministic recipient-level idempotency key + leasing
    this.db.run(`
      CREATE TABLE IF NOT EXISTS alert_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL,
        inbox_id INTEGER,
        user_id TEXT NOT NULL,
        target_chat TEXT NOT NULL,
        address TEXT NOT NULL,
        coin TEXT NOT NULL,
        alert_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_expires_at INTEGER NOT NULL DEFAULT 0,
        locked_by TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(event_key, user_id, target_chat)
      );
    `);

    const outboxColumns = this.db.prepare(`PRAGMA table_info(alert_outbox)`).all() as TableColumnRow[];
    if (!outboxColumns.some(c => c.name === 'lease_expires_at')) {
      this.db.run(`ALTER TABLE alert_outbox ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0`);
    }
    if (!outboxColumns.some(c => c.name === 'locked_by')) {
      this.db.run(`ALTER TABLE alert_outbox ADD COLUMN locked_by TEXT`);
    }

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_alert_outbox_pending ON alert_outbox(status, target_chat, lease_expires_at);
    `);

    // Fill Cursors table (Committed high-water mark per address across restarts & reconnects)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fill_cursors (
        address TEXT PRIMARY KEY,
        last_fill_time INTEGER NOT NULL,
        last_fill_tid INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Alerts History table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS alerts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        address TEXT NOT NULL,
        wallet_label TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        details_json TEXT NOT NULL,
        tx_hash TEXT,
        created_at INTEGER
      );
    `);

    // Minimal Applied Alert Events table for exactly-once internal card/history mutations
    this.db.run(`
      CREATE TABLE IF NOT EXISTS applied_alert_events (
        event_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        target_chat TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (event_key, user_id, target_chat)
      );
    `);
  }

  // --- Atomic Reduction, Reducer State Persistence, Cursors & Outbox Transaction ---
  public commitReductionAndEmitOutbox(
    address: string,
    coin: string,
    position: Position | null,
    inboxIds: number[],
    maxFillTime: number,
    maxTid: number,
    alerts: TradeAlert[]
  ): { outboxIds: number[] } {
    const addr = address.toLowerCase();
    const upperCoin = coin.toUpperCase();
    const now = Date.now();

    const tx = this.db.transaction(() => {
      // 1. Persist Reducer State to positions_cache
      if (position && position.size > 0.000001) {
        this.db.prepare(`
          INSERT INTO positions_cache (address, coin, size, entry_px, side, notional_value, unrealized_pnl, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(address, coin) DO UPDATE SET
            size = excluded.size,
            entry_px = excluded.entry_px,
            side = excluded.side,
            notional_value = excluded.notional_value,
            unrealized_pnl = excluded.unrealized_pnl,
            updated_at = excluded.updated_at;
        `).run(addr, upperCoin, position.size, position.entryPx, position.side, position.notionalValue, position.unrealizedPnl || 0, now);
      } else {
        this.db.prepare(`
          DELETE FROM positions_cache WHERE address = ? AND coin = ?
        `).run(addr, upperCoin);
      }

      // 2. Persist high-water mark cursor
      if (maxFillTime > 0) {
        this.db.prepare(`
          INSERT INTO fill_cursors (address, last_fill_time, last_fill_tid, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(address) DO UPDATE SET
            last_fill_time = CASE WHEN excluded.last_fill_time >= fill_cursors.last_fill_time THEN excluded.last_fill_time ELSE fill_cursors.last_fill_time END,
            last_fill_tid = CASE WHEN excluded.last_fill_time >= fill_cursors.last_fill_time THEN excluded.last_fill_tid ELSE fill_cursors.last_fill_tid END,
            updated_at = excluded.updated_at
        `).run(addr, maxFillTime, maxTid, now);
      }

      // 3. Mark inbox fills as delivered
      if (inboxIds.length > 0) {
        const placeholders = inboxIds.map(() => '?').join(',');
        this.db.prepare(`
          UPDATE fill_inbox SET status = 'delivered' WHERE id IN (${placeholders})
        `).run(...inboxIds);
      }

      // 4. Create Outbox entries for each subscriber
      const subscribers = this.getSubscribersForAddress(addr, 'hyperliquid');
      const outboxIds: number[] = [];

      for (const alert of alerts) {
        const eventKey = alert.eventKey || `${addr}:${upperCoin}:${alert.timestamp}:${alert.type}:0`;
        const primaryInboxId = inboxIds.length > 0 ? inboxIds[0] : null;

        for (const sub of subscribers) {
          const targetChat = sub.alertChatId || sub.userId;

          const customizedAlert: TradeAlert = {
            ...alert,
            walletLabel: sub.label || alert.walletLabel || 'Trader',
          };

          const stmt = this.db.prepare(`
            INSERT INTO alert_outbox (event_key, inbox_id, user_id, target_chat, address, coin, alert_json, status, attempts, lease_expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)
            ON CONFLICT(event_key, user_id, target_chat) DO NOTHING
            RETURNING id;
          `);

          const res = stmt.get(
            eventKey,
            primaryInboxId,
            sub.userId,
            targetChat,
            addr,
            upperCoin,
            JSON.stringify(customizedAlert),
            now
          ) as { id: number } | null;

          if (res?.id) {
            outboxIds.push(res.id);
          }
        }
      }

      return { outboxIds };
    });

    return tx();
  }

  // --- Cached Reducer State Retrieval ---
  public getCachedPositions(address: string): Position[] {
    const rows = this.db.prepare(`
      SELECT * FROM positions_cache WHERE address = ?
    `).all(address.toLowerCase()) as Array<{
      coin: string;
      size: number;
      entry_px: number;
      side: string;
      notional_value: number;
      unrealized_pnl: number;
    }>;

    return rows.map(r => ({
      coin: r.coin,
      size: r.size,
      entryPx: r.entry_px,
      side: r.side as 'LONG' | 'SHORT',
      notionalValue: r.notional_value,
      unrealizedPnl: r.unrealized_pnl,
    }));
  }

  // --- Durable Fill Inbox & Cursors ---
  public insertInboxFill(address: string, fill: { coin: string; time: number; tid: number; [key: string]: any }): { id: number; isNew: boolean } {
    const addr = address.toLowerCase();
    const stmt = this.db.prepare(`
      INSERT INTO fill_inbox (address, coin, time, tid, raw_json, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(address, coin, time, tid) DO NOTHING
      RETURNING id;
    `);
    const row = stmt.get(addr, fill.coin, fill.time, fill.tid, JSON.stringify(fill), Date.now()) as { id: number } | null;
    if (row?.id) return { id: row.id, isNew: true };

    const existing = this.db.prepare(`
      SELECT id FROM fill_inbox WHERE address = ? AND coin = ? AND time = ? AND tid = ?
    `).get(addr, fill.coin, fill.time, fill.tid) as { id: number } | null;

    if (existing?.id) {
      return { id: existing.id, isNew: false };
    }

    throw new Error(`Persistence Error: Failed to insert or lookup inbox fill for ${addr} ${fill.coin} time=${fill.time} tid=${fill.tid}`);
  }

  public getPendingInboxFills(address?: string): Array<{ id: number; address: string; coin: string; time: number; tid: number; fill: any }> {
    let rows: FillInboxRow[];
    if (address) {
      rows = this.db.prepare(`
        SELECT * FROM fill_inbox
        WHERE address = ? AND status = 'pending'
        ORDER BY time ASC, tid ASC
      `).all(address.toLowerCase()) as FillInboxRow[];
    } else {
      rows = this.db.prepare(`
        SELECT * FROM fill_inbox
        WHERE status = 'pending'
        ORDER BY time ASC, tid ASC
      `).all() as FillInboxRow[];
    }

    return rows.map(r => ({
      id: r.id,
      address: r.address,
      coin: r.coin,
      time: r.time,
      tid: r.tid,
      fill: JSON.parse(r.raw_json),
    }));
  }

  public getPendingInboxCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM fill_inbox WHERE status = 'pending'`).get() as { count: number } | null;
    return row?.count || 0;
  }

  public getUndeliveredOutboxCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM alert_outbox WHERE status != 'delivered'`).get() as { count: number } | null;
    return row?.count || 0;
  }

  // --- Outbox Leasing & Worker Coordination ---
  public getOrCreateOutboxRecord(
    eventKey: string,
    userId: string,
    targetChat: string,
    alert: TradeAlert,
    inboxId?: number
  ): { id: number; alreadyDelivered: boolean; attempts: number } {
    const existing = this.db.prepare(`
      SELECT id, status, attempts FROM alert_outbox
      WHERE event_key = ? AND user_id = ? AND target_chat = ?
    `).get(eventKey, userId, targetChat) as { id: number; status: string; attempts: number } | null;

    if (existing) {
      return {
        id: existing.id,
        alreadyDelivered: existing.status === 'delivered',
        attempts: existing.attempts,
      };
    }

    const stmt = this.db.prepare(`
      INSERT INTO alert_outbox (event_key, inbox_id, user_id, target_chat, address, coin, alert_json, status, attempts, lease_expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)
      RETURNING id;
    `);

    try {
      const res = stmt.get(
        eventKey,
        inboxId || null,
        userId,
        targetChat,
        alert.address.toLowerCase(),
        alert.coin,
        JSON.stringify(alert),
        Date.now()
      ) as { id: number } | null;

      if (res?.id) {
        return { id: res.id, alreadyDelivered: false, attempts: 0 };
      }
    } catch {
      // fallback
    }

    const row = this.db.prepare(`
      SELECT id, status, attempts FROM alert_outbox
      WHERE event_key = ? AND user_id = ? AND target_chat = ?
    `).get(eventKey, userId, targetChat) as { id: number; status: string; attempts: number } | null;

    return {
      id: row?.id || 0,
      alreadyDelivered: row?.status === 'delivered',
      attempts: row?.attempts || 0,
    };
  }

  public claimOutboxLease(
    workerId: string,
    leaseDurationMs: number = 30000,
    limit: number = 10
  ): Array<{
    id: number;
    eventKey: string;
    userId: string;
    targetChat: string;
    alert: TradeAlert;
    attempts: number;
  }> {
    const now = Date.now();
    const leaseExpiry = now + leaseDurationMs;

    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, event_key, user_id, target_chat, alert_json, attempts
        FROM alert_outbox
        WHERE (status = 'pending' OR status = 'failed' OR (status = 'leased' AND lease_expires_at < ?)) AND attempts < 5
        ORDER BY created_at ASC
        LIMIT ?
      `).all(now, limit) as AlertOutboxRow[];

      if (rows.length === 0) return [];

      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');

      this.db.prepare(`
        UPDATE alert_outbox
        SET status = 'leased', lease_expires_at = ?, locked_by = ?
        WHERE id IN (${placeholders})
      `).run(leaseExpiry, workerId, ...ids);

      return rows.map(r => ({
        id: r.id,
        eventKey: r.event_key,
        userId: r.user_id,
        targetChat: r.target_chat,
        alert: JSON.parse(r.alert_json) as TradeAlert,
        attempts: r.attempts,
      }));
    });

    return tx();
  }

  public markOutboxDelivered(id: number): void {
    this.db.prepare(`
      UPDATE alert_outbox SET status = 'delivered', lease_expires_at = 0, locked_by = NULL, delivered_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  public markOutboxFailed(id: number, error: string): void {
    this.db.prepare(`
      UPDATE alert_outbox SET status = 'failed', lease_expires_at = 0, locked_by = NULL, attempts = attempts + 1, last_error = ? WHERE id = ?
    `).run(error, id);
  }

  public getDeadLetterOutboxAlerts(): AlertOutboxRow[] {
    return this.db.prepare(`
      SELECT * FROM alert_outbox WHERE status != 'delivered' AND attempts >= 5 ORDER BY created_at DESC
    `).all() as AlertOutboxRow[];
  }

  public isAlertEventApplied(eventKey: string, userId: string, targetChat: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM applied_alert_events WHERE event_key = ? AND user_id = ? AND target_chat = ?
    `).get(eventKey, userId, targetChat);
    return !!row;
  }

  public applyDeliveredAlertMutation(params: {
    outboxId: number;
    eventKey: string;
    userId: string;
    targetChat: string;
    alert: TradeAlert;
    cardMutation?: {
      type: 'closed' | 'reduced' | 'increased' | 'opened';
      messageId: number;
      entryPx?: number;
      currentSize?: number;
      slicePnl?: number;
      closedSliceSize?: number;
      initialOpenTime?: number;
    };
  }): { alreadyApplied: boolean } {
    const { outboxId, eventKey, userId, targetChat, alert, cardMutation } = params;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      // 1. Check if already applied
      const existing = this.db.prepare(`
        SELECT 1 FROM applied_alert_events WHERE event_key = ? AND user_id = ? AND target_chat = ?
      `).get(eventKey, userId, targetChat);

      if (existing) {
        this.markOutboxDelivered(outboxId);
        return { alreadyApplied: true };
      }

      // 2. Claim / Record in applied_alert_events
      this.db.prepare(`
        INSERT INTO applied_alert_events (event_key, user_id, target_chat, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(eventKey, userId, targetChat, now);

      // 3. Apply position_cards mutation if provided
      if (cardMutation) {
        if (cardMutation.type === 'closed') {
          this.removePositionCard(targetChat, alert.address, alert.coin);
        } else if (cardMutation.type === 'reduced') {
          this.addCardRealizedPnl(
            targetChat,
            alert.address,
            alert.coin,
            cardMutation.slicePnl || 0,
            cardMutation.closedSliceSize || 0,
            cardMutation.currentSize || 0
          );
          if (cardMutation.messageId > 0) {
            this.db.prepare(`
              UPDATE position_cards SET message_id = ? WHERE chat_id = ? AND address = ? AND coin = ?
            `).run(cardMutation.messageId, targetChat, alert.address.toLowerCase(), alert.coin.toUpperCase());
          }
        } else if (cardMutation.type === 'increased' || cardMutation.type === 'opened') {
          this.savePositionCard(
            targetChat,
            alert.address,
            alert.coin,
            cardMutation.messageId,
            cardMutation.initialOpenTime || alert.timestamp || now,
            cardMutation.entryPx || alert.entryPx || 0,
            cardMutation.currentSize || alert.currentSize || 0
          );
        }
      }

      // 4. Log to alerts_history
      this.logAlert(alert, userId);

      // 5. Mark outbox row delivered
      this.markOutboxDelivered(outboxId);

      return { alreadyApplied: false };
    });

    return tx();
  }

  public getUndeliveredOutboxAlerts(maxAttempts: number = 5): Array<{
    id: number;
    eventKey: string;
    userId: string;
    targetChat: string;
    alert: TradeAlert;
    attempts: number;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM alert_outbox 
      WHERE status != 'delivered' AND attempts < ?
      ORDER BY created_at ASC
    `).all(maxAttempts) as AlertOutboxRow[];

    return rows.map(r => ({
      id: r.id,
      eventKey: r.event_key,
      userId: r.user_id,
      targetChat: r.target_chat,
      alert: JSON.parse(r.alert_json),
      attempts: r.attempts,
    }));
  }

  public pruneDeliveredRecords(olderThanDays: number = 7): { prunedInbox: number; prunedOutbox: number } {
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    const resOutbox = this.db.prepare(`
      DELETE FROM alert_outbox WHERE status = 'delivered' AND delivered_at < ?
    `).run(cutoff);
    const resInbox = this.db.prepare(`
      DELETE FROM fill_inbox WHERE status = 'delivered' AND created_at < ?
    `).run(cutoff);
    return {
      prunedInbox: resInbox.changes,
      prunedOutbox: resOutbox.changes,
    };
  }

  public getFillCursor(address: string): FillCursor | null {
    const row = this.db.prepare(`
      SELECT address, last_fill_time, last_fill_tid, updated_at
      FROM fill_cursors
      WHERE LOWER(address) = ?
    `).get(address.toLowerCase()) as FillCursorRow | null;

    if (!row) return null;
    return {
      address: row.address,
      lastFillTime: row.last_fill_time,
      lastFillTid: row.last_fill_tid,
      updatedAt: row.updated_at,
    };
  }

  public saveFillCursor(address: string, lastFillTime: number, lastFillTid: number): void {
    const addr = address.toLowerCase();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO fill_cursors (address, last_fill_time, last_fill_tid, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET
        last_fill_time = CASE WHEN excluded.last_fill_time >= fill_cursors.last_fill_time THEN excluded.last_fill_time ELSE fill_cursors.last_fill_time END,
        last_fill_tid = CASE WHEN excluded.last_fill_time >= fill_cursors.last_fill_time THEN excluded.last_fill_tid ELSE fill_cursors.last_fill_tid END,
        updated_at = excluded.updated_at
    `).run(addr, lastFillTime, lastFillTid, now);
  }

  // --- Users ---
  public upsertUser(user: User): void {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, min_notional_filter, show_buttons, mode, created_at)
      VALUES ($telegram_id, $username, $first_name, $min_notional_filter, $show_buttons, $mode, $created_at)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        mode = COALESCE(users.mode, excluded.mode);
    `);

    stmt.run({
      $telegram_id: user.telegramId,
      $username: user.username || null,
      $first_name: user.firstName || null,
      $min_notional_filter: user.minNotionalFilter || 0,
      $show_buttons: user.showButtons ? 1 : 0,
      $mode: user.mode || 'card',
      $created_at: user.createdAt || Date.now(),
    });
  }

  public getUser(telegramId: string): (User & { mode: string }) | null {
    const row = this.db.prepare(`
      SELECT * FROM users WHERE telegram_id = ?
    `).get(telegramId) as UserRow | null;

    if (!row) return null;

    return {
      telegramId: row.telegram_id,
      username: row.username || undefined,
      firstName: row.first_name || undefined,
      minNotionalFilter: row.min_notional_filter,
      showButtons: row.show_buttons === 1,
      mode: row.mode || 'card',
      createdAt: row.created_at,
    };
  }

  public getAllUsers(): Array<User & { mode: string }> {
    const rows = this.db.prepare(`SELECT * FROM users ORDER BY created_at ASC`).all() as UserRow[];
    return rows.map((row) => ({
      telegramId: row.telegram_id,
      username: row.username || undefined,
      firstName: row.first_name || undefined,
      minNotionalFilter: row.min_notional_filter,
      showButtons: row.show_buttons === 1,
      mode: row.mode || 'card',
      createdAt: row.created_at,
    }));
  }

  public updateUserFilter(telegramId: string, minNotionalUsd: number): void {
    this.db.prepare(`UPDATE users SET min_notional_filter = ? WHERE telegram_id = ?`).run(minNotionalUsd, telegramId);
  }

  public updateUserMode(telegramId: string, mode: 'card' | 'feed'): void {
    this.db.prepare(`UPDATE users SET mode = ? WHERE telegram_id = ?`).run(mode, telegramId);
  }

  // --- Tracked Wallets ---
  public addTrackedWallet(wallet: TrackedWallet): number {
    const stmt = this.db.prepare(`
      INSERT INTO tracked_wallets (user_id, address, label, chain, is_active, min_notional_usd, alert_chat_id, created_at)
      VALUES ($user_id, $address, $label, $chain, $is_active, $min_notional_usd, $alert_chat_id, $created_at)
      ON CONFLICT(user_id, address, chain) DO UPDATE SET
        label = excluded.label,
        is_active = 1,
        min_notional_usd = excluded.min_notional_usd,
        alert_chat_id = COALESCE(excluded.alert_chat_id, tracked_wallets.alert_chat_id);
    `);

    const res = stmt.run({
      $user_id: wallet.userId,
      $address: wallet.address.toLowerCase(),
      $label: wallet.label,
      $chain: wallet.chain,
      $is_active: wallet.isActive ? 1 : 0,
      $min_notional_usd: wallet.minNotionalUsd || 0,
      $alert_chat_id: wallet.alertChatId || null,
      $created_at: wallet.createdAt || Date.now(),
    });

    return Number(res.lastInsertRowid);
  }

  public removeTrackedWallet(userId: string, addressOrId: string | number, chain: string = 'hyperliquid'): { success: boolean; address?: string } {
    const targetStr = String(addressOrId).trim();
    const isNumericId = /^\d+$/.test(targetStr);

    let row: { id: number; address: string } | null = null;
    if (isNumericId) {
      const id = parseInt(targetStr, 10);
      row = this.db.prepare(`
        SELECT id, address FROM tracked_wallets 
        WHERE user_id = ? AND id = ?
      `).get(userId, id) as { id: number; address: string } | null;
    } else {
      row = this.db.prepare(`
        SELECT id, address FROM tracked_wallets 
        WHERE user_id = ? AND LOWER(address) = ? AND chain = ?
      `).get(userId, targetStr.toLowerCase(), chain) as { id: number; address: string } | null;
    }

    if (!row) return { success: false };

    const res = this.db.prepare(`DELETE FROM tracked_wallets WHERE id = ?`).run(row.id);
    return { success: res.changes > 0, address: row.address };
  }

  public setWalletActive(userId: string, address: string, isActive: boolean, chain: string = 'hyperliquid'): boolean {
    const res = this.db.prepare(`
      UPDATE tracked_wallets 
      SET is_active = ? 
      WHERE user_id = ? AND LOWER(address) = ? AND chain = ?
    `).run(isActive ? 1 : 0, userId, address.toLowerCase(), chain);

    return res.changes > 0;
  }

  public toggleWalletStatus(userId: string, id: number): { success: boolean; newStatus?: boolean; address?: string } {
    const row = this.db.prepare(`SELECT address, is_active FROM tracked_wallets WHERE user_id = ? AND id = ?`).get(userId, id) as { address: string; is_active: number } | null;
    if (!row) return { success: false };
    const newStatus = row.is_active === 1 ? 0 : 1;
    this.db.prepare(`UPDATE tracked_wallets SET is_active = ? WHERE user_id = ? AND id = ?`).run(newStatus, userId, id);
    return { success: true, newStatus: newStatus === 1, address: row.address };
  }

  public getTrackedWalletsByUser(userId: string): TrackedWallet[] {
    const rows = this.db.prepare(`
      SELECT * FROM tracked_wallets WHERE user_id = ? ORDER BY created_at ASC
    `).all(userId) as TrackedWalletRow[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      address: r.address,
      label: r.label,
      chain: r.chain as 'hyperliquid' | 'evm' | 'solana',
      isActive: r.is_active === 1,
      minNotionalUsd: r.min_notional_usd,
      alertChatId: r.alert_chat_id || undefined,
      createdAt: r.created_at,
    }));
  }

  public getTrackedWalletByUserAndAddress(userId: string, address: string, chain: string = 'hyperliquid'): TrackedWallet | null {
    const row = this.db.prepare(`
      SELECT * FROM tracked_wallets 
      WHERE user_id = ? AND LOWER(address) = ? AND chain = ?
    `).get(userId, address.toLowerCase(), chain) as TrackedWalletRow | null;

    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      address: row.address,
      label: row.label,
      chain: row.chain as 'hyperliquid' | 'evm' | 'solana',
      isActive: row.is_active === 1,
      minNotionalUsd: row.min_notional_usd,
      alertChatId: row.alert_chat_id || undefined,
      createdAt: row.created_at,
    };
  }

  public getAllActiveWallets(): TrackedWallet[] {
    const rows = this.db.prepare(`
      SELECT * FROM tracked_wallets WHERE is_active = 1
    `).all() as TrackedWalletRow[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      address: r.address,
      label: r.label,
      chain: r.chain as 'hyperliquid' | 'evm' | 'solana',
      isActive: true,
      minNotionalUsd: r.min_notional_usd,
      alertChatId: r.alert_chat_id || undefined,
      createdAt: r.created_at,
    }));
  }

  public getActiveDistinctAddresses(chain: string = 'hyperliquid'): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT LOWER(address) as address FROM tracked_wallets WHERE chain = ? AND is_active = 1
    `).all(chain) as Array<{ address: string }>;

    return rows.map(r => r.address);
  }

  public getDistinctAddresses(chain: string = 'hyperliquid'): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT LOWER(address) as address FROM tracked_wallets WHERE chain = ?
    `).all(chain) as Array<{ address: string }>;

    return rows.map(r => r.address);
  }

  public getSubscribersForAddress(address: string, chain: string = 'hyperliquid'): TrackedWallet[] {
    const rows = this.db.prepare(`
      SELECT * FROM tracked_wallets 
      WHERE LOWER(address) = ? AND chain = ? AND is_active = 1
    `).all(address.toLowerCase(), chain) as TrackedWalletRow[];

    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      address: r.address,
      label: r.label,
      chain: r.chain as 'hyperliquid' | 'evm' | 'solana',
      isActive: true,
      minNotionalUsd: r.min_notional_usd,
      alertChatId: r.alert_chat_id || undefined,
      createdAt: r.created_at,
    }));
  }

  public getSubscriberCountForAddress(address: string, chain: string = 'hyperliquid'): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as count FROM tracked_wallets 
      WHERE LOWER(address) = ? AND chain = ? AND is_active = 1
    `).get(address.toLowerCase(), chain) as { count: number } | null;

    return row?.count || 0;
  }

  // --- Position Cards (Edit-in-Place Lifetime Tracking) ---
  public savePositionCard(
    chatId: string,
    address: string,
    coin: string,
    messageId: number,
    openTime: number = Date.now(),
    entryPx: number = 0,
    size: number = 0
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO position_cards (chat_id, address, coin, message_id, initial_open_time, initial_entry_px, max_size, current_size, cum_realized_pnl, total_closed_size, created_at, updated_at)
      VALUES ($chat_id, $address, $coin, $message_id, $initial_open_time, $initial_entry_px, $max_size, $current_size, 0, 0, $created_at, $updated_at)
      ON CONFLICT(chat_id, address, coin) DO UPDATE SET
        message_id = CASE WHEN excluded.message_id > 0 THEN excluded.message_id ELSE position_cards.message_id END,
        current_size = excluded.current_size,
        max_size = MAX(position_cards.max_size, excluded.max_size),
        updated_at = excluded.updated_at;
    `);

    const now = Date.now();
    stmt.run({
      $chat_id: chatId,
      $address: address.toLowerCase(),
      $coin: coin.toUpperCase(),
      $message_id: messageId,
      $initial_open_time: openTime,
      $initial_entry_px: entryPx,
      $max_size: size,
      $current_size: size,
      $created_at: now,
      $updated_at: now,
    });
  }

  public addCardRealizedPnl(chatId: string, address: string, coin: string, pnl: number, closedSize: number, remainingSize: number): void {
    this.db.prepare(`
      UPDATE position_cards SET
        cum_realized_pnl = cum_realized_pnl + ?,
        total_closed_size = total_closed_size + ?,
        current_size = ?,
        updated_at = ?
      WHERE chat_id = ? AND address = ? AND coin = ?
    `).run(pnl, closedSize, remainingSize, Date.now(), chatId, address.toLowerCase(), coin.toUpperCase());
  }

  public getPositionCard(chatId: string, address: string, coin: string): {
    messageId: number;
    initialOpenTime: number;
    initialEntryPx: number;
    maxSize: number;
    currentSize: number;
    cumRealizedPnl: number;
    totalClosedSize: number;
  } | null {
    const row = this.db.prepare(`
      SELECT * FROM position_cards WHERE chat_id = ? AND address = ? AND coin = ?
    `).get(chatId, address.toLowerCase(), coin.toUpperCase()) as PositionCardRow | null;

    if (!row) return null;
    return {
      messageId: row.message_id,
      initialOpenTime: row.initial_open_time,
      initialEntryPx: row.initial_entry_px,
      maxSize: row.max_size,
      currentSize: row.current_size,
      cumRealizedPnl: row.cum_realized_pnl,
      totalClosedSize: row.total_closed_size,
    };
  }

  public removePositionCard(chatId: string, address: string, coin: string): void {
    this.db.prepare(`
      DELETE FROM position_cards WHERE chat_id = ? AND address = ? AND coin = ?
    `).run(chatId, address.toLowerCase(), coin.toUpperCase());
  }

  // --- Alerts History Logging ---
  public logAlert(alert: TradeAlert, userId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO alerts_history (user_id, address, wallet_label, alert_type, symbol, details_json, tx_hash, created_at)
      VALUES ($user_id, $address, $wallet_label, $alert_type, $symbol, $details_json, $tx_hash, $created_at)
    `);

    stmt.run({
      $user_id: userId || null,
      $address: alert.address.toLowerCase(),
      $wallet_label: alert.walletLabel || 'Trader',
      $alert_type: alert.type,
      $symbol: alert.symbol,
      $details_json: JSON.stringify(alert),
      $tx_hash: alert.txHash || null,
      $created_at: alert.timestamp || Date.now(),
    });
  }

  public getRecentAlerts(limit: number = 20): Array<{
    id: number;
    user_id: string | null;
    address: string;
    wallet_label: string;
    alert_type: string;
    symbol: string;
    details: TradeAlert;
    created_at: number;
  }> {
    const rows = this.db.prepare(`
      SELECT * FROM alerts_history ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: number;
      user_id: string | null;
      address: string;
      wallet_label: string;
      alert_type: string;
      symbol: string;
      details_json: string;
      created_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      address: r.address,
      wallet_label: r.wallet_label,
      alert_type: r.alert_type,
      symbol: r.symbol,
      details: JSON.parse(r.details_json),
      created_at: r.created_at,
    }));
  }

  public close(): void {
    this.db.close();
  }
}

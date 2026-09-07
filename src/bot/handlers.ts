import { Bot, Context, InlineKeyboard } from 'grammy';
import type { DatabaseManager } from '../db/database.js';
import type { HyperliquidService } from '../services/hyperliquid.js';
import { AlertFormatter, escapeTelegramHtml } from '../services/formatter.js';
import type { TradeAlert } from '../types/index.js';


export class BotHandlers {
  private bot: Bot;
  private db: DatabaseManager;
  private hlService: HyperliquidService;
  private pendingAddUserState: Map<string, { step: 'awaiting_address_or_label'; address?: string }> = new Map();
  private outboxWorkerInterval?: NodeJS.Timeout;
  private retentionInterval?: NodeJS.Timeout;
  private marketSummaryInterval?: NodeJS.Timeout;
  private isStopped: boolean = false;
  private activeDrainPromise: Promise<void> | null = null;

  constructor(bot: Bot, db: DatabaseManager, hlService: HyperliquidService) {
    this.bot = bot;
    this.db = db;
    this.hlService = hlService;
    this.registerHandlers();
    this.registerAlertDispatcher();
    this.startOutboxWorker();
    this.startRetentionPruner();
    this.startDailyMarketSummaryScheduler();
  }
  private registerHandlers(): void {
    // /start command
    this.bot.command('start', async (ctx) => {
      await this.handleStart(ctx);
    });

    // /help command
    this.bot.command('help', async (ctx) => {
      await this.handleHelp(ctx);
    });

    // /status or /stats command
    this.bot.command(['status', 'stats'], async (ctx) => {
      const userId = String(ctx.from?.id);
      const user = this.db.getUser(userId);
      const userWallets = this.db.getTrackedWalletsByUser(userId);
      const allActive = this.db.getAllActiveWallets();
      const health = this.hlService.getFeedHealth();
      const pendingInbox = this.db.getPendingInboxCount();
      const undeliveredOutbox = this.db.getUndeliveredOutboxCount();

      let feedStatusStr = '🔴 Offline (Connecting)';
      if (health.isConnected) {
        if (health.isStalled) {
          feedStatusStr = `🟡 Stalled (No trade/pong in ${health.timeSinceLastMessageSeconds}s)`;
        } else {
          feedStatusStr = `🟢 Healthy (Live socket active)`;
        }
      }

      const text = [
        `📊 <b>System & Feed Status</b>`,
        ``,
        `⚡ <b>Hyperliquid Feed:</b> ${feedStatusStr}`,
        `⏱ <b>Last Feed Activity:</b> <code>${health.timeSinceLastMessageSeconds}s ago</code>`,
        `💼 <b>Your Tracked Wallets:</b> <code>${userWallets.length}</code>`,
        `🌐 <b>Global Active Subscriptions:</b> <code>${allActive.length}</code> (${health.subscribedCount} socket topics)`,
        `📥 <b>Pending Ingest Queue:</b> <code>${pendingInbox}</code>`,
        `📤 <b>Pending Outbox Deliveries:</b> <code>${undeliveredOutbox}</code>`,
        `📑 <b>Your Alert Mode:</b> <code>${user?.mode === 'feed' ? 'Stream Feed' : 'Live Card (Edit in Place)'}</code>`,
        `🔔 <b>Outbox Leasing Worker:</b> <code>Active</code>`,
      ].join('\n');

      await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard()
          .text('📋 View Watchlist', 'action_list')
          .text('➕ Add Wallet', 'action_add')
          .row()
          .text('🌅 Market Summary', 'action_summary')
          .text('🧪 Demo Alert', 'action_demo'),
      });
    });

    // /summary, /market, /hyperdash, /nyopen, /marketsummary
    this.bot.command(['summary', 'market', 'hyperdash', 'nyopen', 'marketsummary'], async (ctx) => {
      await this.handleMarketSummary(ctx);
    });
    // /mode command: /mode card | /mode feed
    this.bot.command('mode', async (ctx) => {
      const text = ctx.message?.text || '';
      const modeArg = text.split(/\s+/)[1]?.toLowerCase();

      if (modeArg === 'card' || modeArg === 'feed') {
        const userId = String(ctx.from?.id);
        this.db.updateUserMode(userId, modeArg as 'card' | 'feed');
        await ctx.reply(
          `✅ <b>Alert Mode Updated!</b>\n\n` +
          `Current Mode: <b>${modeArg === 'card' ? 'Live Card (Edit-in-Place)' : 'Stream Feed'}</b>\n\n` +
          `${modeArg === 'card' ? '• Messages update silently as positions scale/close without spam.' : '• Every trade fill is delivered as a new separate message.'}`,
          { parse_mode: 'HTML' }
        );
      } else {
        const userId = String(ctx.from?.id);
        const user = this.db.getUser(userId);
        await ctx.reply(
          `⚙️ <b>Notification Display Mode:</b>\n\n` +
          `Current mode: <b>${user?.mode === 'feed' ? 'Stream Feed' : 'Live Card (Edit-in-Place)'}</b>\n\n` +
          `• <code>/mode card</code> — Live Card Mode: One message per position, edited silently as size changes (recommended).\n` +
          `• <code>/mode feed</code> — Feed Mode: New message for every single fill event.`,
          { parse_mode: 'HTML' }
        );
      }
    });

    // /add command: /add <address> [label]
    this.bot.command('add', async (ctx) => {
      const text = ctx.message?.text || '';
      const parts = text.split(/\s+/).slice(1);
      if (parts.length === 0) {
        await ctx.reply(
          `📝 <b>How to Add a Hyperliquid Address:</b>\n\n` +
          `Format: <code>/add &lt;0xAddress&gt; [Optional Nickname]</code>\n\n` +
          `<b>Examples:</b>\n` +
          `• <code>/add 0x4e60e3a4a32d63d245aa4e4ce304b4254b088f95 Whale-Alpha</code>\n` +
          `• <code>/add 0x020c8678d257a390ac05a0001ece34f29988316b MachiBigBrother</code>\n\n` +
          `Or click the button below to paste step-by-step:`,
          {
            parse_mode: 'HTML',
            reply_markup: new InlineKeyboard().text('➕ Add Address Now', 'action_add'),
          }
        );
        return;
      }

      const address = parts[0];
      const label = parts.slice(1).join(' ');
      await this.processAddWallet(ctx, address, label);
    });

    // /list command
    this.bot.command('list', async (ctx) => {
      await this.handleList(ctx);
    });

    // /pos, /positions, /p, /refresh command: /pos [address or label]
    this.bot.command(['pos', 'positions', 'p', 'refresh'], async (ctx) => {
      const text = ctx.message?.text || '';
      let query = text.split(/\s+/).slice(1).join(' ').trim();

      if (ctx.message?.reply_to_message && ctx.message.reply_to_message.from?.id === ctx.me.id) {
        const replied = ctx.message.reply_to_message;
        const repliedText = replied.text || '';
        const addrMatch = query.match(/0x[a-fA-F0-9]{40}/i) || repliedText.match(/0x[a-fA-F0-9]{40}/i);
        if (addrMatch) {
          await this.handlePositionsQueryReplyEdit(ctx, addrMatch[0], replied.message_id);
          return;
        }
      }

      await this.handlePositionsQuery(ctx, query);
    });

    if (typeof this.bot.hears === 'function') {
      this.bot.hears(/^\/(?:positions?|pos)_([a-fA-F0-9]+)/i, async (ctx) => {
        const match = ctx.match;
        const prefix = match[1]?.toLowerCase();
        if (prefix) {
          await this.handlePositionsQuery(ctx, prefix);
        }
      });
    }

    // /top or /whales or /leaderboard command
    this.bot.command(['top', 'whales', 'leaderboard'], async (ctx) => {
      await this.handleLeaderboard(ctx);
    });

    // /filter command: /filter <min_usd>
    this.bot.command('filter', async (ctx) => {
      const text = ctx.message?.text || '';
      const valStr = text.split(/\s+/)[1];
      const val = parseFloat(valStr);

      if (isNaN(val) || val < 0) {
        const user = this.db.getUser(String(ctx.from?.id));
        const current = user?.minNotionalFilter || 0;
        await ctx.reply(
          `⚙️ <b>Trade Size Filter:</b>\n\n` +
          `Current minimum trade size filter: <b>${AlertFormatter.formatUsd(current)}</b>\n\n` +
          `To change, send: <code>/filter &lt;amount_usd&gt;</code>\n` +
          `Example: <code>/filter 5000</code> (only alerts for trades >= $5,000)\n` +
          `Set to <code>0</code> to receive all alerts.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      this.db.updateUserFilter(String(ctx.from?.id), val);
      await ctx.reply(
        `✅ Filter updated! You will only receive alerts for positions/trades >= <b>${AlertFormatter.formatUsd(val)}</b>.`,
        { parse_mode: 'HTML' }
      );
    });

    // /remove command: /remove <address or id>
    this.bot.command('remove', async (ctx) => {
      const text = ctx.message?.text || '';
      const target = text.split(/\s+/)[1];
      if (!target) {
        await ctx.reply('Please specify an address or #ID to remove. Example: <code>/remove 0x...</code>', { parse_mode: 'HTML' });
        return;
      }

      const userId = String(ctx.from?.id);
      const result = this.db.removeTrackedWallet(userId, target);
      if (result.success && result.address) {
        const remainingCount = this.db.getSubscriberCountForAddress(result.address, 'hyperliquid');
        if (remainingCount === 0) {
          this.hlService.unsubscribe(result.address);
        }
        await ctx.reply(`🗑 Removed <code>${result.address}</code> from your watchlist.`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`❌ Address or ID not found in your watchlist.`, { parse_mode: 'HTML' });
      }
    });

    // /demo command
    this.bot.command('demo', async (ctx) => {
      await this.sendDemoAlerts(ctx);
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      if (data === 'menu_start') {
        await ctx.answerCallbackQuery();
        await this.handleStart(ctx, true);
        return;
      }

      if (data === 'action_list') {
        await ctx.answerCallbackQuery();
        await this.handleList(ctx, true);
        return;
      }

      if (data === 'action_add') {
        await ctx.answerCallbackQuery();
        this.pendingAddUserState.set(String(ctx.from.id), { step: 'awaiting_address_or_label' });
        await ctx.reply(
          `📝 <b>Send the Hyperliquid Address:</b>\n\n` +
          `Paste the <code>0x...</code> wallet address and an optional nickname in one message.\n\n` +
          `<b>Format:</b> <code>0x1234...5678 CustomName</code>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      if (data === 'action_top') {
        await ctx.answerCallbackQuery();
        await this.handleLeaderboard(ctx, true);
        return;
      }

      if (data === 'action_summary') {
        await ctx.answerCallbackQuery();
        await this.handleMarketSummary(ctx, true);
        return;
      }

      if (data === 'action_demo') {
        await ctx.answerCallbackQuery();
        await this.sendDemoAlerts(ctx);
        return;
      }
      if (data === 'action_positions') {
        await ctx.answerCallbackQuery();
        await this.handlePositionsQuery(ctx, '', true);
        return;
      }

      if (data.startsWith('pos_')) {
        const address = data.replace('pos_', '');
        await this.handlePositionsQuery(ctx, address, true);
        return;
      }

      if (data.startsWith('toggle_')) {
        await ctx.answerCallbackQuery();
        const id = parseInt(data.replace('toggle_', ''), 10);
        const result = this.db.toggleWalletStatus(String(ctx.from.id), id);
        if (result.success && result.address) {
          if (result.newStatus) {
            await this.hlService.seedAndSubscribe(result.address);
            await ctx.reply('🟢 Wallet notifications resumed.');
          } else {
            const count = this.db.getSubscriberCountForAddress(result.address, 'hyperliquid');
            if (count === 0) {
              this.hlService.unsubscribe(result.address);
            }
            await ctx.reply('⏸ Wallet notifications paused.');
          }
        }
        await this.handleList(ctx, false);
        return;
      }

      if (data.startsWith('del_')) {
        await ctx.answerCallbackQuery();
        const id = data.replace('del_', '');
        const userId = String(ctx.from.id);
        const result = this.db.removeTrackedWallet(userId, id);
        if (result.success && result.address) {
          const count = this.db.getSubscriberCountForAddress(result.address, 'hyperliquid');
          if (count === 0) {
            this.hlService.unsubscribe(result.address);
          }
          await ctx.reply(`🗑 Wallet <code>${result.address}</code> deleted from your watchlist.`, { parse_mode: 'HTML' });
        }
        await this.handleList(ctx, false);
        return;
      }

      if (data.startsWith('track_')) {
        await ctx.answerCallbackQuery();
        const address = data.replace('track_', '');
        await this.processAddWallet(ctx, address, `Whale-${address.slice(0, 6)}`);
        return;
      }

      // Live PnL Refresh on Card Button tap: refresh_<address>_<coin>
      if (data.startsWith('refresh_')) {
        const parts = data.replace('refresh_', '').split('_');
        const address = parts[0];
        const coin = parts[1];
        await this.handleLivePnLRefresh(ctx, address, coin);
        return;
      }
    });

    // Plain text message handler (for interactive wizard)
    this.bot.on('message:text', async (ctx) => {
      const userId = String(ctx.from?.id);
      const pending = this.pendingAddUserState.get(userId);
      const text = ctx.message.text.trim();
      const posMatch = text.match(/^\/(?:positions?|pos)_([a-fA-F0-9]+)/i);
      if (posMatch && posMatch[1]) {
        await this.handlePositionsQuery(ctx, posMatch[1].toLowerCase());
        return;
      }

      if (pending && pending.step === 'awaiting_address_or_label') {
        const parts = text.split(/\s+/);
        const address = parts[0];
        const label = parts.slice(1).join(' ');

        this.pendingAddUserState.delete(userId);
        await this.processAddWallet(ctx, address, label);
      }
    });
  }

  // --- Handlers Implementation ---
  private async handleStart(ctx: Context, isEdit: boolean = false): Promise<void> {
    if (ctx.from) {
      this.db.upsertUser({
        telegramId: String(ctx.from.id),
        username: ctx.from.username,
        firstName: ctx.from.first_name,
        minNotionalFilter: 0,
        showButtons: true,
        mode: 'card',
        createdAt: Date.now(),
      });
    }

    const userId = String(ctx.from?.id);
    const wallets = this.db.getTrackedWalletsByUser(userId);
    const activeCount = wallets.filter((w) => w.isActive).length;
    const isConnected = this.hlService.getIsConnected();

    const text = [
      `⚡ <b>Hyperliquid Smart Money & Whale Tracker</b>`,
      `<i>Real-time position tracking, size increases, closes & PnL alerts</i>`,
      ``,
      `💼 <b>Your Watchlist:</b> <code>${activeCount}</code> active wallets (${wallets.length} total)`,
      `📑 <b>Display Mode:</b> <code>Live Card (Edit in Place)</code>`,
      `🔔 <b>Status:</b> ${isConnected ? '🟢 Live WebSocket connected' : '🔴 Connecting/Offline'}`,
      ``,
      `Select an option below to manage addresses, view market summaries, or discover whales:`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('➕ Add Address', 'action_add')
      .text('📋 Tracked Wallets', 'action_list')
      .row()
      .text('🏆 Top Whales', 'action_top')
      .text('🌅 Market Summary', 'action_summary')
      .row()
      .text('🧪 Test Live Alert', 'action_demo')
      .url('🌐 Hyperliquid Web', 'https://app.hyperliquid.xyz');

    if (isEdit && ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  private async handleHelp(ctx: Context): Promise<void> {
    const text = [
      `📖 <b>Tracker Bot Commands:</b>`,
      ``,
      `• <code>/start</code> - Main control dashboard`,
      `• <code>/add &lt;0xAddress&gt; [Label]</code> - Add a wallet to track`,
      `• <code>/remove &lt;0xAddress or ID&gt;</code> - Remove a wallet`,
      `• <code>/list</code> - View all your tracked wallets & open positions`,
      `• <code>/positions &lt;address or label&gt;</code> (or <code>/refresh</code>) - View current live positions & uPnL`,
      `• <code>/summary</code> - Hyperdash 24h market summary & stats`,
      `• <code>/top</code> - Browse top active Hyperliquid whales & 1-click track`,
      `• <code>/filter &lt;min_usd&gt;</code> - Set minimum trade size notification filter`,
      `• <code>/mode &lt;card | feed&gt;</code> - Toggle Edit-in-Place Live Card or Feed mode`,
      `• <code>/status</code> - Check system health and WebSocket connection`,
      `• <code>/demo</code> - Simulate live alert sequence`,
      ``,
      `<b>Alert Types:</b>`,
      `🟢 Position Opened (LONG / SHORT, Entry Px, Size, Notional)`,
      `🔼 Position Increased (Added $, New Size, Blended Entry, VWAP)`,
      `📉 Position Reduced (Exit Px, Remaining Size, Slice Profit/Loss)`,
      `🎯 Position Closed (Entry Px, Exit Px, Realized PnL, ROI %, Held Duration)`,
    ].join('\n');

    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  private async handleMarketSummary(ctx: Context, isEdit: boolean = false): Promise<void> {
    try {
      const summary = await this.hlService.getMarketSummary();
      const text = AlertFormatter.formatMarketSummary(summary);
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Summary', 'action_summary')
        .text('🏆 Top Whales', 'action_top')
        .row()
        .text('🔙 Back to Dashboard', 'menu_start');

      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (err) {
      console.error('Error generating market summary:', err);
      await ctx.reply('⚠️ Failed to generate market summary from Hyperliquid API. Please try again in a moment.');
    }
  }

  private async processAddWallet(ctx: Context, rawAddress: string, rawLabel?: string): Promise<void> {
    const address = rawAddress.trim().toLowerCase();

    // Validate EVM / Hyperliquid address format
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      await ctx.reply(
        `❌ Invalid address format. Please provide a valid 42-character Ethereum / Hyperliquid address starting with <code>0x...</code>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const userId = String(ctx.from?.id);
    const cleanLabel = rawLabel && rawLabel.trim().length > 0 ? rawLabel.trim() : `Whale-${address.slice(0, 6)}`;
    const safeLabel = escapeTelegramHtml(cleanLabel);

    const user = this.db.getUser(userId);
    const defaultThreshold = user?.minNotionalFilter && user.minNotionalFilter > 0 ? user.minNotionalFilter : 1000;

    this.db.addTrackedWallet({
      userId,
      address,
      label: cleanLabel,
      chain: 'hyperliquid',
      isActive: true,
      minNotionalUsd: defaultThreshold,
      alertChatId: userId,
      createdAt: Date.now(),
    });

    // Cold-start seed & subscribe
    await this.hlService.seedAndSubscribe(address);
    const keyboard = new InlineKeyboard()
      .text('📊 Check Live Positions', `pos_${address}`)
      .text('📋 View Watchlist', 'action_list');

    await ctx.reply(
      `✅ <b>Wallet Added to Watchlist!</b>\n\n` +
      `👤 <b>Label:</b> <code>${safeLabel}</code>\n` +
      `👛 <b>Address:</b> <code>${address}</code>\n` +
      `⚡ <b>Platform:</b> Hyperliquid Perps\n` +
      `🔔 <b>Alerts:</b> Active (Instant WebSocket)\n\n` +
      `You will receive real-time alerts whenever <b>${safeLabel}</b> opens, increases, reduces, or closes positions!`,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  }

  private async handleList(ctx: Context, isEdit: boolean = false): Promise<void> {
    const userId = String(ctx.from?.id);
    const wallets = this.db.getTrackedWalletsByUser(userId);

    if (wallets.length === 0) {
      const text = [
        `📋 <b>Your Watchlist is Empty</b>`,
        ``,
        `You are not tracking any wallets yet.`,
        `Add top Hyperliquid traders or browse the leaderboard to start receiving alerts.`,
      ].join('\n');

      const keyboard = new InlineKeyboard()
        .text('➕ Add Address', 'action_add')
        .text('🏆 Browse Top Whales', 'action_top');

      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
      return;
    }

    const text = [
      `📋 <b>Your Tracked Wallets (${wallets.length}):</b>`,
      `<i>Click status to pause/resume, or trash to remove</i>\n`,
    ];

    const keyboard = new InlineKeyboard();

    wallets.forEach((w, idx) => {
      const statusIcon = w.isActive ? '🟢' : '⏸';
      const safeLabel = escapeTelegramHtml(w.label);
      text.push(
        `${idx + 1}. ${statusIcon} <b>${safeLabel}</b>\n` +
        `   <code>${w.address}</code>\n` +
        `   /positions_${w.address.slice(2, 8)}\n`
      );

      keyboard
        .text(`${statusIcon} ${w.label.slice(0, 12)}`, `toggle_${w.id}`)
        .text('📊 Pos', `pos_${w.address}`)
        .text('🗑', `del_${w.id}`)
        .row();
    });

    keyboard.text('➕ Add Another', 'action_add').text('🔙 Main Menu', 'menu_start');

    if (isEdit && ctx.callbackQuery?.message) {
      await ctx.editMessageText(text.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(text.join('\n'), { parse_mode: 'HTML', reply_markup: keyboard });
    }
  }

  private async handlePositionsQuery(ctx: Context, query: string, isEdit: boolean = false): Promise<void> {
    const userId = String(ctx.from?.id);
    let targetAddress = query.toLowerCase().trim();

    if (!targetAddress) {
      const userWallets = this.db.getTrackedWalletsByUser(userId);
      if (userWallets.length === 0) {
        const noWalletsText = 'You are not tracking any wallets. Use <code>/add &lt;0xAddress&gt; [Label]</code> first, or <code>/pos &lt;0xAddress&gt;</code>.';
        if (isEdit && ctx.callbackQuery?.message) {
          await ctx.editMessageText(noWalletsText, { parse_mode: 'HTML' });
        } else {
          await ctx.reply(noWalletsText, { parse_mode: 'HTML' });
        }
        return;
      }

      if (userWallets.length === 1) {
        targetAddress = userWallets[0].address.toLowerCase();
      } else {
        const keyboard = new InlineKeyboard();
        userWallets.forEach((w) => {
          keyboard.text(`${w.label} (${w.address.slice(0, 6)})`, `pos_${w.address}`).row();
        });
        keyboard.text('🔙 Watchlist', 'action_list');

        if (isEdit && ctx.callbackQuery?.message) {
          await ctx.editMessageText('Select a tracked wallet to inspect live positions:', { reply_markup: keyboard });
        } else {
          await ctx.reply('Select a tracked wallet to inspect live positions:', { reply_markup: keyboard });
        }
        return;
      }
    }

    let resolvedLabel = '';
    if (!targetAddress.startsWith('0x')) {
      const userWallets = this.db.getTrackedWalletsByUser(userId);
      const match = userWallets.find(
        (w) => w.label.toLowerCase().includes(targetAddress) || w.address.toLowerCase().includes(targetAddress)
      );
      if (match) {
        targetAddress = match.address.toLowerCase();
        resolvedLabel = match.label;
      } else {
        const allWallets = this.db.getAllActiveWallets();
        const globalMatch = allWallets.find(
          (w) => w.label.toLowerCase().includes(targetAddress) || w.address.toLowerCase().includes(targetAddress)
        );
        if (globalMatch) {
          targetAddress = globalMatch.address.toLowerCase();
          resolvedLabel = globalMatch.label;
        }
      }
    }

    if (!targetAddress.startsWith('0x') || targetAddress.length !== 42) {
      const notFoundText =
        `❌ No tracked wallet matching "<b>${escapeTelegramHtml(query)}</b>".\n\n` +
        `Usage: <code>/pos &lt;label or 0xAddress&gt;</code>\n` +
        `Examples:\n` +
        `• <code>/pos bittex</code>\n` +
        `• <code>/pos 0x8def9f50456c6c4e37fa5d3d57f108ed23992dae</code>\n` +
        `• <code>/list</code> to see your tracked labels.`;
      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(notFoundText, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(notFoundText, { parse_mode: 'HTML' });
      }
      return;
    }

    try {
      const summary = await this.hlService.getAccountSummary(targetAddress);
      if (!resolvedLabel) {
        const userWallets = this.db.getTrackedWalletsByUser(userId);
        const walletRecord = userWallets.find((w) => w.address.toLowerCase() === targetAddress);
        resolvedLabel = walletRecord?.label || `${targetAddress.slice(0, 6)}...${targetAddress.slice(-4)}`;
      }

      const text = AlertFormatter.formatPositionsSummary(resolvedLabel, targetAddress, summary);
      const keyboard = new InlineKeyboard()
        .url('👤 Show Profile', `https://hyperdash.com/address/${targetAddress}`);

      if (summary.positions && summary.positions.length > 0) {
        const topPos = summary.positions[0];
        keyboard
          .url(`🎯 Show Position (${topPos.coin})`, `https://hyperdash.com/?chart1=${encodeURIComponent(topPos.coin)}&snoop=${targetAddress}`)
          .url(`📈 Chart`, `https://app.hyperliquid.xyz/trade/${topPos.coin}`);
      }

      keyboard
        .row()
        .text('🔄 Refresh', `pos_${targetAddress}`)
        .text('📋 Watchlist', 'action_list');

      if (isEdit && ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
          await ctx.answerCallbackQuery({ text: '🔄 Positions refreshed!' }).catch(() => {});
        } catch (editErr: unknown) {
          const errMsg = editErr instanceof Error ? editErr.message : String(editErr);
          const isNotModified = 'description' in (editErr as Record<string, unknown> || {})
            ? String((editErr as Record<string, unknown>).description).includes('message is not modified')
            : errMsg.includes('message is not modified');
          if (isNotModified) {
            await ctx.answerCallbackQuery({ text: '⚡ Positions up to date' }).catch(() => {});
          } else {
            console.warn('Failed to edit message in handlePositionsQuery, falling back to reply:', editErr);
            await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
          }
        }
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (err: unknown) {
      console.error('Failed to query positions:', err);
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: '❌ Failed to fetch positions', show_alert: true }).catch(() => {});
      }
      if (!isEdit) {
        await ctx.reply(`❌ Could not fetch positions for <code>${escapeTelegramHtml(targetAddress)}</code>. Ensure address exists on Hyperliquid.`, {
          parse_mode: 'HTML',
        });
      }
    }
  }

  private async handlePositionsQueryReplyEdit(ctx: Context, targetAddress: string, messageId: number): Promise<void> {
    const userId = String(ctx.from?.id);
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    try {
      const summary = await this.hlService.getAccountSummary(targetAddress);
      const userWallets = this.db.getTrackedWalletsByUser(userId);
      const walletRecord = userWallets.find((w) => w.address.toLowerCase() === targetAddress.toLowerCase());
      const resolvedLabel = walletRecord?.label || `${targetAddress.slice(0, 6)}...${targetAddress.slice(-4)}`;

      const text = AlertFormatter.formatPositionsSummary(resolvedLabel, targetAddress, summary);
      const keyboard = new InlineKeyboard()
        .url('👤 Show Profile', `https://hyperdash.com/address/${targetAddress}`);

      if (summary.positions && summary.positions.length > 0) {
        const topPos = summary.positions[0];
        keyboard
          .url(`🎯 Show Position (${topPos.coin})`, `https://hyperdash.com/?chart1=${encodeURIComponent(topPos.coin)}&snoop=${targetAddress}`)
          .url(`📈 Chart`, `https://app.hyperliquid.xyz/trade/${topPos.coin}`);
      }

      keyboard
        .row()
        .text('🔄 Refresh', `pos_${targetAddress}`)
        .text('📋 Watchlist', 'action_list');

      await this.bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });

      try {
        await ctx.deleteMessage();
      } catch {
        // ignore delete failure
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isNotModified = 'description' in (err as Record<string, unknown> || {})
        ? String((err as Record<string, unknown>).description).includes('message is not modified')
        : errMsg.includes('message is not modified');
      if (isNotModified) {
        try {
          await ctx.deleteMessage();
        } catch {}
        return;
      }
      console.error('Failed to edit replied positions message:', err);
      await ctx.reply(`❌ Could not refresh positions for <code>${escapeTelegramHtml(targetAddress)}</code>.`, {
        parse_mode: 'HTML',
      });
    }
  }

  private async handleLeaderboard(ctx: Context, isEdit: boolean = false): Promise<void> {
    try {
      const topTraders = await this.hlService.discoverActiveWhales();
      if (topTraders.length === 0) {
        await ctx.reply('Discovering active traders... please try again in a few seconds.');
        return;
      }

      const text = AlertFormatter.formatLeaderboard(topTraders.slice(0, 8));
      const keyboard = new InlineKeyboard();

      topTraders.slice(0, 5).forEach((t) => {
        const safeName = escapeTelegramHtml(t.name);
        keyboard.text(`➕ Track ${safeName.slice(0, 16)}`, `track_${t.address}`).row();
      });

      keyboard.text('🔙 Back to Dashboard', 'menu_start');

      if (isEdit && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
      } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (err) {
      console.error('Error fetching leaderboard:', err);
      await ctx.reply('Failed to fetch whale leaderboard. Please try again later.');
    }
  }

  private async handleLivePnLRefresh(ctx: Context, address: string, coin: string): Promise<void> {
    try {
      const summary = await this.hlService.getAccountSummary(address);
      const pos = summary.positions.find((p) => p.coin.toUpperCase() === coin.toUpperCase());
      const wallets = this.db.getTrackedWalletsByUser(String(ctx.from?.id));
      const wallet = wallets.find(w => w.address.toLowerCase() === address.toLowerCase());
      const label = escapeTelegramHtml(wallet?.label || address.slice(0, 6) + '...' + address.slice(-4));
      if (!pos) {
        await ctx.answerCallbackQuery({ text: `Position in ${coin} is closed or no longer active.`, show_alert: true });
        return;
      }

      await ctx.answerCallbackQuery({ text: `Updated PnL: ${AlertFormatter.formatUsd(pos.unrealizedPnl)}` });

      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
      const pnlColor = pos.unrealizedPnl >= 0 ? '🟢' : '🔴';
      const sideIcon = pos.side === 'LONG' ? '🟢' : '🔴';
      const levStr = pos.leverage ? ` · <b>${pos.leverage}x</b>` : '';

      const text = [
        `<b>${label}</b> Active <b>${pos.side}</b> Position: ${sideIcon}${levStr} <i>(Live Refreshed)</i>`,
        `⚡ <b>Symbol:</b> <code>${pos.coin}USD</code>`,
        `🔹 <b>Current Size:</b> <code>${AlertFormatter.formatNumber(pos.size)}</code>`,
        `🔹 <b>Entry Price:</b> <code>$${AlertFormatter.formatNumber(pos.entryPx, 2, 6)}</code>`,
        `💎 <b>Notional Value:</b> <code>${AlertFormatter.formatUsd(pos.notionalValue)}</code>`,
        `💰 <b>Unrealized PnL:</b> <code>${pnlSign}${AlertFormatter.formatUsd(pos.unrealizedPnl)}</code> ${pnlColor}`,
      ];

      if (pos.liquidationPx) {
        text.push(`⚠️ <b>Liq Price:</b> <code>${AlertFormatter.formatUsd(pos.liquidationPx)}</code>`);
      }

      const alertMock: TradeAlert = {
        type: 'position_increased',
        walletLabel: label,
        address,
        chain: 'hyperliquid',
        coin,
        symbol: `${coin}USD`,
        side: pos.side,
        currentSize: pos.size,
        entryPx: pos.entryPx,
        notionalValue: pos.notionalValue,
        timestamp: Date.now(),
      };

      const keyboard = AlertFormatter.createAlertKeyboard(alertMock, true);

      if (ctx.callbackQuery?.message) {
        try {
          await ctx.editMessageText(text.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (editErr: unknown) {
          const errMsg = editErr instanceof Error ? editErr.message : String(editErr);
          const isNotModified = 'description' in (editErr as Record<string, unknown> || {})
            ? String((editErr as Record<string, unknown>).description).includes('message is not modified')
            : errMsg.includes('message is not modified');
          if (!isNotModified) {
            throw editErr;
          }
        }
      }
    } catch (err: unknown) {
      console.error('Error refreshing PnL:', err);
    }
  }

  // --- Alert Dispatcher with Edit-in-Place Engine ---
  private registerAlertDispatcher(): void {
    this.hlService.onAlert(async (alert: TradeAlert) => {
      await this.dispatchAlert(alert);
    });
  }

  public async stop(): Promise<void> {
    if (this.isStopped) return;
    this.isStopped = true;
    if (this.outboxWorkerInterval) {
      clearInterval(this.outboxWorkerInterval);
      this.outboxWorkerInterval = undefined;
    }
    if (this.marketSummaryInterval) {
      clearInterval(this.marketSummaryInterval);
      this.marketSummaryInterval = undefined;
    }
    if (this.retentionInterval) {
      clearInterval(this.retentionInterval);
      this.retentionInterval = undefined;
    }
    if (this.activeDrainPromise) {
      try {
        await this.activeDrainPromise;
      } catch {
        // ignore
      }
    }
  }

  public async dispatchAlert(alert: TradeAlert): Promise<void> {
    if (this.isStopped) return;
    const subscribers = this.db.getSubscribersForAddress(alert.address, 'hyperliquid');
    if (subscribers.length === 0) return;

    const eventKey = alert.eventKey || `${alert.address}:${alert.coin}:${alert.timestamp}:${alert.type}:0`;

    // 1. Create/confirm recipient outbox records for each subscriber
    for (const sub of subscribers) {
      const targetChat = sub.alertChatId || sub.userId;
      const customizedAlert: TradeAlert = {
        ...alert,
        walletLabel: sub.label || alert.walletLabel || 'Trader',
      };
      this.db.getOrCreateOutboxRecord(eventKey, sub.userId, targetChat, customizedAlert);
    }

    // 2. Wake and await single-flight outbox drain
    await this.triggerOutboxDrain();

    // 3. Propagate delivery failure if outbox records failed
    const undelivered = this.db.getUndeliveredOutboxAlerts();
    const failedForEvent = undelivered.filter((u) => u.eventKey === eventKey && u.attempts > 0);
    if (failedForEvent.length > 0) {
      throw new Error(`Delivery failed for ${failedForEvent.length}/${subscribers.length} subscribers`);
    }
  }

  // --- Single-Flight Non-Overlapping Outbox Drain ---
  public triggerOutboxDrain(): Promise<void> {
    if (this.isStopped) return Promise.resolve();
    if (this.activeDrainPromise) {
      return this.activeDrainPromise;
    }
    this.activeDrainPromise = this.drainOutbox().finally(() => {
      this.activeDrainPromise = null;
    });
    return this.activeDrainPromise;
  }

  private async drainOutbox(): Promise<void> {
    if (this.isStopped) return;
    const workerId = `worker_${process.pid}`;
    const leased = this.db.claimOutboxLease(workerId, 30000, 50);
    if (leased.length === 0) return;

    for (const item of leased) {
      if (this.isStopped) break;

      // Idempotency check: if already applied, mark outbox delivered and skip
      if (this.db.isAlertEventApplied(item.eventKey, item.userId, item.targetChat)) {
        this.db.markOutboxDelivered(item.id);
        continue;
      }

      const user = this.db.getUser(item.userId);
      const sub = this.db.getTrackedWalletByUserAndAddress(item.userId, item.alert.address);
      const minFilter = Math.max(user?.minNotionalFilter || 0, sub?.minNotionalUsd || 0);
      const isCardMode = user?.mode !== 'feed';

      try {
        if (isCardMode) {
          await this.deliverLiveCardAlert(item.id, item.eventKey, item.targetChat, item.alert, item.userId, minFilter);
        } else {
          await this.deliverFeedAlert(item.id, item.eventKey, item.targetChat, item.alert, item.userId, minFilter);
        }
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        this.db.markOutboxFailed(item.id, errMsg);
        console.error(`Failed to deliver outbox alert #${item.id} to ${item.userId} (${item.targetChat}):`, err);
      }
    }
  }

  // --- Periodic Outbox Worker & Pruner Timers ---
  public startOutboxWorker(intervalSeconds: number = 30): void {
    clearInterval(this.outboxWorkerInterval);
    this.outboxWorkerInterval = setInterval(async () => {
      try {
        await this.triggerOutboxDrain();
      } catch (err) {
        console.error('Outbox worker drain error:', err);
      }
    }, intervalSeconds * 1000);
  }

  public startRetentionPruner(intervalHours: number = 24): void {
    clearInterval(this.retentionInterval);
    this.retentionInterval = setInterval(() => {
      try {
        this.db.pruneDeliveredRecords(7);
      } catch (err) {
        console.error('Retention prune error:', err);
      }
    }, intervalHours * 60 * 60 * 1000);
  }


  // --- Daily NY Open (9:30 AM ET) Market Summary Scheduler ---
  public startDailyMarketSummaryScheduler(): void {
    if (this.marketSummaryInterval) {
      clearInterval(this.marketSummaryInterval);
    }

    let lastBroadcastDay = '';
    this.marketSummaryInterval = setInterval(async () => {
      try {
        const now = new Date();
        const nyDateStr = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
        const nyTimeStr = now.toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
        });

        // Trigger every day at 09:30 AM NY Open
        if (nyTimeStr === '09:30' && lastBroadcastDay !== nyDateStr) {
          lastBroadcastDay = nyDateStr;
          console.log(`[NY-OPEN] 🌅 Triggering Daily NY Open Market Summary at ${nyTimeStr} ET (${nyDateStr})...`);
          await this.broadcastDailyMarketSummary();
        }
      } catch (err) {
        console.error('Error in daily NY open scheduler:', err);
      }
    }, 60000);
  }

  public async broadcastDailyMarketSummary(): Promise<void> {
    try {
      const summary = await this.hlService.getMarketSummary();
      const text = `🌅 <b>DAILY NY OPEN HYPERDASH REPORT (9:30 AM ET)</b>\n\n` + AlertFormatter.formatMarketSummary(summary);
      const keyboard = new InlineKeyboard()
        .text('🔄 Refresh Summary', 'action_summary')
        .text('🏆 Top Whales', 'action_top')
        .row()
        .text('📊 My Positions', 'action_positions')
        .text('📋 Watchlist', 'action_list');

      const allUsers = this.db.getAllUsers();
      for (const u of allUsers) {
        try {
          await this.bot.api.sendMessage(u.telegramId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (err) {
          console.error(`Failed to send daily NY Open report to ${u.telegramId}:`, err);
        }
      }
    } catch (err) {
      console.error('Failed to broadcast daily NY Open report:', err);
    }
  }
  private async deliverLiveCardAlert(
    outboxId: number,
    eventKey: string,
    targetChat: string,
    alert: TradeAlert,
    userId: string,
    minFilter: number = 0
  ): Promise<void> {
    const sub = this.db.getTrackedWalletByUserAndAddress(userId, alert.address);
    const resolvedLabel = sub?.label || alert.walletLabel || 'Trader';
    const currentAlert: TradeAlert = {
      ...alert,
      walletLabel: resolvedLabel,
    };
    const existingCard = this.db.getPositionCard(targetChat, alert.address, alert.coin);

    const deltaUsd = alert.deltaNotionalUsd !== undefined
      ? alert.deltaNotionalUsd
      : (alert.filledSize && alert.fillPx ? alert.filledSize * alert.fillPx : (alert.addedUsd || alert.notionalValue));
    
    const isBelowFilter = minFilter > 0 && deltaUsd < minFilter;

    // Case 1: Position Closed
    if (alert.type === 'position_closed') {
      let shouldSendClose = false;
      if (existingCard) {
        const durationMs = alert.timestamp - existingCard.initialOpenTime;
        currentAlert.heldDuration = AlertFormatter.formatDuration(durationMs);
        const lifetimeRealizedPnl = existingCard.cumRealizedPnl + (alert.closedPnl || 0);
        currentAlert.closedPnl = lifetimeRealizedPnl;
        if (existingCard.initialEntryPx > 0) {
          currentAlert.entryPx = existingCard.initialEntryPx;
        }
        const refSize = existingCard.maxSize > 0 ? existingCard.maxSize : (alert.currentSize || 1);
        if (currentAlert.entryPx > 0 && refSize > 0) {
          currentAlert.pnlPercent = (lifetimeRealizedPnl / (currentAlert.entryPx * refSize)) * 100;
        }
        shouldSendClose = existingCard.messageId > 0 || !isBelowFilter;
      } else {
        shouldSendClose = !isBelowFilter;
      }

      if (shouldSendClose) {
        const text = AlertFormatter.formatAlert(currentAlert);
        const keyboard = AlertFormatter.createAlertKeyboard(currentAlert, false);
        await this.bot.api.sendMessage(targetChat, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      }

      this.db.applyDeliveredAlertMutation({
        outboxId,
        eventKey,
        userId,
        targetChat,
        alert,
        cardMutation: {
          type: 'closed',
          messageId: 0,
        },
      });
      return;
    }

    // Case 2: Position Reduced
    if (alert.type === 'position_reduced') {
      const slicePnl = alert.closedPnl || 0;
      const prevSize = existingCard ? existingCard.currentSize : (alert.currentSize + (alert.filledSize || 0));
      const closedSliceSize = alert.filledSize || Math.max(0, prevSize - alert.currentSize);

      const isSuppressed = isBelowFilter || !existingCard || existingCard.messageId === 0;

      if (isSuppressed) {
        const messageId = existingCard?.messageId || 0;
        this.db.applyDeliveredAlertMutation({
          outboxId,
          eventKey,
          userId,
          targetChat,
          alert,
          cardMutation: {
            type: 'reduced',
            messageId,
            slicePnl,
            closedSliceSize,
            currentSize: alert.currentSize,
            entryPx: alert.entryPx,
          },
        });
        return;
      }

      const totalCumPnl = (existingCard?.cumRealizedPnl || 0) + slicePnl;
      const alertCopy = { ...currentAlert, closedPnl: totalCumPnl };
      const text = AlertFormatter.formatAlert(alertCopy);
      const keyboard = AlertFormatter.createAlertKeyboard(alertCopy, true);

      let resultingMessageId = existingCard.messageId;
      try {
        await this.bot.api.editMessageText(targetChat, existingCard.messageId, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
      } catch (err) {
        console.warn(`Edit-in-place failed on reduce, falling back to sendMessage:`, err);
        const sentMsg = await this.bot.api.sendMessage(targetChat, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        resultingMessageId = sentMsg.message_id;
      }

      this.db.applyDeliveredAlertMutation({
        outboxId,
        eventKey,
        userId,
        targetChat,
        alert,
        cardMutation: {
          type: 'reduced',
          messageId: resultingMessageId,
          slicePnl,
          closedSliceSize,
          currentSize: alert.currentSize,
          entryPx: alert.entryPx,
        },
      });
      return;
    }

    // Case 3: Position Increased
    if (alert.type === 'position_increased') {
      const initialOpenTime = existingCard?.initialOpenTime || alert.timestamp;
      const initialEntry = existingCard?.initialEntryPx || alert.entryPx;

      if (existingCard && existingCard.messageId > 0) {
        if (isBelowFilter) {
          this.db.applyDeliveredAlertMutation({
            outboxId,
            eventKey,
            userId,
            targetChat,
            alert,
            cardMutation: {
              type: 'increased',
              messageId: existingCard.messageId,
              initialOpenTime,
              entryPx: alert.entryPx,
              currentSize: alert.currentSize,
            },
          });
          return;
        }

        const text = AlertFormatter.formatAlert(currentAlert);
        const keyboard = AlertFormatter.createAlertKeyboard(currentAlert, true);

        let resultingMessageId = existingCard.messageId;
        try {
          await this.bot.api.editMessageText(targetChat, existingCard.messageId, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
        } catch (err) {
          console.warn(`Edit-in-place failed on increase, falling back to sendMessage:`, err);
          const sentMsg = await this.bot.api.sendMessage(targetChat, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          resultingMessageId = sentMsg.message_id;
        }

        this.db.applyDeliveredAlertMutation({
          outboxId,
          eventKey,
          userId,
          targetChat,
          alert,
          cardMutation: {
            type: 'increased',
            messageId: resultingMessageId,
            initialOpenTime,
            entryPx: alert.entryPx,
            currentSize: alert.currentSize,
          },
        });
        return;
      } else {
        let messageId = 0;
        if (!isBelowFilter) {
          const text = AlertFormatter.formatAlert(currentAlert);
          const keyboard = AlertFormatter.createAlertKeyboard(currentAlert, true);
          const sentMsg = await this.bot.api.sendMessage(targetChat, text, {
            parse_mode: 'HTML',
            reply_markup: keyboard,
          });
          messageId = sentMsg.message_id;
        }

        this.db.applyDeliveredAlertMutation({
          outboxId,
          eventKey,
          userId,
          targetChat,
          alert,
          cardMutation: {
            type: 'increased',
            messageId,
            initialOpenTime,
            entryPx: initialEntry,
            currentSize: alert.currentSize,
          },
        });
        return;
      }
    }

    // Case 4: Position Opened
    if (alert.type === 'position_opened') {
      let messageId = 0;
      if (!isBelowFilter) {
        const text = AlertFormatter.formatAlert(currentAlert);
        const keyboard = AlertFormatter.createAlertKeyboard(currentAlert, true);
        const sentMsg = await this.bot.api.sendMessage(targetChat, text, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        messageId = sentMsg.message_id;
      }

      this.db.applyDeliveredAlertMutation({
        outboxId,
        eventKey,
        userId,
        targetChat,
        alert,
        cardMutation: {
          type: 'opened',
          messageId,
          entryPx: alert.entryPx,
          currentSize: alert.currentSize,
          initialOpenTime: alert.timestamp,
        },
      });
      return;
    }
  }

  private async deliverFeedAlert(
    outboxId: number,
    eventKey: string,
    targetChat: string,
    alert: TradeAlert,
    userId: string,
    minFilter: number = 0
  ): Promise<void> {
    const sub = this.db.getTrackedWalletByUserAndAddress(userId, alert.address);
    const resolvedLabel = sub?.label || alert.walletLabel || 'Trader';
    const currentAlert: TradeAlert = {
      ...alert,
      walletLabel: resolvedLabel,
    };
    const deltaUsd = alert.deltaNotionalUsd !== undefined
      ? alert.deltaNotionalUsd
      : (alert.filledSize && alert.fillPx ? alert.filledSize * alert.fillPx : (alert.addedUsd || alert.notionalValue));

    if (minFilter > 0 && deltaUsd < minFilter) {
      this.db.applyDeliveredAlertMutation({
        outboxId,
        eventKey,
        userId,
        targetChat,
        alert,
      });
      return;
    }

    const text = AlertFormatter.formatAlert(currentAlert);
    const keyboard = AlertFormatter.createAlertKeyboard(currentAlert, false);
    await this.bot.api.sendMessage(targetChat, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    this.db.applyDeliveredAlertMutation({
      outboxId,
      eventKey,
      userId,
      targetChat,
      alert,
    });
  }
  // --- Demo Alerts Simulator ---
  public async sendDemoAlerts(ctx: Context): Promise<void> {
    const userId = String(ctx.from?.id);
    const targetChat = String(ctx.chat?.id || userId);
    const label = 'Whale-Alpha';
    const address = '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae';
    const coin = 'HYPE';
    const symbol = 'HYPEUSD';

    await ctx.reply('🧪 <b>[TEST] Triggering Live Edit-in-Place Demo...</b>\n\nWatch this message card update dynamically without spam:', {
      parse_mode: 'HTML',
    });

    // 1. Open Long
    const openAlert: TradeAlert = {
      eventKey: `demo:${userId}:${coin}:open:${Date.now() - 3600000}`,
      type: 'position_opened',
      walletLabel: label,
      address,
      chain: 'hyperliquid',
      coin,
      symbol,
      side: 'LONG',
      currentSize: 1000,
      filledSize: 1000,
      deltaNotionalUsd: 80000,
      entryPx: 80.0,
      notionalValue: 80000,
      leverage: 10,
      timestamp: Date.now() - 3600000,
    };
    await this.deliverLiveCardAlert(0, openAlert.eventKey!, targetChat, openAlert, userId, 0);
    await new Promise((r) => setTimeout(r, 2000));

    // 2. Increase Long
    const incAlert: TradeAlert = {
      eventKey: `demo:${userId}:${coin}:inc:${Date.now() - 1800000}`,
      type: 'position_increased',
      walletLabel: label,
      address,
      chain: 'hyperliquid',
      coin,
      symbol,
      side: 'LONG',
      currentSize: 2500,
      filledSize: 1500,
      deltaNotionalUsd: 123000,
      entryPx: 81.2,
      fillPx: 82.0,
      addedUsd: 123000,
      notionalValue: 205000,
      leverage: 10,
      burstCount: 3,
      timestamp: Date.now() - 1800000,
    };
    await this.deliverLiveCardAlert(0, incAlert.eventKey!, targetChat, incAlert, userId, 0);
    await new Promise((r) => setTimeout(r, 2000));

    // 3. Partial Close (Take Profit)
    const redAlert: TradeAlert = {
      eventKey: `demo:${userId}:${coin}:red:${Date.now() - 600000}`,
      type: 'position_reduced',
      walletLabel: label,
      address,
      chain: 'hyperliquid',
      coin,
      symbol,
      side: 'LONG',
      currentSize: 1000,
      filledSize: 1500,
      deltaNotionalUsd: 132000,
      entryPx: 81.2,
      closingPx: 88.0,
      notionalValue: 88000,
      closedPnl: 10200,
      leverage: 10,
      timestamp: Date.now() - 600000,
    };
    await this.deliverLiveCardAlert(0, redAlert.eventKey!, targetChat, redAlert, userId, 0);
    await new Promise((r) => setTimeout(r, 2000));

    // 4. Final Close
    const closeAlert: TradeAlert = {
      eventKey: `demo:${userId}:${coin}:close:${Date.now()}`,
      type: 'position_closed',
      walletLabel: label,
      address,
      chain: 'hyperliquid',
      coin,
      symbol,
      side: 'LONG',
      currentSize: 0,
      filledSize: 1000,
      deltaNotionalUsd: 90000,
      entryPx: 81.2,
      closingPx: 90.0,
      notionalValue: 0,
      closedPnl: 8800,
      leverage: 10,
      timestamp: Date.now(),
    };
    await this.deliverLiveCardAlert(0, closeAlert.eventKey!, targetChat, closeAlert, userId, 0);
  }
}

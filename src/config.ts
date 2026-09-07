import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  telegramBotToken: string;
  adminChatId?: string;
  allowedChatIds: string[];
  defaultMinNotional: number;
  dbPath: string;
  reconcileIntervalSeconds: number;
  hyperliquidNetwork: 'mainnet' | 'testnet';
  hyperliquidWsUrl: string;
  hyperliquidHttpUrl: string;
}

export function validateConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
  if (token) {
    const tokenRegex = /^\d+:[A-Za-z0-9_-]{30,}$/;
    if (!tokenRegex.test(token)) {
      throw new Error(`Configuration Error: TELEGRAM_BOT_TOKEN format is invalid. Expected format: '<bot_id>:<token_string>'`);
    }
  }

  let defaultMinNotional = 0;
  if (env.DEFAULT_MIN_NOTIONAL !== undefined && env.DEFAULT_MIN_NOTIONAL.trim() !== '') {
    const val = parseFloat(env.DEFAULT_MIN_NOTIONAL.trim());
    if (isNaN(val) || val < 0) {
      throw new Error(`Configuration Error: DEFAULT_MIN_NOTIONAL must be a non-negative number, got '${env.DEFAULT_MIN_NOTIONAL}'`);
    }
    defaultMinNotional = val;
  }

  let reconcileIntervalSeconds = 60;
  if (env.TRACKER_RECONCILE_INTERVAL_S !== undefined && env.TRACKER_RECONCILE_INTERVAL_S.trim() !== '') {
    const val = parseInt(env.TRACKER_RECONCILE_INTERVAL_S.trim(), 10);
    if (isNaN(val) || val < 5) {
      throw new Error(`Configuration Error: TRACKER_RECONCILE_INTERVAL_S must be an integer >= 5, got '${env.TRACKER_RECONCILE_INTERVAL_S}'`);
    }
    reconcileIntervalSeconds = val;
  }

  const allowedChatIds = env.TRACKER_ALLOWED_CHAT_IDS
    ? env.TRACKER_ALLOWED_CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  let hyperliquidNetwork: 'mainnet' | 'testnet' = 'mainnet';
  if (env.HYPERLIQUID_NETWORK !== undefined && env.HYPERLIQUID_NETWORK.trim() !== '') {
    const net = env.HYPERLIQUID_NETWORK.trim().toLowerCase();
    if (net !== 'mainnet' && net !== 'testnet') {
      throw new Error(`Configuration Error: HYPERLIQUID_NETWORK must be 'mainnet' or 'testnet', got '${env.HYPERLIQUID_NETWORK}'`);
    }
    hyperliquidNetwork = net;
  }
  
  // Network-isolated default SQLite storage to avoid mixing mainnet and testnet state
  const defaultDbPath = hyperliquidNetwork === 'testnet' ? './data/tracker-testnet.sqlite' : './data/tracker.sqlite';
  const dbPath = env.TRACKER_DB_PATH?.trim() || defaultDbPath;
  const hyperliquidWsUrl = env.HYPERLIQUID_WS_URL?.trim() ||
    (hyperliquidNetwork === 'testnet' ? 'wss://api.hyperliquid-testnet.xyz/ws' : 'wss://api.hyperliquid.xyz/ws');
  const hyperliquidHttpUrl = env.HYPERLIQUID_HTTP_URL?.trim() ||
    (hyperliquidNetwork === 'testnet' ? 'https://api.hyperliquid-testnet.xyz/info' : 'https://api.hyperliquid.xyz/info');
  return {
    telegramBotToken: token,
    adminChatId: env.ADMIN_CHAT_ID?.trim() || undefined,
    allowedChatIds,
    defaultMinNotional,
    dbPath,
    reconcileIntervalSeconds,
    hyperliquidNetwork,
    hyperliquidWsUrl,
    hyperliquidHttpUrl,
  };
}

export const config: AppConfig = validateConfig();

export type SupportedChain = 'hyperliquid' | 'evm' | 'solana';

export type AlertType = 
  | 'position_opened'
  | 'position_increased'
  | 'position_reduced'
  | 'position_closed'
  | 'position_liquidated'
  | 'dex_buy'
  | 'dex_sell';

export interface User {
  id?: number;
  telegramId: string;
  username?: string;
  firstName?: string;
  minNotionalFilter: number;
  showButtons: boolean;
  mode?: string; // 'card' (edit in place) | 'feed' (new message)
  createdAt: number;
}

export interface TrackedWallet {
  id?: number;
  userId: string; // telegramId
  address: string;
  label: string;
  chain: SupportedChain;
  isActive: boolean;
  minNotionalUsd: number;
  alertChatId?: string;
  createdAt: number;
}

export interface Position {
  coin: string;
  size: number;
  entryPx: number;
  side: 'LONG' | 'SHORT';
  notionalValue: number;
  unrealizedPnl: number;
  returnOnEquity?: number;
  liquidationPx?: number | null;
  leverage?: number;
  marginUsed?: number;
}

export interface TradeAlert {
  eventKey?: string; // Deterministic idempotency key: `${address}:${coin}:${timeRange}:${type}:${leg}`
  type: AlertType;
  walletLabel?: string;
  address: string;
  chain: SupportedChain;
  coin: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  currentSize: number;
  filledSize?: number;
  deltaNotionalUsd?: number; // Actual dollar volume of this fill/burst
  entryPx: number;
  closingPx?: number;
  notionalValue: number; // Total position notional
  addedUsd?: number;
  fillPx?: number;
  closedPnl?: number;
  pnlPercent?: number;
  leverage?: number;
  heldDuration?: string;
  burstCount?: number;
  txHash?: string;
  timestamp: number;
}

export interface UserAccountSummary {
  accountValue: number;
  totalNtlPos: number;
  totalRawUsd: number;
  totalMarginUsed: number;
  positions: Position[];
}

export interface LeaderboardTrader {
  address: string;
  name: string;
  pnl: number;
  accountValue: number;
  positionsCount: number;
  topPositions?: string[];
}

export interface FillCursor {
  address: string;
  lastFillTime: number;
  lastFillTid: number;
  updatedAt: number;
}

export interface MarketSummary {
  dateStr: string;
  totalVolume24h: number;
  totalOi: number;
  topGainers: Array<{ coin: string; changePct: number; px: number }>;
  topLosers: Array<{ coin: string; changePct: number; px: number }>;
  activeWhales: Array<{
    name: string;
    accountValue: number;
    positionsCount: number;
    topPosition?: string;
  }>;
  largestRecentTrades: Array<{
    coin: string;
    side: 'BUY' | 'SELL';
    sz: number;
    px: number;
    usdValue: number;
  }>;
}

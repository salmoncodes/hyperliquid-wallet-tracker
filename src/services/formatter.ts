import { InlineKeyboard } from 'grammy';
import type { TradeAlert, Position, UserAccountSummary, LeaderboardTrader, MarketSummary } from '../types/index.js';

export function escapeTelegramHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export class AlertFormatter {
  public static formatNumber(num: number, minDec: number = 0, maxDec: number = 4): string {
    if (isNaN(num)) return '0';
    if (Math.abs(num) >= 1000) {
      return num.toLocaleString('en-US', {
        minimumFractionDigits: minDec,
        maximumFractionDigits: 2,
      });
    }
    if (Math.abs(num) >= 1) {
      return num.toLocaleString('en-US', {
        minimumFractionDigits: minDec,
        maximumFractionDigits: Math.min(maxDec, 4),
      });
    }
    return num.toLocaleString('en-US', {
      minimumFractionDigits: minDec,
      maximumFractionDigits: Math.max(maxDec, 8),
    });
  }

  public static formatUsd(amount: number): string {
    if (isNaN(amount)) return '$0';
    const isNegative = amount < 0;
    const absVal = Math.abs(amount);
    const formatted = this.formatNumber(absVal, 2, 2);
    return isNegative ? `-$${formatted}` : `$${formatted}`;
  }

  public static formatCompactUsd(amount: number): string {
    if (isNaN(amount)) return '$0';
    const isNegative = amount < 0;
    const absVal = Math.abs(amount);

    let formatted = '';
    if (absVal >= 1e9) {
      formatted = `$${(absVal / 1e9).toFixed(2)}B`;
    } else if (absVal >= 1e6) {
      formatted = `$${(absVal / 1e6).toFixed(2)}M`;
    } else if (absVal >= 1e3) {
      formatted = `$${(absVal / 1e3).toFixed(2)}K`;
    } else {
      formatted = `$${absVal.toFixed(2)}`;
    }

    return isNegative ? `-${formatted}` : formatted;
  }

  public static formatDuration(ms: number): string {
    if (ms <= 0) return '< 1m';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      const remHours = hours % 24;
      return `${days}d ${remHours}h`;
    }
    if (hours > 0) {
      const remMins = minutes % 60;
      return `${hours}h ${remMins}m`;
    }
    if (minutes > 0) {
      return `${minutes}m`;
    }
    return `${seconds}s`;
  }

  public static formatAlert(alert: TradeAlert): string {
    const {
      type,
      walletLabel,
      symbol,
      side,
      currentSize,
      entryPx,
      closingPx,
      notionalValue,
      addedUsd,
      fillPx,
      closedPnl,
      pnlPercent,
      leverage,
      heldDuration,
      burstCount,
    } = alert;

    const safeLabel = escapeTelegramHtml(walletLabel || 'Trader');
    const safeSymbol = escapeTelegramHtml(symbol);
    const levStr = leverage && leverage > 1 ? ` · <b>${leverage}x</b>` : '';
    const burstStr = burstCount && burstCount > 1 ? ` <i>(⚡ ${burstCount} fills aggregated)</i>` : '';

    switch (type) {
      case 'position_opened': {
        const sideIcon = side === 'LONG' ? '🟢' : '🔴';
        return [
          `<b>${safeLabel}</b> Opened a <b>${side}</b> Position: ${sideIcon}${levStr}${burstStr}`,
          `⚡ <b>Symbol:</b> <code>${safeSymbol}</code>`,
          `🔹 <b>Current Size:</b> <code>${this.formatNumber(currentSize)}</code>`,
          `🔹 <b>Entry Price:</b> <code>$${this.formatNumber(entryPx, 2, 6)}</code>`,
          `💎 <b>Notional Value:</b> <code>${this.formatUsd(notionalValue)}</code>`,
        ].join('\n');
      }

      case 'position_increased': {
        const sideIcon = side === 'LONG' ? '🟢' : '🔴';
        const addedStr = addedUsd ? `\n💰 <b>Added:</b> <code>${this.formatUsd(addedUsd)}</code>` : '';
        const fillPxStr = fillPx ? `\n🎯 <b>At Price:</b> <code>$${this.formatNumber(fillPx, 2, 6)}</code>` : '';
        return [
          `<b>${safeLabel}</b> Increased a <b>${side}</b> Position: ${sideIcon}${levStr}${burstStr}`,
          `⚡ <b>Symbol:</b> <code>${safeSymbol}</code>`,
          `🔹 <b>Current Size:</b> <code>${this.formatNumber(currentSize)}</code>`,
          `🔹 <b>Blended Entry:</b> <code>$${this.formatNumber(entryPx, 2, 6)}</code>`,
          `💎 <b>Notional Value:</b> <code>${this.formatUsd(notionalValue)}</code>${addedStr}${fillPxStr}`,
        ].join('\n');
      }

      case 'position_reduced': {
        const pnlSign = (closedPnl || 0) >= 0 ? '+' : '';
        const pnlStr = closedPnl !== undefined ? `\n💰 <b>Realized Slice PnL:</b> <code>${pnlSign}${this.formatUsd(closedPnl)}</code>` : '';
        return [
          `<b>${safeLabel}</b> Reduced a <b>${side}</b> Position: 📉${levStr}${burstStr}`,
          `⚡ <b>Symbol:</b> <code>${safeSymbol}</code>`,
          `🔹 <b>Remaining Size:</b> <code>${this.formatNumber(currentSize)}</code>`,
          `🔹 <b>Exit Price:</b> <code>$${this.formatNumber(closingPx || entryPx, 2, 6)}</code>`,
          `💎 <b>Remaining Value:</b> <code>${this.formatUsd(notionalValue)}</code>${pnlStr}`,
        ].join('\n');
      }

      case 'position_closed': {
        const pnl = closedPnl || 0;
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlColor = pnl >= 0 ? '🟢' : '🔴';
        const durationStr = heldDuration ? `\n⏳ <b>Held:</b> <code>${heldDuration}</code>` : '';
        const pnlPctStr = pnlPercent !== undefined ? ` (${pnlSign}${pnlPercent.toFixed(2)}%)` : '';

        return [
          `<b>${safeLabel}</b> Closed a <b>${side}</b> Position: 🎯${levStr}${burstStr}`,
          `⚡ <b>Symbol:</b> <code>${safeSymbol}</code>`,
          `🔹 <b>Entry Price:</b> <code>$${this.formatNumber(entryPx, 2, 6)}</code>`,
          `🔹 <b>Closing Price:</b> <code>$${this.formatNumber(closingPx || 0, 2, 6)}</code>`,
          `💰 <b>Profit:</b> <code>${this.formatUsd(pnl)}${pnlPctStr}</code> ${pnlColor}${durationStr}`,
        ].join('\n');
      }

      default:
        return `Trade event from <b>${safeLabel}</b> in <code>${safeSymbol}</code>`;
    }
  }

  public static formatMarketSummary(summary: MarketSummary): string {
    const lines: string[] = [];

    // Header
    lines.push(`🌅 <b>Hyperdash Market Summary</b> - ${summary.dateStr}`);
    lines.push(``);

    // 24h Aggregates
    lines.push(`📊 <b>HL 24h Aggregates</b>`);
    lines.push(`• <b>Volume:</b> <code>${this.formatCompactUsd(summary.totalVolume24h)}</code>`);
    lines.push(`• <b>Open Interest:</b> <code>${this.formatCompactUsd(summary.totalOi)}</code>`);
    lines.push(``);

    // Top Movers
    if (summary.topGainers.length > 0 || summary.topLosers.length > 0) {
      lines.push(`📈 <b>Top Movers (24h)</b>`);
      for (const g of summary.topGainers) {
        lines.push(`🟢 <code>${g.coin.padEnd(8)} +${g.changePct.toFixed(1)}% ($${this.formatNumber(g.px, 2, 4)})</code>`);
      }
      lines.push(``);
      for (const l of summary.topLosers) {
        lines.push(`🔴 <code>${l.coin.padEnd(8)} ${l.changePct.toFixed(1)}% ($${this.formatNumber(l.px, 2, 4)})</code>`);
      }
      lines.push(``);
    }

    // Active Smart Money Whales
    if (summary.activeWhales.length > 0) {
      lines.push(`🏆 <b>Tracked Smart Money Whales</b>`);
      summary.activeWhales.forEach((w, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
        const safeName = escapeTelegramHtml(w.name);
        const topStr = w.topPosition ? ` | <i>${escapeTelegramHtml(w.topPosition)}</i>` : '';
        lines.push(`${medal} <b>${safeName}</b>: <code>${this.formatUsd(w.accountValue)}</code> (${w.positionsCount} pos)${topStr}`);
      });
      lines.push(``);
    }

    // Largest Recent Market Trades
    if (summary.largestRecentTrades.length > 0) {
      lines.push(`💥 <b>Largest Recent Market Trades</b>`);
      summary.largestRecentTrades.forEach((t, i) => {
        const sideIcon = t.side === 'BUY' ? '🟢' : '🔴';
        lines.push(`${i + 1}. ${sideIcon} <b>${t.side} ${t.coin}</b>: <code>${this.formatCompactUsd(t.usdValue)}</code> (@ $${this.formatNumber(t.px, 2, 4)})`);
      });
    }

    return lines.join('\n');
  }

  public static createAlertKeyboard(alert: TradeAlert, isActivePosition: boolean = false): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    if (isActivePosition) {
      keyboard.text('🔄 Refresh Live PnL', `refresh_${alert.address}_${alert.coin}`).row();
    }

    if (alert.chain === 'hyperliquid') {
      keyboard
        .url('🎯 Show Position', `https://hyperdash.com/?chart1=${encodeURIComponent(alert.coin)}&snoop=${alert.address}`)
        .url('👤 Show Profile', `https://hyperdash.com/address/${alert.address}`)
        .url('📈 Chart', `https://app.hyperliquid.xyz/trade/${alert.coin}`);
    } else if (alert.chain === 'evm') {
      keyboard.url('📊 DexScreener', `https://dexscreener.com/search?q=${alert.address}`);
      keyboard.url('🔍 Etherscan', `https://etherscan.io/address/${alert.address}`);
    } else {
      keyboard.url('📊 DexScreener', `https://dexscreener.com/search?q=${alert.address}`);
      keyboard.url('🔍 Solscan', `https://solscan.io/account/${alert.address}`);
    }

    return keyboard;
  }

  public static formatPositionsSummary(walletLabel: string, address: string, summary: UserAccountSummary): string {
    const lines: string[] = [];
    const safeLabel = escapeTelegramHtml(walletLabel);
    lines.push(`📊 <b>${safeLabel}</b> Live Portfolio Summary`);
    lines.push(`<code>${address}</code>\n`);

    lines.push(`💰 <b>Account Value:</b> <code>${this.formatUsd(summary.accountValue)}</code>`);
    lines.push(`💎 <b>Total Notional:</b> <code>${this.formatUsd(summary.totalNtlPos)}</code>`);
    lines.push(`🛡 <b>Margin Used:</b> <code>${this.formatUsd(summary.totalMarginUsed)}</code>\n`);

    const timeStr = new Date().toLocaleTimeString('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    if (summary.positions.length === 0) {
      lines.push('<i>No active open positions.</i>\n');
      lines.push(`⏱ <i>Updated: ${timeStr} UTC</i>`);
      return lines.join('\n');
    }

    lines.push(`<b>Active Positions (${summary.positions.length}):</b>`);
    summary.positions.forEach((pos) => {
      const pnlSign = pos.unrealizedPnl >= 0 ? '+' : '';
      const pnlStr = `${pnlSign}${this.formatUsd(pos.unrealizedPnl)}`;
      const roeStr = pos.returnOnEquity !== undefined ? ` (${(pos.returnOnEquity * 100).toFixed(2)}%)` : '';
      const sideIcon = pos.side === 'LONG' ? '🟢' : '🔴';
      const levStr = pos.leverage ? ` · <b>${pos.leverage}x</b>` : '';

      lines.push(
        `${sideIcon} <b>${pos.side} ${pos.coin}</b>${levStr}\n` +
        `  • Size: <code>${this.formatNumber(pos.size)}</code> | Value: <code>${this.formatUsd(pos.notionalValue)}</code>\n` +
        `  • Entry: <code>$${this.formatNumber(pos.entryPx, 2, 6)}</code>\n` +
        `  • uPnL: <code>${pnlStr}${roeStr}</code>`
      );

      if (pos.liquidationPx) {
        lines.push(`  • Est. Liq: <code>$${this.formatNumber(pos.liquidationPx, 2, 6)}</code>`);
      }
      lines.push('');
    });
    lines.push(`⏱ <i>Updated: ${timeStr} UTC</i>`);

    return lines.join('\n');
  }

  public static formatLeaderboard(traders: LeaderboardTrader[]): string {
    const lines: string[] = [];
    lines.push(`🏆 <b>Top Hyperliquid Smart Money Whales</b>\n`);

    traders.forEach((t, i) => {
      const rank = i + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
      const safeName = escapeTelegramHtml(t.name);
      lines.push(
        `${medal} <b>${safeName}</b> (<code>${t.address.slice(0, 6)}...${t.address.slice(-4)}</code>)\n` +
        `  • Value: <code>${this.formatUsd(t.accountValue)}</code> | Open Pos: <code>${t.positionsCount}</code>`
      );
      if (t.topPositions && t.topPositions.length > 0) {
        lines.push(`  • Top: <i>${t.topPositions.map(p => escapeTelegramHtml(p)).join(', ')}</i>`);
      }
      lines.push(``);
    });

    return lines.join('\n');
  }
}

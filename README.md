# ⚡ Hyperliquid Wallet & Smart Money Tracker (Telegram Bot)

A high-performance, real-time **Telegram Wallet & Smart Money Tracker** for [Hyperliquid Perpetuals](https://hyperliquid.xyz). 

Inspired by institutional alert channels like **Mirrorly**, this bot allows you to add any Hyperliquid address via Telegram and delivers instant, zero-latency alerts whenever that wallet opens, sizes up, scales out, or closes positions — complete with notional values, entry prices, profits, ROI %, leverage, and interactive action buttons.

---

## 🚀 Key Features

- **⚡ Zero-Latency Real-Time Alerts**: Connects directly to Hyperliquid's raw WebSocket feed (`wss://api.hyperliquid.xyz/ws`) for instantaneous trade execution alerts.
- **🌱 The Cold-Start Guarantee**: Automatically seeds existing open positions silently on startup or when adding a new address, guaranteeing that an add to an existing trade is correctly identified as **"Increased a Position"** (with exact added $, new average entry price, and total size) rather than falsely reporting "Opened a Position".
- **🔄 Complete Position Lifecycle**:
  - 🟢 **Opened a LONG / SHORT Position**: Direction, Symbol, Size, Entry Price, Notional Value.
  - 🔼 **Increased a Position**: Symbol, Added Amount ($), Execution Price, New Blended Entry Price, New Total Size, Total Notional Value.
  - ✂️ **Reduced a Position**: Symbol, Closed Size, Exit Price, Remaining Size, Realized Profit/Loss ($ and %).
  - 💰 **Closed a Position**: Symbol, Entry Price, Closing Price, Realized Profit/Loss ($ and %), Win/Loss indicator.
- **📱 Interactive Telegram UI**:
  - `➕ Add Address`: Paste an address or send `/add 0x... Nickname`.
  - `📋 Tracked Wallets`: List all tracked addresses, toggle alerts (pause/resume), or delete with 1 tap.
  - `📊 Live Positions Viewer`: Tabular breakdown of all open perp positions, leverage, and unrealized PnL for any trader.
  - `🏆 Top Whales Leaderboard`: Scans the Hyperliquid market in real-time for high-volume active whales with 1-click "Track This Trader" buttons.
  - `⚙️ Trade Size Filter`: Set minimum USD trade filters (`/filter 10000`) to filter out noise and focus on high-conviction moves.
  - `🧪 Live Alert Simulator`: Run `/demo` to test and preview formatted alert feeds anytime.
- **🔒 Privacy & Admin Security**: Option to restrict the bot to your private user ID or allowed list of chats.
- **💾 Local SQLite Database**: Fast, zero-dependency persistence for your watchlists, preferences, and alert history.

---

## 📸 Alert Format Preview

### 1. Position Opened
```text
Sky Opened a LONG Position: 🟢

⚡ Symbol: UNIUSD
🔹 Current Size: 2,519.7
🔹 Entry Price: $3.97
🔹 Notional Value: $10,002.00

[ 📈 UNI Chart ]  [ 👛 Profile ]
[ 📊 View Open Positions ]
```

### 2. Position Increased (Size Added)
```text
MachiBigBrother Increased a LONG Position: 🟢

⚡ Symbol: HYPEUSD
🔹 Current Size: 247,500
🔹 Entry Price: $73.18
🔹 Notional Value: $18,111,712.00
🔹 Added: $5,089,376.00
🔹 At Price: $73.76

[ 📈 HYPE Chart ]  [ 👛 Profile ]
[ 📊 View Open Positions ]
```

### 3. Position Closed with Profit
```text
HummusXBT Closed a LONG Position: 🎯

⚡ Symbol: ENAUSDT
🔹 Entry Price: $0.0843
🔹 Closing Price: $0.1489
💰 Profit: +$31,207.94 (+76.56%)

[ 📈 ENA Chart ]  [ 👛 Profile ]
[ 📊 View Open Positions ]
```

---

## 🛠️ Quickstart & Setup

### Prerequisites
- [Bun](https://bun.sh) (recommended) or [Node.js](https://nodejs.org) (v18+)
- A Telegram Bot Token from [@BotFather](https://t.me/BotFather)

### Step 1: Clone or Navigate to the Project
```bash
cd ~/telegram-crypto-tracker
```

### Step 2: Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Edit `.env` and fill in your Telegram Bot token:
```dotenv
TELEGRAM_BOT_TOKEN=1234567890:AAF_your_bot_token_from_botfather

# (Optional) Lock the bot so only your Telegram account can use it
ADMIN_CHAT_ID=your_telegram_user_id

# (Optional) Filter out trades smaller than this amount in USD (0 = all trades)
DEFAULT_MIN_NOTIONAL=0
```

### Step 3: Run the Bot
Using **Bun**:
```bash
bun run start
```
Or using **Node.js**:
```bash
npm run start:node
```

The bot will connect to Hyperliquid, pre-seed all positions, and start polling Telegram!

---

## 🤖 Telegram Commands Reference

| Command | Description | Example |
|---|---|---|
| `/start` | Open interactive control menu & stats | `/start` |
| `/add <address> [label]` | Add a Hyperliquid address to track | `/add 0x020c8678d257a390ac05a0001ece34f29988316b MachiBigBrother` |
| `/remove <address or ID>` | Remove a wallet from watchlist | `/remove 0x020c86...` |
| `/list` | Show all tracked wallets with 1-click actions | `/list` |
| `/positions [address]` | Inspect open positions & uPnL for any trader | `/positions MachiBigBrother` |
| `/refresh [address]` | Refresh open positions in-place (or reply `/refresh`) | `/refresh` |
| `/summary` | Hyperdash 24h market summary & stats | `/summary` |
| `/top` | Discover top active Hyperliquid whales | `/top` |
| `/filter <amount_usd>` | Set minimum trade size filter | `/filter 10000` |
| `/mode <card\|feed>` | Toggle Live Card (edit-in-place) or Feed mode | `/mode card` |
| `/demo` | Send live simulated test alerts | `/demo` |
| `/help` | View help documentation | `/help` |

---

## 🧪 Testing

Run the automated test suite:
```bash
bun test
```
All unit tests and live Hyperliquid mainnet API queries will run and verify.

---

## 🏗️ Architecture

```
                                  Hyperliquid Ecosystem
                        ┌────────────────────────────────────────┐
                        │   wss://api.hyperliquid.xyz/ws         │ (Zero-latency trade stream)
                        │   https://api.hyperliquid.xyz/info     │ (clearinghouseState & positions)
                        └──────────────────┬─────────────────────┘
                                           │
                                           ▼
                            ┌────────────────────────────┐
                            │    HyperliquidService      │
                            │ ────────────────────────── │
                            │ • Cold-Start Silent Seed   │
                            │ • WebSocket State Machine  │
                            │ • In-Memory Book & Diffs   │
                            │ • 60s Reconcile Loop       │
                            └──────────────┬─────────────┘
                                           │ (TradeAlert events)
                                           ▼
┌──────────────────────────┐  Alert Router & Filter       ┌──────────────────────────┐
│     DatabaseManager      │ ───────────────────────────► │      AlertFormatter      │
│ ──────────────────────── │ (Checks minNotional filter,  │ ──────────────────────── │
│ • SQLite persistence     │  resolves user custom label) │ • Mirrorly typography    │
│ • Watchlists & settings  │                              │ • PnL & ROI calculations │
│ • Alert audit logs       │                              │ • Interactive buttons    │
└──────────────────────────┘                              └────────────┬─────────────┘
                                                                       │
                                                                       ▼
                                                          ┌──────────────────────────┐
                                                          │   Telegram Bot (grammY)  │
                                                          │ ──────────────────────── │
                                                          │ • DM & Channel Alerts    │
                                                          │ • Interactive Keyboards  │
                                                          │ • 1-Click Wallet Tracking│
                                                          └──────────────────────────┘
```

---

## 🛡️ Production Deployment (PM2 / Systemd / Docker)

To run the bot 24/7 in the background:

### Using PM2:
```bash
npm install -g pm2
pm2 start "bun run start" --name "hl-wallet-tracker"
pm2 save
pm2 startup
```

### Logs & Monitoring:
```bash
pm2 logs hl-wallet-tracker
```

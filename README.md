# Sentinel Vector - StockWatcher

A Windows desktop watchlist that shows, for each stock, the day's opening price, current price, change %, volume, and technical/analyst ratings from several sources side by side: TradingView, Investing.com, Finnhub, Twelve Data, Alpha Vantage and TAAPI.IO. Prices refresh every 10 minutes (configurable); each rating source refreshes on its own schedule. Every rating change is logged under the table, and you choose which columns also play a sound.

It also has a **floating overlay**: a frameless, transparent, click-through strip showing just the symbols, price, change % and rating on top of whatever app you are using.

## Run it

```bash
npm install
npm start
```

## Build the executable

```bash
npm run build
```

Output: `dist/SentinelVector-StockWatcher-Setup-<version>.exe` — a Windows installer. Run it to install to Programs, with Start Menu and Desktop shortcuts and an entry in Settings → Apps (uninstall from there). Your watchlist is kept on uninstall.

Need the old no-install single exe? `npm run build:portable` → `dist/SentinelVector-StockWatcher.exe`.

## Moving to another PC

Settings → **Backup & move to another PC** → **Export…** saves symbols, per-stock bells and settings to a .json file. On the other PC use **Import…** and choose *Add* or *Replace*. API keys are not exported (DPAPI-encrypted to this Windows account).

## Floating overlay

Open **Settings** (gear icon) and turn on **Show overlay over other apps**.

| Behaviour | Detail |
|---|---|
| Appearance | Ticker, current price, change % and rating pill (columns can be toggled) |
| Background | **None** (fully transparent, the default), **Dim** (adjustable dark veil) or **Solid** |
| Interaction | **Click-through** — every click goes to the app behind it; the overlay is read-only |
| Placement | Corner preset (top-left/right, bottom-left/right), width and margin sliders |
| Height | Auto-fits to the number of symbols |
| Always on top | Yes, at the `screen-saver` level; it also skips the taskbar |
| Toggle | `Ctrl+Alt+O`, the Settings toggle, or the tray menu |
| Bring back main window | `Ctrl+Alt+M` or click the tray icon |

The main window stays normally framed and solid — that is the reliable Windows path for a transparent window. Link menus (Yahoo Finance / Investing.com / TradingView) are opened from the main window, since the overlay never accepts clicks.

Closing the main window quits the app, overlay included.

## Columns and sources

| Column | Source | Default refresh | Needs key |
|---|---|---|---|
| Day open, Current, Change %, Volume | Yahoo Finance chart API | price interval (10 min) | no |
| TradingView | TradingView scanner `Recommend.All`, daily | price interval | no |
| Analyst | TradingView analyst consensus | price interval | no |
| Investing.com 30m | Investing.com technical summary, 30-minute timeframe | 30 min | no |
| Finnhub | `/scan/technical-indicator` aggregate signal (falls back to analyst trend if the plan lacks it) | 10 min | yes |
| Twelve Data | 250 candles from `/time_series`, rated in-app | 30 min, cap 800/day | yes |
| Alpha Vantage | 100 candles from `TIME_SERIES_INTRADAY`, rated in-app | 2 h, cap 25/day | yes |
| TAAPI.IO | `/bulk` indicator values (RSI, MACD, Stoch, CCI, DMI, W%R, MOM, EMA/SMA) | 30 min | yes (US stocks need a Pro plan) |

Twelve Data, Alpha Vantage and TAAPI sell indicators and prices, not a verdict, so the app turns them into the same Strong Buy … Strong Sell scale with TradingView's voting rules (each MA and oscillator votes buy/neutral/sell; the two group averages are averaged; ≥0.5 Strong Buy, ≥0.1 Buy, >−0.1 Neutral, >−0.5 Sell). Hover any rating for its breakdown and last update time.

Outside market hours every source slows to at most once every 4 hours. Rate-limit or auth errors pause that one source (15/60 min) and keep the last good rating, shown with a dashed border.

**API keys** go in **Settings → Data sources** (paste, **Save key**, **Test**; **Get key ↗** opens the provider's sign-up page). Keyed sources stay off until a key is saved and their box is ticked; removing a key turns the source off. They are encrypted with Windows DPAPI via Electron `safeStorage`, stored in `watchlist.json`, and never sent back to the window. Each source also has on/off, refresh interval, candle timeframe and, where relevant, a daily call cap.

**Show / hide columns**: the ▦ toolbar button, right-click any column header, or **Settings → Main table**. The same list has a 🔔 toggle per rating column that decides whether a change in that column plays a sound.

| Score | Rating |
|---|---|
| ≥ 0.5 | Strong Buy |
| 0.1 … 0.5 | Buy |
| −0.1 … 0.1 | Neutral |
| −0.5 … −0.1 | Sell |
| ≤ −0.5 | Strong Sell |

## Alerts

Every change in any rating column (old → new) is added to **Rating changes · today** under the table with time, symbol, source, change and the price at that moment. The feed's own **Columns** button hides any of those; **Clear** empties it. It resets at midnight.

A sound plays only for columns with 🔔 on, only while the US market is open, and only if **Play a sound when a rating changes** is enabled. The tone follows the new rating:

| Rating | Default |
|---|---|
| Strong Buy | Arpeggio |
| Buy | Chime |
| Neutral / Hold | Tick |
| Sell | Pulse |
| Strong Sell | Buzz |

Clicking anywhere on a table row opens the link menu (Yahoo Finance, Investing.com, TradingView).

## Notes

- Watchlist is stored at `%APPDATA%\Sentinel Vector - StockWatcher\watchlist.json`. On first launch, data is migrated automatically from the legacy `%APPDATA%\StockWatch\watchlist.json` if present.
- Quotes can be delayed; ratings are computed on the daily timeframe and change slowly by design.
- Yahoo and TradingView endpoints are unofficial and may change or throttle. The app retries, keeps the last known values, and marks a row `offline` rather than blanking it.
- Investing.com sits behind Cloudflare; the trusted `curl.exe` that ships with Windows 10/11 is used to resolve its US quote URL. If that fails, the link falls back to Investing.com's search page.
- The executable is unsigned, so Windows SmartScreen may ask for confirmation the first time it runs.

## Project layout

```
src/main/          Electron main process (all network access, scheduler, storage)
  window.js        main + overlay windows, tray, hotkeys, auto-fit
  providers.js     background rating sources: schedule, rate limits, daily caps
  sources/         yahoo, tradingview, investing(+Tech), apis (Finnhub,
                   Twelve Data, Alpha Vantage, TAAPI), indicators (in-app gauge)
  quotes.js        merges quotes + ratings into table rows
  links.js         builds and validates the three outbound links
  store.js         atomic JSON persistence (watchlist + display settings)
src/preload/       contextBridge API exposed to both renderers
src/renderer/      UI (compact table, add modal, link menu, settings panel)
  overlay.html/js  read-only click-through heads-up display
tools/             dev helpers: data smoke test, UI screenshots, icon generator
```

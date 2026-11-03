# Sentinel Vector - StockWatcher

A Windows desktop watchlist that shows, for each stock, the day's opening price, current price, change %, volume, and a technical-analysis rating (Strong Buy / Buy / Neutral / Sell / Strong Sell). It refreshes every 10 minutes (configurable) and plays a distinct sound when a symbol moves into **Strong Buy** or **Strong Sell**.

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

Output: `dist/StockWatch.exe` — a single portable executable. No installer, no browser install required; double-click and it runs.

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

## How it works

| Piece | Source |
|---|---|
| Day open, current price, change %, volume | Yahoo Finance chart API |
| Symbol search ("US version" selection) | Yahoo Finance search API |
| Technical rating | TradingView scanner API (`Recommend.All`, daily timeframe) |
| Investing.com link | Investing.com search page, parsed for the `flag: USA` listing |
| Links | Open in your default browser via `shell.openExternal` (host allowlist: yahoo.com, investing.com, tradingview.com, zacks.com) |

Clicking a symbol opens a small menu with **Yahoo Finance**, **Investing.com**, and **TradingView** — pick one and that page opens in your browser. Nothing opens a browser until you pick a link; all data fetching happens in the background over plain HTTP from the app's main process.

Technical ratings use TradingView's own bucketing of the `Recommend.All` score:

| Score | Rating |
|---|---|
| ≥ 0.5 | Strong Buy |
| 0.1 … 0.5 | Buy |
| −0.1 … 0.1 | Neutral |
| −0.5 … −0.1 | Sell |
| ≤ −0.5 | Strong Sell |

## Alerts

Each of the five technical ratings has its own sound, chosen in **Settings → Alert sounds**:

| Rating | Default |
|---|---|
| Strong Buy | Arpeggio |
| Buy | Chime |
| Neutral | Tick |
| Sell | Pulse |
| Strong Sell | Buzz |

Available tones: **Arpeggio, Chime, Tick, Pulse, Buzz, Digital, None (silent)**. Each row has a ▶ preview button; right-clicking the speaker in the toolbar previews all five in order.

Sounds play only when a rating *changes* (not on every refresh), only while the US market is open, and only if **Play a sound when a rating changes** is enabled. The scheduler runs in the main process and the window is not background-throttled, so alerts still fire with the monitor blanked, the screen saver up, or the app minimised. When Windows itself sleeps, everything pauses; on wake the app refreshes immediately.

Every rating change is also shown visually, whether or not sounds are on: the affected row stays highlighted and a **Rating changes · today** strip under the table lists the symbol, the old → new rating, and the time it changed (newest first). The feed accumulates for the rest of the local day and clears automatically at midnight; it scrolls if there are many changes. Highlights stay with those changed rows for the day.

Clicking anywhere on a table row — ticker, price, change, volume or rating — opens the link menu (Yahoo Finance, Investing.com, TradingView, Zacks).

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
  sources/yahoo.js, tradingview.js, investing.js
  quotes.js        merges quotes + ratings into table rows
  links.js         builds and validates the three outbound links
  store.js         atomic JSON persistence (watchlist + display settings)
src/preload/       contextBridge API exposed to both renderers
src/renderer/      UI (compact table, add modal, link menu, settings panel)
  overlay.html/js  read-only click-through heads-up display
tools/             dev helpers: data smoke test, UI screenshots, icon generator
```

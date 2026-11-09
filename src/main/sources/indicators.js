'use strict';

/*
 * A TradingView-style technical gauge computed locally from OHLC candles.
 *
 * Twelve Data and Alpha Vantage sell raw prices and individual indicators,
 * not a buy/sell verdict, so the app turns their candles into the same
 * Strong Buy … Strong Sell scale using the voting rules TradingView documents
 * for its own "Technical Ratings": each moving average and oscillator votes
 * +1 (buy), 0 (neutral) or -1 (sell); the two group averages are averaged.
 *
 * Bars are oldest first: { open, high, low, close }.
 */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's smoothing (RMA), used by RSI and ADX.
function rma(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const g = rma(gains.slice(1), period);
  const l = rma(losses.slice(1), period);
  const out = [null];
  for (let i = 0; i < g.length; i += 1) {
    if (g[i] == null || l[i] == null) out.push(null);
    else if (l[i] === 0) out.push(100);
    else out.push(100 - 100 / (1 + g[i] / l[i]));
  }
  return out;
}

function stoch(bars, kPeriod = 14, smoothK = 3, dPeriod = 3) {
  const raw = bars.map((bar, i) => {
    if (i < kPeriod - 1) return null;
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const hi = Math.max(...slice.map((b) => b.high));
    const lo = Math.min(...slice.map((b) => b.low));
    return hi === lo ? 50 : ((bar.close - lo) / (hi - lo)) * 100;
  });
  const k = smoothNullable(raw, smoothK);
  const d = smoothNullable(k, dPeriod);
  return { k, d };
}

function smoothNullable(values, period) {
  const start = values.findIndex((v) => v != null);
  const out = new Array(values.length).fill(null);
  if (start < 0) return out;
  const tail = sma(values.slice(start), period);
  tail.forEach((v, i) => {
    out[start + i] = v;
  });
  return out;
}

function cci(bars, period = 20) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  const mean = sma(tp, period);
  return tp.map((value, i) => {
    if (mean[i] == null) return null;
    const slice = tp.slice(i - period + 1, i + 1);
    const dev = slice.reduce((acc, v) => acc + Math.abs(v - mean[i]), 0) / period;
    return dev === 0 ? 0 : (value - mean[i]) / (0.015 * dev);
  });
}

function adx(bars, period = 14) {
  const plusDm = [];
  const minusDm = [];
  const tr = [];
  for (let i = 1; i < bars.length; i += 1) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
    tr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }
  const atr = rma(tr, period);
  const pdm = rma(plusDm, period);
  const mdm = rma(minusDm, period);
  const pdi = [];
  const mdi = [];
  const dx = [];
  for (let i = 0; i < tr.length; i += 1) {
    if (atr[i] == null || atr[i] === 0) {
      pdi.push(null);
      mdi.push(null);
      dx.push(null);
      continue;
    }
    const p = (100 * pdm[i]) / atr[i];
    const m = (100 * mdm[i]) / atr[i];
    pdi.push(p);
    mdi.push(m);
    dx.push(p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m));
  }
  const start = dx.findIndex((v) => v != null);
  const adxLine = new Array(dx.length).fill(null);
  if (start >= 0) {
    rma(dx.slice(start), period).forEach((v, i) => {
      adxLine[start + i] = v;
    });
  }
  // Re-align to the bars array (index 0 has no previous bar).
  return { adx: [null, ...adxLine], pdi: [null, ...pdi], mdi: [null, ...mdi] };
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
  const sig = smoothEma(line, signal);
  return { line, signal: sig };
}

function smoothEma(values, period) {
  const start = values.findIndex((v) => v != null);
  const out = new Array(values.length).fill(null);
  if (start < 0) return out;
  ema(values.slice(start), period).forEach((v, i) => {
    out[start + i] = v;
  });
  return out;
}

function williams(bars, period = 14) {
  return bars.map((bar, i) => {
    if (i < period - 1) return null;
    const slice = bars.slice(i - period + 1, i + 1);
    const hi = Math.max(...slice.map((b) => b.high));
    const lo = Math.min(...slice.map((b) => b.low));
    return hi === lo ? -50 : ((hi - bar.close) / (hi - lo)) * -100;
  });
}

function awesome(bars) {
  const mid = bars.map((b) => (b.high + b.low) / 2);
  const s5 = sma(mid, 5);
  const s34 = sma(mid, 34);
  return mid.map((_, i) => (s5[i] == null || s34[i] == null ? null : s5[i] - s34[i]));
}

const last = (arr, back = 0) => (arr.length > back ? arr[arr.length - 1 - back] : null);
const ok = (...values) => values.every((v) => typeof v === 'number' && Number.isFinite(v));

function bucket(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= 0.5) return 'Strong Buy';
  if (score >= 0.1) return 'Buy';
  if (score > -0.1) return 'Neutral';
  if (score > -0.5) return 'Sell';
  return 'Strong Sell';
}

function tally(votes) {
  const counts = { buy: 0, neutral: 0, sell: 0 };
  for (const vote of votes) {
    if (vote > 0) counts.buy += 1;
    else if (vote < 0) counts.sell += 1;
    else counts.neutral += 1;
  }
  return counts;
}

/**
 * Compute the gauge from oldest-first bars.
 * Returns null when there is not enough history for a meaningful vote.
 */
function rateBars(rawBars) {
  const bars = (rawBars || []).filter((b) => ok(b.open, b.high, b.low, b.close));
  if (bars.length < 35) return null;

  const closes = bars.map((b) => b.close);
  const close = last(closes);

  /* moving averages */
  const maVotes = [];
  for (const period of [10, 20, 30, 50, 100, 200]) {
    if (closes.length < period) continue;
    for (const line of [sma(closes, period), ema(closes, period)]) {
      const value = last(line);
      if (!ok(value)) continue;
      maVotes.push(close > value ? 1 : close < value ? -1 : 0);
    }
  }

  /* oscillators */
  const osc = [];
  const detail = {};

  const r = rsi(closes);
  const r0 = last(r);
  const r1 = last(r, 1);
  if (ok(r0, r1)) {
    detail.rsi = r0;
    osc.push(r0 < 30 && r0 > r1 ? 1 : r0 > 70 && r0 < r1 ? -1 : 0);
  }

  const st = stoch(bars);
  const k = last(st.k);
  const d = last(st.d);
  if (ok(k, d)) osc.push(k < 20 && d < 20 && k > d ? 1 : k > 80 && d > 80 && k < d ? -1 : 0);

  const c = cci(bars);
  const c0 = last(c);
  const c1 = last(c, 1);
  if (ok(c0, c1)) osc.push(c0 < -100 && c0 > c1 ? 1 : c0 > 100 && c0 < c1 ? -1 : 0);

  const a = adx(bars);
  const a0 = last(a.adx);
  const a1 = last(a.adx, 1);
  const p0 = last(a.pdi);
  const m0 = last(a.mdi);
  if (ok(a0, a1, p0, m0)) {
    detail.adx = a0;
    osc.push(a0 > 20 && a0 > a1 && p0 > m0 ? 1 : a0 > 20 && a0 > a1 && m0 > p0 ? -1 : 0);
  }

  const ao = awesome(bars);
  const ao0 = last(ao);
  const ao1 = last(ao, 1);
  if (ok(ao0, ao1)) osc.push(ao0 > 0 && ao0 > ao1 ? 1 : ao0 < 0 && ao0 < ao1 ? -1 : 0);

  if (closes.length > 11) {
    const mom0 = close - closes[closes.length - 11];
    const mom1 = closes[closes.length - 2] - closes[closes.length - 12];
    if (ok(mom0, mom1)) osc.push(mom0 > mom1 ? 1 : mom0 < mom1 ? -1 : 0);
  }

  const m = macd(closes);
  const ml = last(m.line);
  const ms = last(m.signal);
  if (ok(ml, ms)) {
    detail.macd = ml - ms;
    osc.push(ml > ms ? 1 : ml < ms ? -1 : 0);
  }

  const w = williams(bars);
  const w0 = last(w);
  const w1 = last(w, 1);
  if (ok(w0, w1)) osc.push(w0 < -80 && w0 > w1 ? 1 : w0 > -20 && w0 < w1 ? -1 : 0);

  if (!maVotes.length || !osc.length) return null;

  const avg = (votes) => votes.reduce((sum, v) => sum + v, 0) / votes.length;
  const maScore = avg(maVotes);
  const oscScore = avg(osc);
  const score = (maScore + oscScore) / 2;

  return {
    rating: bucket(score),
    score,
    maScore,
    oscScore,
    ma: tally(maVotes),
    osc: tally(osc),
    close,
    bars: bars.length,
    ...detail,
  };
}

/** Human-readable tooltip lines shared by every candle-based provider. */
function gaugeLines(result) {
  if (!result) return [];
  const lines = [
    `Score ${result.score.toFixed(2)}  (MA ${result.maScore.toFixed(2)} · Osc ${result.oscScore.toFixed(2)})`,
    `Moving averages: ${result.ma.buy} buy · ${result.ma.neutral} neutral · ${result.ma.sell} sell`,
    `Oscillators: ${result.osc.buy} buy · ${result.osc.neutral} neutral · ${result.osc.sell} sell`,
  ];
  const extra = [];
  if (ok(result.rsi)) extra.push(`RSI ${result.rsi.toFixed(1)}`);
  if (ok(result.adx)) extra.push(`ADX ${result.adx.toFixed(1)}`);
  if (ok(result.macd)) extra.push(`MACD hist ${result.macd >= 0 ? '+' : ''}${result.macd.toFixed(3)}`);
  if (extra.length) lines.push(extra.join(' · '));
  return lines;
}

module.exports = { rateBars, gaugeLines, bucket, sma, ema, rsi, macd, adx, stoch, cci, williams };

'use strict';

const { curlText } = require('./investing');

/*
 * Investing.com's technical analysis gauge is served by an internal JSON
 * endpoint. It needs the numeric instrument id (pairId) from their search
 * results, and the domain-id header the site itself sends.
 */

const SUMMARY_LABELS = {
  strong_buy: 'Strong Buy',
  buy: 'Buy',
  neutral: 'Neutral',
  sell: 'Sell',
  strong_sell: 'Strong Sell',
};

function normalizeSummary(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^_+/, '')
    .replace(/^(currencies|moving_avarge_tool|technical)_+/, '');
  return SUMMARY_LABELS[key] || null;
}

function parseUpdateTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchTechnical(pairId, timeframe = '30m') {
  const id = Number(pairId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Missing Investing.com instrument id');
  }

  const text = await curlText(
    `https://api.investing.com/api/financialdata/technical/analysis/${Math.round(id)}/${timeframe}`,
    {
      accept: 'application/json, text/plain, */*',
      secFetch: false,
      headers: [
        'Origin: https://www.investing.com',
        'Referer: https://www.investing.com/',
        'domain-id: www',
      ],
    }
  );

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error('Investing.com blocked the technical request');
    error.blocked = true;
    throw error;
  }

  const rating = normalizeSummary(payload && payload.summary);
  if (!rating) {
    const error = new Error('Investing.com returned no technical summary');
    error.blocked = true;
    throw error;
  }

  return {
    rating,
    timeframe: String(payload.timeframe || timeframe),
    updatedAt: parseUpdateTime(payload.lastUpdateTime) || Date.now(),
    // Kept for the tooltip: the gauge's underlying components.
    maRating: normalizeSummary(payload.movingAverages && payload.movingAverages.summary && payload.movingAverages.summary.value),
    oscRating: normalizeSummary(
      payload.indicators && payload.indicators.summary && payload.indicators.summary.value
    ),
  };
}

module.exports = { fetchTechnical, normalizeSummary };

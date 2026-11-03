'use strict';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Small JSON fetch helper with a browser-ish header set and bounded retries.
 * Yahoo/TradingView throttle bare requests, so a UA + retry with backoff helps a lot.
 */
async function fetchJson(url, { headers = {}, timeout = 15000, retries = 2 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(400 * attempt);

    let response;
    try {
      response = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      lastError = error;
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`HTTP ${response.status}`);
      continue;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    try {
      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Request failed');
}

module.exports = { fetchJson, UA, sleep };

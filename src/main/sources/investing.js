'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { UA } = require('./http');

const execFileAsync = promisify(execFile);

/*
 * Investing.com sits behind Cloudflare and rejects requests made with Node's
 * TLS fingerprint. curl.exe (shipped with Windows 10 1803+) passes, so the
 * search page is fetched through it and parsed locally.
 */
async function curlText(url) {
  const args = [
    '-s',
    '--max-time',
    '20',
    '--compressed',
    '-H',
    `User-Agent: ${UA}`,
    '-H',
    'Accept: text/html,application/xhtml+xml',
    '-H',
    'Accept-Language: en-US,en;q=0.9',
    '-H',
    'Sec-Fetch-Dest: document',
    '-H',
    'Sec-Fetch-Mode: navigate',
    '-H',
    'Sec-Fetch-Site: none',
    url,
  ];

  for (const binary of ['curl.exe', 'curl']) {
    try {
      const { stdout } = await execFileAsync(binary, args, {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 25000,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      if (error && error.code === 'ENOENT') continue;
      throw error;
    }
  }

  throw new Error('curl is not available');
}

function extractResultsArray(html) {
  const marker = 'window.allResultsQuotesDataArray';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = html.indexOf('[', markerIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/**
 * Resolve the United States quote page for a symbol on Investing.com.
 *
 * The search returns the same company on several exchanges (USA, Switzerland,
 * Mexico, ...). The USA entry is the one without a "?cid=" country suffix.
 */
async function resolveInvestingUrl(symbol) {
  const html = await curlText(
    `https://www.investing.com/search/?q=${encodeURIComponent(symbol)}`
  );

  const results = extractResultsArray(html);
  if (!results) throw new Error('Could not read Investing.com results');

  const instruments = results.filter(
    (row) => typeof row.type === 'string' && /^(stock|etf)/i.test(row.type)
  );

  const usListings = instruments.filter((row) => String(row.flag || '').toUpperCase() === 'USA');
  const exact = usListings.find(
    (row) => String(row.symbol || '').toUpperCase() === String(symbol).toUpperCase()
  );
  const chosen = exact || usListings[0];

  if (!chosen || !chosen.link) throw new Error('No United States listing found');

  return `https://www.investing.com${String(chosen.link).split('?')[0]}`;
}

module.exports = { resolveInvestingUrl, extractResultsArray };

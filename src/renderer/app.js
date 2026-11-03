'use strict';

const $ = (selector) => document.querySelector(selector);

const SOUND_LABELS = {
  arpeggio: 'Arpeggio',
  chime: 'Chime',
  tick: 'Tick',
  pulse: 'Pulse',
  buzz: 'Buzz',
  digital: 'Digital',
  none: 'None (silent)',
};

// Maps a technical rating to its key in settings.sounds.
const SOUND_KEYS = {
  'Strong Buy': 'strongBuy',
  Buy: 'buy',
  Neutral: 'neutral',
  Sell: 'sell',
  'Strong Sell': 'strongSell',
};

const state = {
  rows: [],
  settings: { intervalMinutes: 10, alertsEnabled: true, sounds: {}, display: {} },
  sort: { key: null, dir: 1 },
  countdown: 10 * 60,
  popoverSymbol: null,
  searchResults: [],
  searchSeq: 0,
  searchTimer: null,
  adding: false,
  refreshing: false,
  lastInterval: 10,
  // All rating transitions for the current local day. Cleared at midnight.
  // Newest first.
  changes: [],
  changesDay: '',
};

/* ---------- formatting ---------- */

const priceFormatters = new Map();

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
  });
}

function fmtPrice(value, currency) {
  if (value == null || !Number.isFinite(value)) return '&mdash;';
  const code = currency || 'USD';
  if (!priceFormatters.has(code)) {
    priceFormatters.set(
      code,
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }
  return esc(priceFormatters.get(code).format(value));
}

function fmtVolume(value) {
  if (value == null || !Number.isFinite(value)) return '&mdash;';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function ratingClass(rating) {
  switch (rating) {
    case 'Strong Buy':
      return 'sb';
    case 'Buy':
      return 'b';
    case 'Neutral':
      return 'n';
    case 'Sell':
      return 's';
    case 'Strong Sell':
      return 'ss';
    default:
      return 'na';
  }
}

function cleanError(error) {
  const message = (error && error.message) || String(error || 'Something went wrong');
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

/* ---------- rendering ---------- */

function orderedRows() {
  const { key, dir } = state.sort;
  if (!key) return state.rows.slice();

  const valueOf = (row) => {
    if (key === 'symbol') return row.symbol;
    if (key === 'rating') return row.ratingScore;
    return row[key];
  };

  return state.rows.slice().sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    if (typeof left === 'string') return left.localeCompare(right) * dir;
    return (left - right) * dir;
  });
}

function rowTemplate(row) {
  const stale = row.quoteError ? ' class="is-stale"' : '';
  const changeClass =
    row.changePct == null ? 'flat' : row.changePct > 0 ? 'up' : row.changePct < 0 ? 'down' : 'flat';
  const changeText =
    row.changePct == null
      ? '&mdash;'
      : `${row.changePct > 0 ? '+' : ''}${row.changePct.toFixed(2)}%`;

  // The exchange is a small inline tag on the ticker line; that is what lets
  // the whole row collapse to ~34px.
  const exchange = row.quoteError
    ? '<span class="exch warn">offline</span>'
    : row.exchange
      ? `<span class="exch">${esc(row.exchange)}</span>`
      : '';

  const ratingTitle = row.ratingError ? ` title="${esc(row.ratingError)}"` : '';

  return `
    <tr data-symbol="${esc(row.symbol)}"${stale}>
      <td class="cell-symbol">
        <button type="button" class="sym" data-symbol="${esc(row.symbol)}" title="Open ${esc(
          row.name
        )} on another site">${esc(row.symbol)}</button>${exchange}
      </td>
      <td class="num">${fmtPrice(row.open, row.currency)}</td>
      <td class="num">${fmtPrice(row.price, row.currency)}</td>
      <td class="num"><span class="delta ${changeClass}">${changeText}</span></td>
      <td class="num">${fmtVolume(row.volume)}</td>
      <td><span class="pill ${ratingClass(row.rating)}"${ratingTitle}><i></i>${esc(
        row.rating || '—'
      )}</span></td>
      <td>
        <button type="button" class="row-remove" data-remove="${esc(row.symbol)}" title="Remove ${esc(
          row.symbol
        )}">&times;</button>
      </td>
    </tr>`;
}

function applySortIndicators() {
  document.querySelectorAll('.grid th.sortable').forEach((th) => {
    if (state.sort.key === th.dataset.sort) th.dataset.dir = state.sort.dir === 1 ? 'asc' : 'desc';
    else delete th.dataset.dir;
  });
}

/* ---------- auto-fit height ---------- */

let fitQueued = false;

function desiredHeight() {
  const topbar = $('.topbar');
  const stage = $('.stage');

  // The stage is sized by its content, so this is the height the window needs
  // to show every row with no scrollbar.
  let height = topbar.offsetHeight + stage.offsetHeight + 2;

  // Dialogs are fixed-position overlays and do not add to the stage height, so
  // grow the window temporarily to keep them fully visible.
  const settingsOpen = !$('#settingsModal').hidden;
  const addOpen = !$('#modal').hidden;

  if (settingsOpen) {
    // The settings card keeps its own scrollable body, so measure the content
    // explicitly: card.scrollHeight only equals the visible (clamped) card.
    const card = $('#settingsModal .settings-card');
    const style = getComputedStyle(card);
    const head = card.querySelector('.modal-head');
    const body = card.querySelector('.settings-body');
    const foot = card.querySelector('.modal-foot');
    const bodyGap = parseFloat(getComputedStyle(body).marginTop) || 0;
    const footGap = parseFloat(getComputedStyle(foot).marginTop) || 0;
    const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const content =
      padding + head.offsetHeight + bodyGap + body.scrollHeight + footGap + foot.offsetHeight;
    height = Math.max(height, content + 64);
  } else if (addOpen) {
    height = Math.max(height, $('#modal .modal-card').scrollHeight + 72);
  }

  return Math.ceil(height);
}

function scheduleFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    window.api.fit(desiredHeight());
  });
}

function render() {
  const rows = orderedRows();
  $('#gridBody').innerHTML = rows.map(rowTemplate).join('');

  const hasRows = rows.length > 0;
  $('#grid').classList.toggle('hidden', !hasRows);
  $('#emptyState').classList.toggle('hidden', hasRows);

  applySortIndicators();
  applyChangeHighlights();
  renderChangeFeed();
  scheduleFit();
}

function updateHeader(payload) {
  const chip = $('#marketChip');
  const hasRows = state.rows.length > 0;
  const open = Boolean(payload && payload.marketOpen);

  if (!hasRows) {
    chip.textContent = 'Idle';
    chip.className = 'chip';
  } else {
    chip.textContent = open ? 'Market open' : 'Market closed';
    chip.className = `chip ${open ? 'open' : 'closed'}`;
  }

  const updated = payload && payload.updatedAt ? new Date(payload.updatedAt) : null;
  $('#updated').textContent = updated
    ? `Updated ${updated.toLocaleTimeString('en-US', { hour12: false })}`
    : 'Waiting for data';

  syncSoundButton();
}

function syncSoundButton() {
  const button = $('#soundBtn');
  button.textContent = state.settings.alertsEnabled ? '\u{1F50A}' : '\u{1F507}';
  button.classList.toggle('muted', !state.settings.alertsEnabled);
  button.title = state.settings.alertsEnabled
    ? 'Alert sounds on (right-click to test)'
    : 'Alert sounds off (right-click to test)';
}

/* ---------- countdown ---------- */

function resetCountdown() {
  state.countdown = Math.max(1, Number(state.settings.intervalMinutes) || 10) * 60;
  renderCountdown();
}

function renderCountdown() {
  const total = Math.max(0, state.countdown);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  $('#countdown').textContent =
    total > 0 ? `Next ${minutes}:${String(seconds).padStart(2, '0')}` : 'Refreshing…';
}

function tick() {
  if (state.countdown > 0) state.countdown -= 1;
  renderCountdown();
}

/* ---------- toasts ---------- */

function toast(html, kind = '') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`.trim();
  item.innerHTML = html;
  $('#toasts').appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(6px)';
    item.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => item.remove(), 220);
  }, 5200);
}

function flashRow(symbol, buy) {
  const row = document.querySelector(`tr[data-symbol="${CSS.escape(symbol)}"]`);
  if (!row) return;
  const cls = buy ? 'flash-buy' : 'flash-sell';
  row.classList.add(cls);
  setTimeout(() => row.classList.remove(cls), 2800);
}

/* ---------- rating changes ---------- */

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function changeTone(rating) {
  if (rating === 'Strong Buy' || rating === 'Buy') return 'buy';
  if (rating === 'Strong Sell' || rating === 'Sell') return 'sell';
  return 'neutral';
}

function changeTime(at) {
  const date = new Date(Number(at) || Date.now());
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function ensureChangeDay() {
  const key = todayKey();
  if (state.changesDay !== key) {
    state.changesDay = key;
    state.changes = [];
  }
}

// gridBody.innerHTML is replaced on every render, so the highlight has to be
// re-applied afterwards rather than toggled once when the alert arrives.
// Highlights persist for the day alongside the feed entries.
function applyChangeHighlights() {
  ensureChangeDay();
  for (const change of state.changes) {
    const row = document.querySelector(`tr[data-symbol="${CSS.escape(change.symbol)}"]`);
    if (!row) continue;
    row.classList.add('row-changed', `row-changed-${changeTone(change.rating)}`);
  }
}

function renderChangeFeed() {
  ensureChangeDay();
  const feed = $('#changeFeed');
  if (!feed) return;

  const changes = state.changes || [];
  feed.hidden = changes.length === 0;
  if (!changes.length) {
    $('#changeFeedItems').innerHTML = '';
    const head = feed.querySelector('.change-feed-head span');
    if (head) head.textContent = 'Rating changes · today';
    return;
  }

  const head = feed.querySelector('.change-feed-head span');
  if (head) head.textContent = `Rating changes · today (${changes.length})`;

  $('#changeFeedItems').innerHTML = changes
    .map((change) => {
      const tone = changeTone(change.rating);
      return `
        <div class="change-item ${tone}">
          <span class="change-time">${esc(changeTime(change.at))}</span>
          <span class="change-symbol">${esc(change.symbol)}</span>
          <span class="change-move">
            <span class="change-from">${esc(change.from)}</span>
            <span class="change-arrow">&rarr;</span>
            <b>${esc(change.rating)}</b>
          </span>
        </div>`;
    })
    .join('');
}

/* ---------- alerts ---------- */

function handleAlerts(alerts) {
  alerts.forEach((alert, index) => {
    const key = SOUND_KEYS[alert.rating] || 'neutral';
    const tone = changeTone(alert.rating);

    setTimeout(() => {
      const canPlay = state.settings.alertsEnabled && alert.marketOpen !== false;
      if (canPlay) {
        const sounds = state.settings.sounds || {};
        window.Sounds.play(sounds[key] || 'arpeggio');
      }
      // Neutral has no one-off flash; its persistent highlight is enough.
      if (tone !== 'neutral') flashRow(alert.symbol, tone === 'buy');
    }, index * 700);
  });
}

/* ---------- link popover ---------- */

function openPopover(symbol, anchor) {
  const row = state.rows.find((entry) => entry.symbol === symbol);
  if (!row) return;

  state.popoverSymbol = symbol;
  $('#popSymbol').textContent = symbol;
  $('#popOptions').innerHTML = (row.links || [])
    .map(
      (link) => `
      <button type="button" class="pop-item" data-link="${esc(link.id)}" title="${esc(link.hint || '')}">
        <span class="pop-label">${esc(link.label)}</span>
        <span class="pop-hint">${esc(link.hint || '')}</span>
        <span class="pop-arrow">&#8599;</span>
      </button>`
    )
    .join('');

  const popover = $('#popover');
  popover.hidden = false;

  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth || 258;
  const height = popover.offsetHeight || 160;
  let left = rect.left;
  let top = rect.bottom + 8;

  if (left + width > window.innerWidth - 12) left = window.innerWidth - width - 12;
  if (top + height > window.innerHeight - 12) top = rect.top - height - 8;

  popover.style.left = `${Math.max(10, left)}px`;
  popover.style.top = `${Math.max(10, top)}px`;
}

function closePopover() {
  $('#popover').hidden = true;
  state.popoverSymbol = null;
}

async function openLink(linkId) {
  const symbol = state.popoverSymbol;
  closePopover();
  if (!symbol) return;
  try {
    await window.api.openLink(symbol, linkId);
  } catch (error) {
    toast(cleanError(error), 'error');
  }
}

/* ---------- add modal ---------- */

function openModal() {
  if (!$('#settingsModal').hidden) closeSettings();
  $('#modal').hidden = false;
  $('#searchInput').value = '';
  $('#searchResults').innerHTML = '<div class="results-note">Start typing a ticker or company name.</div>';
  $('#searchStatus').textContent = '';
  state.searchResults = [];
  $('#searchInput').focus();
  window.Sounds.unlock();
  scheduleFit();
}

function closeModal() {
  $('#modal').hidden = true;
  state.searchSeq += 1;
  clearTimeout(state.searchTimer);
  scheduleFit();
}

function renderResults(results) {
  state.searchResults = results;
  const container = $('#searchResults');

  if (!results.length) {
    container.innerHTML = '<div class="results-note">Nothing matched. Try a different ticker or the full company name.</div>';
    return;
  }

  container.innerHTML = results
    .map(
      (result, index) => `
      <button type="button" class="result-item" data-index="${index}">
        <span class="result-sym">${esc(result.symbol)}</span>
        <span class="result-name">${esc(result.name)}</span>
        <span class="badge ${result.isUS ? 'us' : ''}">${esc(
        result.exchangeDisp || result.exchange || '—'
      )}</span>
      </button>`
    )
    .join('');
}

async function runSearch(term) {
  const query = String(term || '').trim();
  const seq = (state.searchSeq += 1);

  if (!query) {
    state.searchResults = [];
    $('#searchResults').innerHTML =
      '<div class="results-note">Start typing a ticker or company name.</div>';
    $('#searchStatus').textContent = '';
    return;
  }

  $('#searchStatus').textContent = 'Searching…';

  try {
    const results = await window.api.search(query);
    if (seq !== state.searchSeq) return;
    renderResults(results);
    $('#searchStatus').textContent = results.length
      ? `${results.length} result${results.length === 1 ? '' : 's'}`
      : '';
  } catch (error) {
    if (seq !== state.searchSeq) return;
    state.searchResults = [];
    $('#searchResults').innerHTML = `<div class="results-note">Could not search right now. ${esc(
      cleanError(error)
    )}</div>`;
    $('#searchStatus').textContent = '';
  }
}

async function addCandidate(candidate) {
  if (!candidate || state.adding) return;

  state.adding = true;
  $('#searchStatus').textContent = `Adding ${candidate.symbol}…`;

  try {
    await window.api.add(candidate);
    closeModal();
    toast(`Added <b>${esc(candidate.symbol)}</b>. Fetching its first quote…`);
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  } finally {
    state.adding = false;
    $('#searchStatus').textContent = '';
  }
}

/* ---------- settings panel ---------- */

function setSegment(selector, value) {
  document.querySelectorAll(`${selector} button`).forEach((button) => {
    const active = button.dataset.bg === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function syncSettingsControls() {
  const display = state.settings.display;
  if (!display) return;

  const background = display.overlayBackground || 'none';
  const dim = Math.round((display.overlayDim == null ? 0.45 : display.overlayDim) * 100);
  const width = Number(display.overlayWidth) || 300;
  const margin = Number(display.overlayMargin) || 0;
  const columns = display.overlayColumns || {};

  $('#setOverlayEnabled').checked = Boolean(display.overlayEnabled);
  $('#setAlwaysOnTop').checked = Boolean(display.mainAlwaysOnTop);
  $('#setSounds').checked = state.settings.alertsEnabled !== false;

  setSegment('#setBackground', background);
  $('#dimRow').classList.toggle('hidden', background !== 'dim');
  $('#setDim').value = String(dim);
  $('#dimValue').textContent = `${dim}%`;

  $('#setWidth').value = String(width);
  $('#widthValue').textContent = `${width}px`;

  $('#setMargin').value = String(margin);
  $('#marginValue').textContent = `${margin}px`;

  $('#setCorner').value = display.overlayCorner || 'top-right';

  $('#colPrice').checked = columns.price !== false;
  $('#colChange').checked = columns.change !== false;
  $('#colRating').checked = columns.rating !== false;

  const sounds = state.settings.sounds || {};
  document.querySelectorAll('#soundList .sound-row').forEach((row) => {
    const select = row.querySelector('.sound-select');
    select.value = sounds[row.dataset.key] || 'arpeggio';
  });

  syncSoundButton();
}

function openSettings() {
  if (!$('#modal').hidden) closeModal();
  closePopover();
  $('#settingsModal').hidden = false;
  syncSettingsControls();
  scheduleFit();
  window.Sounds.unlock();
}

function closeSettings() {
  $('#settingsModal').hidden = true;
  scheduleFit();
}

async function updateDisplay(patch) {
  try {
    const settings = await window.api.setSettings({ display: patch });
    if (settings) state.settings = settings;
    syncSettingsControls();
    scheduleFit();
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

function populateSoundOptions() {
  document.querySelectorAll('#soundList .sound-row').forEach((row) => {
    const select = row.querySelector('.sound-select');
    if (select.options.length) return;
    select.innerHTML = Object.entries(SOUND_LABELS)
      .map(([value, label]) => `<option value="${value}">${label}</option>`)
      .join('');
  });
}

async function updateSound(key, value) {
  try {
    const settings = await window.api.setSettings({ sounds: { [key]: value } });
    if (settings) state.settings = settings;
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

/* ---------- actions ---------- */

async function manualRefresh() {
  if (state.refreshing) return;

  state.refreshing = true;
  $('#refreshBtn').classList.add('spinning');

  try {
    await window.api.refresh();
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  } finally {
    state.refreshing = false;
    $('#refreshBtn').classList.remove('spinning');
  }
}

async function toggleSound() {
  state.settings.alertsEnabled = !state.settings.alertsEnabled;
  syncSoundButton();
  try {
    await window.api.setSettings({ alertsEnabled: state.settings.alertsEnabled });
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

async function changeInterval(value) {
  const minutes = Number(value);
  try {
    const settings = await window.api.setSettings({ intervalMinutes: minutes });
    state.settings = settings;
    state.lastInterval = minutes;
    resetCountdown();
    toast(`Auto-refresh set to every <b>${minutes} minute${minutes === 1 ? '' : 's'}</b>.`);
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

/* ---------- events ---------- */

function wireEvents() {
  const openAdd = () => openModal();
  $('#addBtn').addEventListener('click', openAdd);
  $('#emptyAddBtn').addEventListener('click', openAdd);
  $('#cancelBtn').addEventListener('click', closeModal);

  $('#modal').addEventListener('click', (event) => {
    if (event.target === $('#modal')) closeModal();
  });

  $('#searchInput').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => runSearch(value), 220);
  });

  $('#searchInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && state.searchResults.length) {
      event.preventDefault();
      addCandidate(state.searchResults[0]);
    }
  });

  $('#searchResults').addEventListener('click', (event) => {
    const button = event.target.closest('.result-item');
    if (!button) return;
    const result = state.searchResults[Number(button.dataset.index)];
    if (result) addCandidate(result);
  });

  $('#gridBody').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const symbol = remove.dataset.remove;
      window.api
        .remove(symbol)
        .then((removed) => {
          if (removed) {
            toast(`Removed <b>${esc(symbol)}</b>.`);
            scheduleFit();
          }
        })
        .catch((error) => toast(esc(cleanError(error)), 'error'));
      return;
    }

    const symbolButton = event.target.closest('.sym');
    if (symbolButton) {
      openPopover(symbolButton.dataset.symbol, symbolButton);
      return;
    }

    // The whole row is a click target, not just the ticker text.
    const row = event.target.closest('tr[data-symbol]');
    if (row) {
      openPopover(row.dataset.symbol, row.querySelector('.sym') || row);
    }
  });

  $('#popOptions').addEventListener('click', (event) => {
    const button = event.target.closest('[data-link]');
    if (button) openLink(button.dataset.link);
  });

  document.addEventListener('click', (event) => {
    const popover = $('#popover');
    if (popover.hidden) return;
    if (popover.contains(event.target)) return;
    // Clicks on the ticker or anywhere in the table are what opened the menu,
    // so they must not immediately close it again.
    if (event.target.closest('#gridBody') || event.target.closest('.sym')) return;
    closePopover();
  });

  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', closePopover, true);

  document.querySelectorAll('.grid th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 1 ? -1 : 1;
      } else {
        state.sort.key = key;
        state.sort.dir = key === 'symbol' ? 1 : -1;
      }
      render();
    });
  });

  $('#refreshBtn').addEventListener('click', manualRefresh);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#closeSettingsBtn').addEventListener('click', closeSettings);

  $('#settingsModal').addEventListener('click', (event) => {
    if (event.target === $('#settingsModal')) closeSettings();
  });

  $('#soundBtn').addEventListener('click', toggleSound);
  $('#soundBtn').addEventListener('contextmenu', (event) => {
    event.preventDefault();
    window.Sounds.previewAll(state.settings.sounds || {});
    toast('Previewing each rating sound in order: Strong Buy to Strong Sell.');
  });

  $('#soundList').addEventListener('change', (event) => {
    const select = event.target.closest('.sound-select');
    if (!select) return;
    const row = select.closest('.sound-row');
    updateSound(row.dataset.key, select.value);
  });

  $('#soundList').addEventListener('click', (event) => {
    const button = event.target.closest('.sound-preview');
    if (!button) return;
    const row = button.closest('.sound-row');
    const select = row.querySelector('.sound-select');
    window.Sounds.unlock();
    window.Sounds.play(select.value);
  });

  $('#intervalSelect').addEventListener('change', (event) => changeInterval(event.target.value));

  /* settings controls */

  $('#setOverlayEnabled').addEventListener('change', (event) =>
    updateDisplay({ overlayEnabled: event.target.checked })
  );

  $('#setAlwaysOnTop').addEventListener('change', (event) =>
    updateDisplay({ mainAlwaysOnTop: event.target.checked })
  );

  $('#setSounds').addEventListener('change', async (event) => {
    const enabled = event.target.checked;
    try {
      const settings = await window.api.setSettings({ alertsEnabled: enabled });
      state.settings = settings;
      syncSoundButton();
    } catch (error) {
      toast(esc(cleanError(error)), 'error');
    }
  });

  $('#setBackground').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-bg]');
    if (!button) return;
    const background = button.dataset.bg;
    setSegment('#setBackground', background);
    $('#dimRow').classList.toggle('hidden', background !== 'dim');
    updateDisplay({ overlayBackground: background });
  });

  $('#setDim').addEventListener('input', (event) => {
    $('#dimValue').textContent = `${event.target.value}%`;
  });
  $('#setDim').addEventListener('change', (event) =>
    updateDisplay({ overlayDim: Number(event.target.value) / 100 })
  );

  $('#setWidth').addEventListener('input', (event) => {
    $('#widthValue').textContent = `${event.target.value}px`;
  });
  $('#setWidth').addEventListener('change', (event) =>
    updateDisplay({ overlayWidth: Number(event.target.value) })
  );

  $('#setMargin').addEventListener('input', (event) => {
    $('#marginValue').textContent = `${event.target.value}px`;
  });
  $('#setMargin').addEventListener('change', (event) =>
    updateDisplay({ overlayMargin: Number(event.target.value) })
  );

  $('#setCorner').addEventListener('change', (event) =>
    updateDisplay({ overlayCorner: event.target.value })
  );

  const columnPatch = () => ({
    overlayColumns: {
      price: $('#colPrice').checked,
      change: $('#colChange').checked,
      rating: $('#colRating').checked,
    },
  });

  ['#colPrice', '#colChange', '#colRating'].forEach((selector) => {
    $(selector).addEventListener('change', () => updateDisplay(columnPatch()));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!$('#settingsModal').hidden) closeSettings();
      else if (!$('#modal').hidden) closeModal();
      else closePopover();
    }
    if (event.key.toLowerCase() === 'r' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      manualRefresh();
    }
    if (event.key.toLowerCase() === 'n' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      openModal();
    }
  });
}

/* ---------- boot ---------- */

function applySettingsToControls() {
  const select = $('#intervalSelect');
  const minutes = Number(state.settings.intervalMinutes) || 10;

  if (![...select.options].some((option) => Number(option.value) === minutes)) {
    const option = document.createElement('option');
    option.value = String(minutes);
    option.textContent = `${minutes} min`;
    select.appendChild(option);
  }
  select.value = String(minutes);
  state.lastInterval = minutes;
  syncSoundButton();
  syncSettingsControls();
}

function applySettings(settings) {
  if (!settings) return;

  const nextInterval = Number(settings.intervalMinutes) || 10;
  state.settings = settings;

  // A changed interval needs a fresh countdown; appearance tweaks do not.
  if (nextInterval !== state.lastInterval) {
    state.lastInterval = nextInterval;
    applySettingsToControls();
    resetCountdown();
  } else {
    syncSettingsControls();
  }
}

function handleUpdate(payload) {
  state.rows = payload.rows || [];
  if (payload.settings) applySettings(payload.settings);

  if (payload.reason !== 'links') {
    resetCountdown();
    ensureChangeDay();
    const newChanges = (payload.alerts || []).map((alert) => ({
      symbol: alert.symbol,
      rating: alert.rating,
      from: alert.from,
      at: alert.at || Date.now(),
    }));
    if (newChanges.length) {
      // Newest first, accumulated for the entire day.
      state.changes = [...newChanges, ...state.changes];
    }
  }

  updateHeader(payload);
  render();
  handleAlerts(payload.alerts || []);
}

async function boot() {
  populateSoundOptions();
  wireEvents();

  // Subscribe before the first read so a startup update cannot slip past us.
  window.api.onRows(handleUpdate);
  window.api.onSettings(applySettings);
  setInterval(tick, 1000);

  try {
    const initial = await window.api.init();
    state.rows = initial.rows || [];
    if (initial.settings) state.settings = initial.settings;
    applySettingsToControls();
    updateHeader(initial);
    resetCountdown();
    render();
  } catch (error) {
    toast(esc(cleanError(error)), 'error');
  }
}

boot();

// Service worker: fetches Amazon order data via a real (background) browser tab,
// then matches it to Bank of America charges.
// We use chrome.tabs + chrome.scripting instead of bare fetch() because Amazon's
// bot detection blocks service worker requests — a real tab with JS execution passes.

const ORDER_HISTORY_URL = 'https://www.amazon.com/gp/css/order-history';
const DATE_WINDOW_DAYS = 5;
const ORDER_LOOKBACK_MONTHS = 6;
const TAB_LOAD_TIMEOUT_MS = 30000;

// Prevents multiple concurrent scrapes from opening multiple Amazon tabs.
let scrapeInProgress = false;

// ─── Message Router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'MATCH_CHARGES') {
    handleMatchCharges(msg.charges)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'REFRESH_ORDERS') {
    refreshOrders().catch(console.error);
  }

  if (msg.type === 'GET_STATUS') {
    getStatus().then(sendResponse);
    return true;
  }

  if (msg.type === 'DEBUG_SCRAPE') {
    debugScrape().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ─── Main Match Flow ──────────────────────────────────────────────────────────

async function handleMatchCharges(charges) {
  if (!charges || charges.length === 0) return { results: {} };

  const dates = charges.map(c => new Date(c.date)).filter(d => !isNaN(d));
  if (dates.length === 0) return { results: {} };

  const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
  minDate.setDate(minDate.getDate() - DATE_WINDOW_DAYS);
  maxDate.setDate(maxDate.getDate() + DATE_WINDOW_DAYS);

  await ensureOrdersLoaded(minDate, maxDate);

  const { orders = [] } = await chrome.storage.local.get('orders');
  console.log('[ACI BG] Total cached orders:', orders.length);

  const results = {};
  for (const charge of charges) {
    const matches = findMatches(charge, orders);
    if (matches.length > 0) {
      results[chargeKey(charge)] = matches;
    }
  }

  console.log('[ACI BG] Matched', Object.keys(results).length, 'of', charges.length, 'charges');
  return { results };
}

// ─── Order Loading ────────────────────────────────────────────────────────────

async function ensureOrdersLoaded(minDate, maxDate) {
  const { fetchedOrderIds = [], orders = [] } = await chrome.storage.local.get([
    'fetchedOrderIds',
    'orders',
  ]);

  console.log('[ACI BG] Fetching orders between', minDate.toDateString(), 'and', maxDate.toDateString());

  if (scrapeInProgress) {
    console.log('[ACI BG] Scrape already in progress — skipping duplicate request.');
    return;
  }

  scrapeInProgress = true;
  let scraped;
  try {
    scraped = await fetchOrdersViaTab(minDate, maxDate);
  } catch (e) {
    console.warn('[ACI BG] Tab scrape failed:', e.message);
    return;
  } finally {
    scrapeInProgress = false;
  }

  console.log('[ACI BG] Scraped', scraped.length, 'order(s) from Amazon');

  const newOrders = scraped.filter(o => !fetchedOrderIds.includes(o.orderId));
  if (newOrders.length === 0) return;

  await chrome.storage.local.set({
    orders: dedup([...orders, ...newOrders], 'orderId'),
    fetchedOrderIds: [...new Set([...fetchedOrderIds, ...scraped.map(o => o.orderId)])],
    lastFetched: Date.now(),
  });

  console.log('[ACI BG] Stored', newOrders.length, 'new order(s)');
}

async function refreshOrders() {
  const { fetchedOrderIds = [], orders = [] } = await chrome.storage.local.get([
    'fetchedOrderIds',
    'orders',
  ]);
  const thirtyDaysAgo = Date.now() - 30 * 86400000;
  const staleIds = orders
    .filter(o => o.date && new Date(o.date).getTime() > thirtyDaysAgo)
    .map(o => o.orderId);
  await chrome.storage.local.set({
    fetchedOrderIds: fetchedOrderIds.filter(id => !staleIds.includes(id)),
    orders: orders.filter(o => !staleIds.includes(o.orderId)),
  });
  console.log('[ACI BG] Cleared', staleIds.length, 'recent order(s) for refresh.');
}

// ─── Tab-Based Amazon Scraper ─────────────────────────────────────────────────

// Opens a background tab to Amazon order history, waits for it to fully render
// (JS and all), runs an extraction script, then closes the tab.
// Returns an array of { orderId, date, items, total, chargeAmounts }.
async function fetchOrdersViaTab(minDate, maxDate) {
  // pageSize=50 covers most users for a 6-month window in one load.
  const url = `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=0&pageSize=50`;

  const html = await loadTabAndExtract(url, scrapeOrderHistoryPage);

  if (!html || !html.orders) {
    console.warn('[ACI BG] Tab scrape returned no orders. Page title was:', html?.pageTitle);
    return [];
  }

  // Normalise and filter to the date range.
  const results = [];
  for (const raw of html.orders) {
    const date = tryParseDate(raw.orderDate);
    if (date && date < minDate) continue;       // too old
    if (date && date > maxDate) continue;        // too new (shouldn't happen but be safe)

    results.push({
      orderId: raw.orderId,
      date: date ? date.toISOString().split('T')[0] : null,
      items: raw.items,
      total: raw.total,
      chargeAmounts: raw.total ? [raw.total] : [],
    });
  }

  return results;
}

// Opens a tab, waits for it to reach status=complete, runs `scriptFn` inside it,
// closes the tab, and returns the script's return value.
function loadTabAndExtract(url, scriptFn) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, tab => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      const tabId = tab.id;

      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.remove(tabId, () => {});
        reject(new Error('Timed out waiting for Amazon tab to load'));
      }, TAB_LOAD_TIMEOUT_MS);

      function onUpdated(updatedId, info) {
        if (updatedId !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);

        // Let post-load JS fully settle before injecting.
        setTimeout(() => {
          chrome.scripting.executeScript(
            { target: { tabId }, func: scriptFn },
            results => {
              chrome.tabs.remove(tabId, () => {});
              if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
              }
              if (!results || results.length === 0 || results[0].error) {
                return reject(new Error('Script execution failed'));
              }
              resolve(results[0].result);
            }
          );
        }, 2000);
      }

      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

// ─── In-Page Extraction Script ────────────────────────────────────────────────
// THIS FUNCTION RUNS INSIDE THE AMAZON TAB — fully self-contained, no external refs.
// It is async: it paginates Amazon's order history using in-tab fetch() calls,
// which are fully authenticated because they come from a real Amazon browser tab.

async function scrapeOrderHistoryPage() {
  const CARD_SELECTORS = [
    '.order',
    '[data-order-id]',
    'div[class*="order-card"]',
    '.a-box-group.order',
  ];
  const MAX_PAGES = 20; // safety cap — 20 pages × 10 orders = 200 orders max

  function extractOrdersFromDoc(doc) {
    const orders = [];
    let cards = [];
    for (const sel of CARD_SELECTORS) {
      const found = doc.querySelectorAll(sel);
      if (found.length > 0) { cards = [...found]; break; }
    }

    for (const card of cards) {
      // ── Order ID ──
      let orderId = card.getAttribute('data-order-id') || null;
      if (!orderId) {
        const link = card.querySelector('a[href*="orderID="]');
        if (link) {
          const m = (link.getAttribute('href') || '').match(/orderID=(\d{3}-\d{7}-\d{7})/i);
          if (m) orderId = m[1];
        }
      }
      if (!orderId) continue;

      const allEls = card.querySelectorAll('span, div, label');

      // ── Order date ──
      let orderDate = null;
      for (const el of allEls) {
        if (/^order\s+placed$/i.test(el.textContent.trim())) {
          const next = el.nextElementSibling;
          if (next) { orderDate = next.textContent.trim(); break; }
        }
      }
      if (!orderDate) {
        const header = card.querySelector('.order-info, .order-header, [class*="order-info"]');
        if (header) {
          const m = header.textContent.match(/([A-Z][a-z]+ \d{1,2}, \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/);
          if (m) orderDate = m[1];
        }
      }

      // ── Order total ──
      let total = null;
      for (const el of allEls) {
        if (!/^total$|^order\s+total[:\s]*$/i.test(el.textContent.trim())) continue;
        const col = el.closest('[class*="a-column"], td, [class*="col-"]') || el.parentElement;
        if (col) {
          const m = col.textContent.match(/\$([\d,]+\.\d{2})/);
          if (m) { total = parseFloat(m[1].replace(/,/g, '')); break; }
        }
        const row = el.closest('[class*="a-row"], tr') || el.parentElement?.parentElement;
        if (row) {
          const m = row.textContent.match(/\$([\d,]+\.\d{2})/);
          if (m) { total = parseFloat(m[1].replace(/,/g, '')); break; }
        }
      }
      if (!total) {
        const amounts = [...card.textContent.matchAll(/\$([\d,]+\.\d{2})/g)]
          .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(a => a > 0.5 && a < 10000);
        if (amounts.length === 1) total = amounts[0];
      }

      // ── Item names (best-effort from order card) ──
      // We also fetch the invoice page below for a complete list, but grab what
      // we can here so orders with no invoice response still have something.
      const items = [];
      const seen = new Set();
      for (const link of card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
        let name = link.textContent.trim();
        // Many item links wrap only a thumbnail <img> — fall back to alt text.
        if (!name || name.length < 5) {
          const img = link.querySelector('img');
          name = (img?.alt || img?.title || '').trim();
        }
        if (name.length >= 5 && name.length <= 200 && !seen.has(name)) {
          seen.add(name); items.push(name);
        }
      }

      orders.push({ orderId, orderDate, total, items });
    }
    return orders;
  }

  // Helper: fetch the print invoice for one order and return all item names found.
  // Invoice pages list every item regardless of how many shipments there were.
  async function fetchInvoiceItems(orderId) {
    try {
      const res = await fetch(
        `/gp/css/summary/print.html?ie=UTF8&orderID=${orderId}`,
        { credentials: 'include' }
      );
      if (!res.ok) return [];
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const items = [];
      const seen = new Set();
      for (const link of doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
        const name = link.textContent.trim();
        if (name.length >= 5 && name.length <= 200 && !seen.has(name)) {
          seen.add(name); items.push(name);
        }
      }
      // Fallback: table rows where last cell is a price — first cell is the item name.
      if (items.length === 0) {
        for (const row of doc.querySelectorAll('tr')) {
          const cells = [...row.querySelectorAll('td')];
          if (cells.length >= 2 && /^\$[\d,.]+$/.test(cells[cells.length - 1].textContent.trim())) {
            const name = cells[0].textContent.trim();
            if (name.length >= 5 && name.length <= 200 && !seen.has(name)) {
              seen.add(name); items.push(name);
            }
          }
        }
      }
      return items;
    } catch {
      return [];
    }
  }

  // ── Page 1: extract from current document ──
  const allOrders = extractOrdersFromDoc(document);
  const firstCardHtml = (() => {
    for (const sel of CARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el.outerHTML.slice(0, 4000);
    }
    return null;
  })();

  // ── Pages 2+: paginate with in-tab fetch ──
  const SIX_MONTHS_AGO = new Date();
  SIX_MONTHS_AGO.setMonth(SIX_MONTHS_AGO.getMonth() - 6);

  for (let page = 1; page < MAX_PAGES; page++) {
    const startIndex = page * 10;
    let html;
    try {
      const res = await fetch(
        `/gp/css/order-history?orderFilter=months-6&startIndex=${startIndex}`,
        { credentials: 'include' }
      );
      html = await res.text();
    } catch {
      break;
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const pageOrders = extractOrdersFromDoc(doc);
    if (pageOrders.length === 0) break;

    allOrders.push(...pageOrders);

    const lastDate = pageOrders[pageOrders.length - 1]?.orderDate;
    if (lastDate) {
      const d = new Date(lastDate);
      if (!isNaN(d) && d < SIX_MONTHS_AGO) break;
    }

    await new Promise(r => setTimeout(r, 250));
  }

  // ── Invoice fetch: get complete item lists for every order ──
  // Run in small parallel batches so we don't open too many concurrent requests.
  const BATCH = 5;
  for (let i = 0; i < allOrders.length; i += BATCH) {
    const batch = allOrders.slice(i, i + BATCH);
    await Promise.all(batch.map(async order => {
      const invoiceItems = await fetchInvoiceItems(order.orderId);
      if (invoiceItems.length > 0) {
        // Merge: union of card items and invoice items, invoice taking precedence.
        const merged = [...new Set([...invoiceItems, ...order.items])];
        order.items = merged;
      }
    }));
    if (i + BATCH < allOrders.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return {
    orders: allOrders,
    cardCount: allOrders.length,
    pageTitle: document.title,
    url: window.location.href,
    firstCardHtml,
  };
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function findMatches(charge, orders) {
  const chargeDate = new Date(charge.date);
  const results = [];

  for (const order of orders) {
    if (!order.date) continue;
    const orderDate = new Date(order.date);
    const daysDiff = Math.abs((chargeDate - orderDate) / 86400000);
    if (daysDiff > DATE_WINDOW_DAYS + 3) continue;

    const amountMatch = (order.chargeAmounts || []).some(
      amt => Math.abs(amt - charge.amount) < 0.02
    );
    const totalMatch = order.total && Math.abs(order.total - charge.amount) < 0.02;

    if (amountMatch || totalMatch) {
      results.push({ orderId: order.orderId, items: order.items, orderDate: order.date });
    }
  }

  return results;
}

function chargeKey(charge) {
  return `${charge.date}::${charge.amount.toFixed(2)}`;
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function getStatus() {
  const { orders = [], lastFetched } = await chrome.storage.local.get(['orders', 'lastFetched']);
  return {
    orderCount: orders.length,
    lastFetched: lastFetched ? new Date(lastFetched).toLocaleString() : 'Never',
  };
}

// ─── Debug ────────────────────────────────────────────────────────────────────

async function debugScrape() {
  try {
    // Use the same URL as production so we see the same data.
    const result = await loadTabAndExtract(
      `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=0&pageSize=50`,
      scrapeOrderHistoryPage
    );
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function tryParseDate(text) {
  if (!text) return null;
  const patterns = [
    /\b(\w+ \d{1,2},?\s+\d{4})\b/,
    /\b(\d{1,2} \w+ \d{4})\b/,
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

function dedup(arr, key) {
  const seen = new Set();
  return arr.filter(item => {
    if (seen.has(item[key])) return false;
    seen.add(item[key]);
    return true;
  });
}

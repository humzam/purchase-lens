// Service worker: fetches Amazon order data via a real (background) browser tab,
// then matches it to Bank of America charges.
// We use chrome.tabs + chrome.scripting instead of bare fetch() because Amazon's
// bot detection blocks service worker requests — a real tab with JS execution passes.

const ORDER_HISTORY_URL = 'https://www.amazon.com/gp/css/order-history';
const DATE_WINDOW_DAYS = 5;
const ORDER_LOOKBACK_MONTHS = 6;
const TAB_LOAD_TIMEOUT_MS = 30000;
const MAX_PAGES = 20;

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

// Opens ONE background tab, navigates it through each page of order history,
// and closes it when done. Each page is fully JS-rendered before we scrape.
async function fetchOrdersViaTab(minDate, maxDate) {
  const allRawOrders = [];
  const SIX_MONTHS_AGO = new Date();
  SIX_MONTHS_AGO.setMonth(SIX_MONTHS_AGO.getMonth() - 6);

  const firstUrl = `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=0`;
  let tabId;

  // Create the tab and wait for the first page to finish loading.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tab load timeout')), TAB_LOAD_TIMEOUT_MS);
    chrome.tabs.create({ url: firstUrl, active: false }, tab => {
      if (chrome.runtime.lastError) {
        clearTimeout(timer);
        return reject(new Error(chrome.runtime.lastError.message));
      }
      tabId = tab.id;
      function onUpdated(id, info) {
        if (id !== tabId || info.status !== 'complete') return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (page > 0) {
        const nextUrl = `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=${page * 10}`;
        await navigateTabAndWait(tabId, nextUrl);
      }

      // Let JS fully render before injecting.
      await new Promise(r => setTimeout(r, 2000));

      const result = await new Promise((resolve, reject) => {
        chrome.scripting.executeScript({ target: { tabId }, func: scrapePageWithInvoices }, res => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res?.length || res[0].error) return reject(new Error('Script execution failed'));
          resolve(res[0].result);
        });
      });

      if (!result?.orders?.length) {
        console.log('[ACI BG] Page', page + 1, ': 0 orders — done paginating');
        break;
      }

      console.log('[ACI BG] Page', page + 1, ':', result.orders.length, 'orders scraped');
      allRawOrders.push(...result.orders);

      const lastRaw = result.orders[result.orders.length - 1];
      if (lastRaw?.orderDate) {
        const d = new Date(lastRaw.orderDate);
        if (!isNaN(d.getTime()) && d < SIX_MONTHS_AGO) break;
      }
      if (result.orders.length < 10) break;
    }
  } finally {
    chrome.tabs.remove(tabId, () => {});
  }

  const results = [];
  for (const raw of allRawOrders) {
    const date = tryParseDate(raw.orderDate);
    if (date && date < minDate) continue;
    if (date && date > maxDate) continue;
    results.push({
      orderId: raw.orderId,
      date: date ? date.toISOString().split('T')[0] : null,
      items: raw.items,
      total: raw.total,
      chargeAmounts: raw.chargeAmounts?.length > 0
        ? raw.chargeAmounts
        : (raw.total ? [raw.total] : []),
    });
  }

  return results;
}

// Navigates a tab to `url` and resolves when it reaches status='complete'.
// Listener is registered BEFORE chrome.tabs.update to avoid the race where
// the navigation completes before we start listening.
function navigateTabAndWait(tabId, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Navigation timeout'));
    }, TAB_LOAD_TIMEOUT_MS);

    let seenLoading = false;
    function onUpdated(id, info) {
      if (id !== tabId) return;
      if (info.status === 'loading') seenLoading = true;
      if (seenLoading && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url });
  });
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
// It scrapes only the current page (pagination is handled by opening separate tabs).

async function scrapePageWithInvoices() {
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

  // Fetch the print invoice for one order.
  // Returns { items: string[], shipmentAmounts: number[] }.
  // shipmentAmounts contains one entry per shipment/charge so multi-shipment
  // orders can each be matched to their individual bank statement line.
  async function fetchInvoiceItems(orderId) {
    try {
      const res = await fetch(
        `/gp/css/summary/print.html?ie=UTF8&orderID=${orderId}`,
        { credentials: 'include' }
      );
      if (!res.ok) return { items: [], shipmentAmounts: [] };
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');

      // ── Item names ──────────────────────────────────────────────────────────
      const items = [];
      const seenItems = new Set();

      for (const link of doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
        const name = link.textContent.trim();
        if (name.length >= 5 && name.length <= 200 && !seenItems.has(name)) {
          seenItems.add(name); items.push(name);
        }
      }
      // Scan table rows for items that lack /dp/ links (e.g. some consumables).
      // Skip candidates whose first two words already match an existing item —
      // this prevents the same product appearing twice when Amazon uses slightly
      // different title text in the invoice table vs the product-page link.
      for (const row of doc.querySelectorAll('tr')) {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length >= 2 && /^\$[\d,.]+$/.test(cells[cells.length - 1].textContent.trim())) {
          const name = cells[0].textContent.trim().split('\n')[0].trim();
          if (
            name.length >= 5 &&
            name.length <= 200 &&
            !seenItems.has(name) &&
            !/^(shipping|handling|tax|subtotal|total|discount|promotion|import)/i.test(name)
          ) {
            const twoWordPrefix = name.split(/\s+/).slice(0, 2).join(' ').toLowerCase();
            const alreadyCovered = items.some(
              existing => existing.split(/\s+/).slice(0, 2).join(' ').toLowerCase() === twoWordPrefix
            );
            if (!alreadyCovered) { seenItems.add(name); items.push(name); }
          }
        }
      }

      // ── Per-shipment charge amounts ─────────────────────────────────────────
      // Multi-shipment orders: Amazon charges each shipment separately.
      // The invoice page has one "Order Total" row per shipment section.
      const shipmentAmounts = [];
      const seenAmts = new Set();
      function addAmt(n) {
        if (n > 0.5 && n < 10000 && !seenAmts.has(n)) {
          seenAmts.add(n); shipmentAmounts.push(n);
        }
      }

      // Strategy 1: "Order Total" rows — one per shipment section in multi-shipment invoices.
      for (const cell of doc.querySelectorAll('td, th')) {
        if (/^order\s+total[:\s]*$/i.test(cell.textContent.trim())) {
          const row = cell.closest('tr');
          if (row) {
            const m = row.textContent.match(/\$([\d,]+\.\d{2})/);
            if (m) addAmt(parseFloat(m[1].replace(/,/g, '')));
          }
        }
      }

      // Strategy 2: "Grand Total" rows (some invoice layouts use this label).
      if (shipmentAmounts.length === 0) {
        for (const cell of doc.querySelectorAll('td, th')) {
          if (/^grand\s+total[:\s]*$/i.test(cell.textContent.trim())) {
            const row = cell.closest('tr');
            if (row) {
              const m = row.textContent.match(/\$([\d,]+\.\d{2})/);
              if (m) addAmt(parseFloat(m[1].replace(/,/g, '')));
            }
          }
        }
      }

      // Strategy 3: Payment card lines e.g. "Visa ending in 1234: $XX.XX".
      // Each line represents one charge event (one shipment).
      if (shipmentAmounts.length === 0) {
        for (const el of doc.querySelectorAll('td, div, p, span')) {
          const text = el.textContent.trim();
          if (/visa|mastercard|amex|discover|credit card|debit card|bank card/i.test(text)) {
            const matches = [...text.matchAll(/\$([\d,]+\.\d{2})/g)];
            for (const m of matches) addAmt(parseFloat(m[1].replace(/,/g, '')));
          }
        }
      }

      // Strategy 4: Regex scan for any dollar amounts in "Total" labelled rows
      // as a last resort — covers unusual invoice formats.
      if (shipmentAmounts.length === 0) {
        for (const row of doc.querySelectorAll('tr')) {
          const text = row.textContent;
          if (/total/i.test(text) && !/subtotal|before tax|handling/i.test(text)) {
            const m = text.match(/\$([\d,]+\.\d{2})/);
            if (m) addAmt(parseFloat(m[1].replace(/,/g, '')));
          }
        }
      }

      return { items, shipmentAmounts };
    } catch {
      return { items: [], shipmentAmounts: [] };
    }
  }

  // ── Scrape current page ──
  const orders = extractOrdersFromDoc(document);
  const firstCardHtml = (() => {
    for (const sel of CARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el.outerHTML.slice(0, 4000);
    }
    return null;
  })();

  // ── Invoice fetch: complete item lists + per-shipment amounts ──
  const BATCH = 5;
  for (let i = 0; i < orders.length; i += BATCH) {
    const batch = orders.slice(i, i + BATCH);
    await Promise.all(batch.map(async order => {
      const { items: invoiceItems, shipmentAmounts } = await fetchInvoiceItems(order.orderId);
      if (invoiceItems.length > 0) {
        order.items = [...new Set([...invoiceItems, ...order.items])];
      }
      if (shipmentAmounts.length > 0) {
        order.chargeAmounts = shipmentAmounts;
      }
    }));
    if (i + BATCH < orders.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return {
    orders,
    cardCount: orders.length,
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
    // Reuse fetchOrdersViaTab's single-tab approach but return raw order data
    // (not date-filtered) so the debug page can show everything scraped.
    const allOrders = [];
    let firstCardHtml = null;
    let pageTitle = '';
    let finalUrl = '';
    const SIX_MONTHS_AGO = new Date();
    SIX_MONTHS_AGO.setMonth(SIX_MONTHS_AGO.getMonth() - 6);

    const firstUrl = `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=0`;
    let tabId;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tab load timeout')), TAB_LOAD_TIMEOUT_MS);
      chrome.tabs.create({ url: firstUrl, active: false }, tab => {
        if (chrome.runtime.lastError) { clearTimeout(timer); return reject(new Error(chrome.runtime.lastError.message)); }
        tabId = tab.id;
        function onUpdated(id, info) {
          if (id !== tabId || info.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timer);
          resolve();
        }
        chrome.tabs.onUpdated.addListener(onUpdated);
      });
    });

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (page > 0) {
          const nextUrl = `${ORDER_HISTORY_URL}?orderFilter=months-${ORDER_LOOKBACK_MONTHS}&startIndex=${page * 10}`;
          await navigateTabAndWait(tabId, nextUrl);
        }
        await new Promise(r => setTimeout(r, 2000));

        const result = await new Promise((resolve, reject) => {
          chrome.scripting.executeScript({ target: { tabId }, func: scrapePageWithInvoices }, res => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!res?.length || res[0].error) return reject(new Error('Script execution failed'));
            resolve(res[0].result);
          });
        });

        if (!result?.orders?.length) break;
        if (page === 0) { firstCardHtml = result.firstCardHtml; pageTitle = result.pageTitle; finalUrl = result.url; }
        allOrders.push(...result.orders);

        const lastRaw = result.orders[result.orders.length - 1];
        if (lastRaw?.orderDate) {
          const d = new Date(lastRaw.orderDate);
          if (!isNaN(d.getTime()) && d < SIX_MONTHS_AGO) break;
        }
        if (result.orders.length < 10) break;
      }
    } finally {
      chrome.tabs.remove(tabId, () => {});
    }

    return {
      success: true,
      result: { orders: allOrders, cardCount: allOrders.length, pageTitle, url: finalUrl, firstCardHtml },
    };
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

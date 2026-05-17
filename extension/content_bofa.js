// Content script for Bank of America — reads the transaction table, finds Amazon charges,
// and annotates each one with the item names fetched from Amazon in the background.

(function () {
  'use strict';

  // Avoid running more than once if the script is somehow injected twice.
  if (window.__aciInitialized) return;
  window.__aciInitialized = true;

  // BofA is a React SPA — the transaction table may not exist at document_idle.
  // We watch for DOM changes and re-run when new transaction rows appear.
  let debounceTimer = null;

  function scheduleRun() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(run, 800);
  }

  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.body, { childList: true, subtree: true });

  // Also run immediately in case the page was already loaded.
  scheduleRun();

  // ─── Main ─────────────────────────────────────────────────────────────────

  function run() {
    const charges = extractAmazonCharges();
    if (charges.length === 0) return;

    console.log(`[ACI] Found ${charges.length} Amazon charge(s) on this page.`);
    console.log('[ACI] Charges extracted:', charges.map(c => ({ amount: c.amount, date: c.date })));

    try {
      chrome.runtime.sendMessage({ type: 'MATCH_CHARGES', charges }, response => {
        if (chrome.runtime.lastError) {
          console.warn('[ACI] Background error:', chrome.runtime.lastError.message);
          return;
        }
        if (!response) return;

        console.log('[ACI] Background response:', response);

        if (response.error === 'NOT_LOGGED_IN') {
          showLoginHint();
          return;
        }

        annotate(charges, response.results || {});
      });
    } catch (e) {
      // Extension context was invalidated (e.g. after a reload) — ignore.
    }
  }

  // ─── Extract Amazon charges from BofA transaction table ───────────────────

  function extractAmazonCharges() {
    const charges = [];

    // BofA's transaction page has evolved over time. We try multiple selector
    // strategies so the extension keeps working after minor BofA UI updates.
    // If this stops working, open DevTools on the BofA transactions page,
    // inspect a transaction row, and update the selectors below.

    // Strategy 1: standard HTML table rows
    tryExtractFromTable(charges, 'table tbody tr', {
      merchant: 'td:first-child, td.merchant-name, td[data-label="Description"]',
      amount: 'td.amount, td[data-label="Amount"], td:nth-child(3)',
      date: 'td.date, td[data-label="Date"], td:nth-child(1)',
    });

    // Strategy 2: div/list-based layout (BofA's newer SPA layout)
    if (charges.length === 0) {
      tryExtractFromList(charges, [
        '[data-testid*="transaction"]',
        '.transaction-row',
        '.trans-list-item',
        '[class*="TransactionRow"]',
        '[class*="transaction-item"]',
      ]);
    }

    // Strategy 3: broad fallback — find any element whose text is "AMAZON" or "AMZN"
    // then walk up the DOM to find the enclosing row and extract amount + date.
    if (charges.length === 0) {
      tryExtractByMerchantText(charges);
    }

    // Deduplicate by element reference (multiple strategies may find the same row).
    const seen = new WeakSet();
    return charges.filter(c => {
      if (seen.has(c.element)) return false;
      seen.add(c.element);
      return true;
    });
  }

  function tryExtractFromTable(charges, rowSelector, { merchant, amount, date }) {
    const rows = document.querySelectorAll(rowSelector);
    for (const row of rows) {
      const merchantEl = row.querySelector(merchant);
      if (!merchantEl || !/AMZN|AMAZON/i.test(merchantEl.textContent)) continue;

      const amountEl = row.querySelector(amount);
      const dateEl = row.querySelector(date);

      const parsed = parseCharge(amountEl, dateEl, row);
      if (parsed) charges.push(parsed);
    }
  }

  function tryExtractFromList(charges, selectors) {
    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length === 0) continue;

      for (const item of items) {
        if (!/AMZN|AMAZON/i.test(item.textContent)) continue;
        const parsed = parseCharge(null, null, item);
        if (parsed) charges.push(parsed);
      }
      if (charges.length > 0) break;
    }
  }

  function tryExtractByMerchantText(charges) {
    // Walk every text node looking for AMAZON/AMZN. This is the most fragile
    // strategy but serves as a catch-all for unknown DOM layouts.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    const processedRows = new WeakSet();

    while ((node = walker.nextNode())) {
      if (!/AMZN|AMAZON/i.test(node.textContent)) continue;
      const row = findRowAncestor(node.parentElement);
      if (!row || processedRows.has(row)) continue;
      processedRows.add(row);

      const parsed = parseCharge(null, null, row);
      if (parsed) charges.push(parsed);
    }
  }

  // ─── Parsing helpers ──────────────────────────────────────────────────────

  function parseCharge(amountEl, dateEl, container) {
    const amount = extractAmount(amountEl || container);
    const date = extractDate(dateEl || container);

    if (amount === null || amount <= 0) return null;

    return { amount, date, element: container, annotated: false };
  }

  function extractAmount(el) {
    if (!el) return null;
    // Grab all text in the element and look for a dollar amount.
    const text = el.textContent;
    // BofA shows debits as positive numbers; some views show them with a minus sign.
    const m = text.match(/\$?([\d,]+\.\d{2})/g);
    if (!m) return null;

    // If there are multiple amounts (e.g. "available balance: $X"), take the smallest
    // that's plausibly a charge (> $0.00 and < $10,000).
    const amounts = m
      .map(s => parseFloat(s.replace(/[$,]/g, '')))
      .filter(n => n > 0 && n < 10000);

    return amounts.length > 0 ? Math.min(...amounts) : null;
  }

  function extractDate(el) {
    if (!el) return todayString();
    const text = el.textContent.trim();
    // BofA formats: "03/15/2024", "Mar 15, 2024", "03/15"
    const patterns = [
      { re: /(\d{1,2})\/(\d{1,2})\/(\d{4})/, fn: m => `${m[3]}-${pad(m[1])}-${pad(m[2])}` },
      { re: /(\d{4})-(\d{2})-(\d{2})/, fn: m => m[0] },
      { re: /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/, fn: m => {
          const d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
          return isNaN(d) ? null : d.toISOString().split('T')[0];
        }
      },
      // "03/15" with no year — assume current year
      { re: /^(\d{1,2})\/(\d{1,2})$/, fn: m => `${new Date().getFullYear()}-${pad(m[1])}-${pad(m[2])}` },
    ];

    for (const { re, fn } of patterns) {
      const match = text.match(re);
      if (match) {
        const result = fn(match);
        if (result) return result;
      }
    }
    return todayString();
  }

  function pad(s) { return String(s).padStart(2, '0'); }
  function todayString() { return new Date().toISOString().split('T')[0]; }

  function findRowAncestor(el) {
    // Walk up at most 8 levels looking for something that looks like a row container.
    let node = el;
    for (let i = 0; i < 8; i++) {
      if (!node || node === document.body) break;
      const tag = node.tagName?.toLowerCase();
      const cls = node.className?.toLowerCase() || '';
      if (
        tag === 'tr' ||
        tag === 'li' ||
        cls.includes('row') ||
        cls.includes('transaction') ||
        cls.includes('item')
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return el?.parentElement || el;
  }

  // ─── Annotate BofA rows ───────────────────────────────────────────────────

  function annotate(charges, results) {
    let annotatedCount = 0;

    for (const charge of charges) {
      if (charge.annotated) continue;

      const key = `${charge.date}::${charge.amount.toFixed(2)}`;
      const matches = results[key];
      if (!matches || matches.length === 0) continue;

      const label = buildLabel(matches);
      injectLabel(charge.element, label);
      charge.annotated = true;
      annotatedCount++;
    }

    console.log(`[ACI] Annotated ${annotatedCount} charge(s).`);
  }

  function buildLabel(matches) {
    const allItems = [...new Set(matches.flatMap(m => m.items))];
    const displayText = allItems.length > 0
      ? allItems.join(' · ')
      : `Order ${matches[0].orderId}`;
    const tooltip = allItems.join('\n') + `\n\nOrder(s): ${matches.map(m => m.orderId).join(', ')}`;

    const div = document.createElement('div');
    div.className = 'aci-label';
    div.title = tooltip;
    div.style.cssText = `
      display: block;
      margin-top: 4px;
      padding: 3px 8px;
      background: #fffbeb;
      border-left: 3px solid #f59e0b;
      border-radius: 0 3px 3px 0;
      font-size: 12px;
      font-family: inherit;
      color: #78350f;
      cursor: default;
      max-width: 480px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-sizing: border-box;
    `;
    div.textContent = `📦 ${displayText}`;
    return div;
  }

  function injectLabel(rowEl, label) {
    if (rowEl.querySelector('.aci-label')) return;

    // Find the description/merchant cell — that's the natural home for the label.
    // BofA checking account rows have a specific structure; we walk children to find
    // the cell containing "AMAZON" text, then append below it.
    const cells = rowEl.querySelectorAll('td, [class*="description"], [class*="merchant"]');
    for (const cell of cells) {
      if (/AMZN|AMAZON/i.test(cell.textContent)) {
        cell.appendChild(label);
        return;
      }
    }
    // Fallback: append directly to the row container.
    rowEl.appendChild(label);
  }

  // ─── Login hint ───────────────────────────────────────────────────────────

  function showLoginHint() {
    if (document.getElementById('aci-login-hint')) return;

    const hint = document.createElement('div');
    hint.id = 'aci-login-hint';
    hint.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 6px;
      padding: 12px 16px;
      font-size: 13px;
      color: #333;
      z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      max-width: 280px;
    `;
    hint.innerHTML = `
      <strong>Amazon Charge Identifier</strong><br>
      Sign into Amazon in this browser to enable charge identification.
      <button style="display:block;margin-top:8px;font-size:12px;cursor:pointer;"
              onclick="this.parentElement.remove()">Dismiss</button>
    `;
    document.body.appendChild(hint);
    setTimeout(() => hint.remove(), 10000);
  }
})();

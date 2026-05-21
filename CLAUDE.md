# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Loading the Extension

There is no build step. Load the repo root directly via `chrome://extensions` → Developer mode → Load unpacked. After any change to `background.js` or `manifest.json`, click the reload icon on the extensions page. Content script changes take effect on the next page load without a full reload.

To force a fresh data scrape during testing: click the extension icon → **Clear Cache & Re-sync**, or open DevTools → Application → Storage → `chrome.storage.local` → Clear All.

## Architecture

This is a Chrome MV3 extension with no external servers. All scraped data lives in `chrome.storage.local`.

**Data flow:**

1. User opens any `bankofamerica.com` URL → `chrome.tabs.onUpdated` fires → `prefetchOrders()` kicks off a background Amazon scrape if cache is stale (TTL: 1 hour).
2. Scrape opens one background tab (`active: false`), paginates through Amazon order history via `chrome.tabs.update` + `navigateTabAndWait`, and runs `scrapePageWithInvoices` inside the tab via `chrome.scripting.executeScript`.
3. `scrapePageWithInvoices` is serialized and injected into the Amazon tab — it must be **fully self-contained** (no closures over service-worker variables). It scrapes order cards and fetches per-order invoice pages (`/gp/css/summary/print.html?orderID=XXX`) to get post-tax shipment amounts and complete item names.
4. Scraped orders are stored in `chrome.storage.local` under `orders` and `fetchedOrderIds`.
5. `notifyBofaTabs()` sends `ORDERS_UPDATED` to all open BofA tabs, triggering re-annotation.
6. `content_bofa.js` uses a MutationObserver (800ms debounce) to handle BofA's React SPA. When a `MATCH_CHARGES` response arrives (or `ORDERS_UPDATED` fires), it injects `.aci-label` elements into the transaction rows.

**Concurrency:** `scrapeInProgress` + `scrapePromise` act as a mutex. Callers that arrive while a scrape is running await `scrapePromise` rather than starting a second scrape. `MATCH_CHARGES` returns cached results immediately (non-blocking) and re-annotates when the scrape completes.

## Key Constraints

**Amount matching is strict (`< $0.02`).** Do not loosen this to a percentage tolerance — it causes false-positive annotations. The correct fix for any tax/rounding mismatch is in the invoice parser: `fetchInvoiceItems` must take the **last** dollar amount in "Order Total" rows (post-tax total), not the first (pre-tax subtotal). See Strategy 1 in `fetchInvoiceItems`.

**Date window is 21 days.** Amazon stores order placement date; the card charge posts on the shipment date, which can be 14+ days later for slow/pre-order items.

**`scrapePageWithInvoices` must remain self-contained.** It runs via `executeScript` inside a remote tab. Any helper function it needs (`sigWords`, `isCoveredBy`, `extractOrdersFromDoc`, `fetchInvoiceItems`) must be defined inside it.

**Amazon bot detection.** We use a real browser tab (`chrome.tabs.create`) rather than `fetch()` from the service worker. The service worker cannot directly fetch Amazon pages.

## Debugging

- Service worker logs: `chrome://extensions` → "Inspect views: service worker"
- BofA content script logs: DevTools console on the BofA tab (filter for `[ACI]`)
- Debug page: click "Open scrape debugger" in the popup — shows raw scraped orders, amounts, and the first card's HTML for selector diagnosis
- If selectors break after a BofA UI update, inspect a transaction row in DevTools and update the selector strategies in `content_bofa.js:extractAmazonCharges`

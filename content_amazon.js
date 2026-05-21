// Content script for Amazon pages.
// When the user is already browsing Amazon, we opportunistically tell the background
// to refresh recent order data — so BofA annotations are fresher next time.

(function () {
  'use strict';

  // Only trigger on pages that indicate the user is logged in and viewing orders.
  // Avoid firing on every Amazon page load (product pages, search, etc.).
  const url = window.location.href;
  const isOrdersPage =
    url.includes('/gp/css/order-history') ||
    url.includes('/your-account/order-details') ||
    url.includes('/gp/your-account');

  if (!isOrdersPage) return;

  // Brief delay so the page settles before we signal the background.
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'REFRESH_ORDERS' });
    console.log('[ACI] On Amazon orders page — triggered background refresh.');
  }, 1500);
})();

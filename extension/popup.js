chrome.runtime.sendMessage({ type: 'GET_STATUS' }, response => {
  if (!response) return;
  document.getElementById('order-count').textContent = response.orderCount ?? '—';
  document.getElementById('last-fetched').textContent = response.lastFetched ?? 'Never';
});

document.getElementById('debug-link').addEventListener('click', e => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
});

document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.storage.local.clear(() => {
    document.getElementById('status-msg').textContent = 'Cache cleared. Re-open BofA to re-sync.';
    document.getElementById('order-count').textContent = '0';
    document.getElementById('last-fetched').textContent = 'Never';
  });
});

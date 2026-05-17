async function runDebug() {
  document.getElementById('status').textContent = 'Fetching from Amazon…';
  document.getElementById('output').innerHTML = '';

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'DEBUG_SCRAPE' }, res => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(res);
      });
    });
  } catch (e) {
    document.getElementById('status').textContent = 'Error: ' + e.message;
    return;
  }

  document.getElementById('status').textContent = 'Done — ' + new Date().toLocaleTimeString();

  const out = document.getElementById('output');

  if (!response) {
    out.innerHTML = '<div style="color:#f44747">No response from background.</div>';
    return;
  }

  if (!response.success) {
    out.innerHTML = `<div style="color:#f44747">Error: ${esc(response.error)}</div>`;
    return;
  }

  const r = response.result;
  const block = document.createElement('div');
  block.className = 'url-block';
  const totalsOk = r.orders.slice(0, 5).every(o => o.total !== null);
  block.innerHTML = `
    <div class="url-label">Tab scrape result</div>
    <div class="field"><span class="key">Page title:</span> <span class="val">${esc(r.pageTitle)}</span></div>
    <div class="field"><span class="key">Final URL:</span> <span class="val">${esc(r.url)}</span></div>
    <div class="field"><span class="key">Order cards found on page:</span> <span class="val ${r.cardCount > 0 ? 'good' : 'bad'}">${r.cardCount}</span></div>
    <div class="field"><span class="key">Orders extracted:</span> <span class="val ${r.orders.length > 0 ? 'good' : 'bad'}">${r.orders.length}</span></div>
    <div class="field"><span class="key">Totals extracted:</span> <span class="val ${totalsOk ? 'good' : 'bad'}">${r.orders.filter(o => o.total !== null).length} / ${r.orders.length} non-null</span></div>
    <div class="field" style="margin-top:10px"><span class="key">All orders (date | total | id | items):</span></div>
    <div class="snippet">${r.orders.map(o =>
      `${o.orderDate || '?'}  $${o.total ?? 'NULL'}  ${o.orderId}\n  ${(o.items || []).slice(0, 2).join(', ') || '(no items)'}`
    ).join('\n\n')}</div>
    <div class="field" style="margin-top:10px"><span class="key">First card HTML (for selector debugging):</span></div>
    <div class="snippet">${esc(r.firstCardHtml || '(none)')}</div>
  `;
  out.appendChild(block);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('rerun').addEventListener('click', runDebug);
runDebug();

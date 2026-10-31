(() => {
  'use strict';
  const STORE_KEY = 'stockroom.inventory.v1';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
  let state = { products: [], movements: [] };
  let toastTimer;

  function makeId() {
    return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  function normalizeState(value) {
    if (!value || !Array.isArray(value.products) || !Array.isArray(value.movements)) throw new Error('Backup data is incomplete.');
    const products = value.products.map((p, index) => {
      if (!p || typeof p.name !== 'string' || !p.name.trim()) throw new Error(`Product ${index + 1} has no name.`);
      const cost = Number(p.cost), quantity = Number(p.quantity), reorderLevel = Number(p.reorderLevel);
      if (![cost, quantity, reorderLevel].every(Number.isFinite) || cost < 0 || quantity < 0 || reorderLevel < 0) throw new Error(`Product “${p.name}” has invalid numbers.`);
      return { id: String(p.id || makeId()), name: p.name.trim(), sku: String(p.sku || '').trim(), category: String(p.category || '').trim(), cost, quantity, reorderLevel };
    });
    const ids = new Set();
    for (const p of products) {
      if (ids.has(p.id)) throw new Error(`Duplicate product ID found for “${p.name}”.`);
      ids.add(p.id);
    }
    const movements = value.movements.map((m, index) => {
      if (!m || !['in', 'out'].includes(m.type) || !Number.isFinite(Number(m.quantity)) || Number(m.quantity) <= 0 || !m.date || !Number.isFinite(new Date(m.date).getTime())) throw new Error(`Stock movement ${index + 1} is invalid.`);
      return { id: String(m.id || makeId()), productId: String(m.productId || ''), productName: String(m.productName || ''), type: m.type, quantity: Number(m.quantity), reason: String(m.reason || ''), date: new Date(m.date).toISOString() };
    });
    return { products, movements: movements.slice(0, 500) };
  }
  async function save(nextState) {
    try {
      const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextState) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Server returned ${response.status}.`);
      return true;
    } catch (error) {
      showToast(`Could not save: ${error.message || 'server unavailable'}`);
      return false;
    }
  }
  async function commit(change) {
    const previous = state;
    const nextState = JSON.parse(JSON.stringify(state));
    try { change(nextState); }
    catch (error) { showToast(error.message || 'Change could not be applied.'); return false; }
    if (!await save(nextState)) return false;
    state = nextState;
    render(); return true;
  }
  async function loadInventory() {
    try {
      const response = await fetch('/api/state');
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Server returned ${response.status}.`);
      let loaded = normalizeState(result);
      if (!loaded.products.length && !loaded.movements.length) {
        try {
          const legacy = JSON.parse(localStorage.getItem(STORE_KEY));
          if (legacy && (legacy.products?.length || legacy.movements?.length)) {
            const migrated = normalizeState(legacy);
            if (await save(migrated)) { loaded = migrated; localStorage.removeItem(STORE_KEY); }
          }
        } catch (_) { /* A missing or old local copy does not prevent using SQLite. */ }
      }
      state = loaded; render();
    } catch (error) {
      showToast(`Start Stockroom with start.bat first. ${error.message || ''}`);
    }
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function money(value) { return `₹${fmt.format(Number(value) || 0)}`; }
  function initials(name) { return (name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join('') || 'P').toUpperCase(); }
  function productStatus(p) { return p.quantity <= 0 ? 'out' : p.quantity <= p.reorderLevel ? 'low' : 'healthy'; }
  function statusLabel(status) { return status === 'out' ? 'Out of stock' : status === 'low' ? 'Low stock' : 'In stock'; }
  function relativeTime(date) {
    const diff = Math.max(0, Date.now() - new Date(date).getTime());
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' }).format(new Date(date));
  }
  function render() {
    renderStats(); renderCategories(); renderProducts(); renderActivity();
  }
  function renderStats() {
    $('#stat-products').textContent = fmt.format(state.products.length);
    $('#stat-units').textContent = fmt.format(state.products.reduce((sum, p) => sum + p.quantity, 0));
    $('#stat-value').textContent = money(state.products.reduce((sum, p) => sum + p.quantity * p.cost, 0));
    $('#stat-low').textContent = fmt.format(state.products.filter(p => productStatus(p) !== 'healthy').length);
  }
  function renderCategories() {
    const select = $('#category-filter');
    const current = select.value;
    const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    select.innerHTML = '<option value="all">All categories</option>' + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (categories.includes(current)) select.value = current;
  }
  function renderProducts() {
    const query = $('#search-input').value.trim().toLowerCase();
    const category = $('#category-filter').value;
    const filter = $('#stock-filter').value;
    const products = [...state.products].filter(p => {
      const matchesText = !query || `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(query);
      const status = productStatus(p);
      return matchesText && (category === 'all' || p.category === category) && (filter === 'all' || (filter === 'low' ? status !== 'healthy' : filter === status));
    }).sort((a,b) => a.name.localeCompare(b.name));
    $('#product-rows').innerHTML = products.map(p => {
      const status = productStatus(p);
      return `<tr><td><div class="product-name"><div class="product-thumb">${escapeHtml(initials(p.name))}</div><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.sku || 'No SKU')}</small></div></div></td><td>${escapeHtml(p.category || 'Uncategorized')}</td><td class="price">${money(p.cost)}</td><td class="qty">${fmt.format(p.quantity)}</td><td><span class="status ${status}">${statusLabel(status)}</span></td><td class="row-actions"><button class="action-button" aria-label="Actions for ${escapeHtml(p.name)}" data-action-menu="${p.id}">···</button></td></tr>`;
    }).join('');
    const empty = products.length === 0;
    $('#empty-state').classList.toggle('show', empty);
    $('#product-rows').closest('table').style.display = empty ? 'none' : '';
    $('#row-count').textContent = `Showing ${products.length} of ${state.products.length} product${state.products.length === 1 ? '' : 's'}`;
  }
  function activityMarkup(m) {
    const p = state.products.find(item => item.id === m.productId);
    const name = m.productName || (p && p.name) || 'Deleted product';
    const type = m.type === 'in' ? 'in' : 'out';
    return `<div class="activity-item"><div class="activity-symbol ${type}">${type === 'in' ? '＋' : '−'}</div><div class="activity-text"><strong>${escapeHtml(name)}</strong> ${type === 'in' ? 'stock received' : 'stock removed'}<small>${escapeHtml(m.reason || (type === 'in' ? 'Stock in' : 'Stock out'))} · ${relativeTime(m.date)}</small></div><div class="activity-amount ${type === 'out' ? 'out' : ''}">${type === 'in' ? '+' : '−'}${fmt.format(m.quantity)}</div></div>`;
  }
  function renderActivity() {
    const list = [...state.movements].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    $('#activity-list').innerHTML = list.length ? list.map(activityMarkup).join('') : '<div class="activity-empty">No stock movements yet.<br>Record stock in or out to see activity.</div>';
  }
  function renderHistory() {
    const list = [...state.movements].sort((a,b) => new Date(b.date) - new Date(a.date));
    $('#history-list').innerHTML = list.length ? list.map(activityMarkup).join('') : '<div class="activity-empty">No stock movements recorded yet.</div>';
  }
  function showToast(message) {
    const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2300);
  }
  function downloadFile(contents, name, type) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function openProduct(product) {
    const form = $('#product-form'); form.reset();
    $('#product-id').value = product?.id || '';
    $('#product-dialog-title').textContent = product ? 'Edit product' : 'Add a product';
    $('#product-name').value = product?.name || '';
    $('#product-sku').value = product?.sku || '';
    $('#product-category').value = product?.category || '';
    $('#product-cost').value = product?.cost ?? 0;
    $('#product-quantity').value = product?.quantity ?? 0;
    $('#product-reorder').value = product?.reorderLevel ?? 5;
    $('#product-dialog').showModal();
    $('#product-name').focus();
  }
  function openMovement(product) {
    $('#movement-form').reset(); $('#movement-id').value = product.id;
    $('#movement-product').innerHTML = `<strong>${escapeHtml(product.name)}</strong><small>Current quantity: ${fmt.format(product.quantity)} · Reorder at: ${fmt.format(product.reorderLevel)}</small>`;
    $('#movement-quantity').max = product.quantity || '';
    $('#movement-dialog').showModal(); $('#movement-quantity').focus();
  }
  function recordMovement(product, type, quantity, reason) {
    if (type === 'out' && quantity > product.quantity) return false;
    return commit(draft => {
      const target = draft.products.find(item => item.id === product.id);
      if (!target || (type === 'out' && quantity > target.quantity)) throw new Error('Stock changed. Please try again.');
      target.quantity += type === 'in' ? quantity : -quantity;
      draft.movements.unshift({ id: makeId(), productId: target.id, productName: target.name, type, quantity, reason: reason.trim(), date: new Date().toISOString() });
      draft.movements = draft.movements.slice(0, 500);
    });
  }

  $('#today').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date());
  $('#add-product-btn').addEventListener('click', () => openProduct());
  $('#empty-add-btn').addEventListener('click', () => openProduct());
  $('#search-input').addEventListener('input', renderProducts);
  $('#category-filter').addEventListener('change', renderProducts);
  $('#stock-filter').addEventListener('change', renderProducts);
  $('#export-btn').addEventListener('click', () => {
    const rows = [['Name','SKU','Category','Unit cost','Quantity','Reorder level'], ...state.products.map(p => [p.name,p.sku,p.category,p.cost,p.quantity,p.reorderLevel])];
    const csv = rows.map(row => row.map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')).join('\r\n');
    downloadFile(csv, 'stockroom-inventory.csv', 'text/csv;charset=utf-8'); showToast('Inventory exported as CSV');
  });
  $('#backup-btn').addEventListener('click', () => {
    const backup = { format: 'stockroom-backup', version: 1, exportedAt: new Date().toISOString(), ...state };
    downloadFile(JSON.stringify(backup, null, 2), 'stockroom-backup.json', 'application/json');
    showToast('Inventory backup downloaded');
  });
  $('#restore-btn').addEventListener('click', () => $('#restore-file').click());
  $('#restore-file').addEventListener('change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Backup must be smaller than 5 MB.');
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'stockroom-backup' || parsed.version !== 1) throw new Error('This is not a supported Stockroom backup.');
      const restored = normalizeState(parsed);
      const seenSkus = new Set();
      for (const p of restored.products) {
        const key = p.sku.toLowerCase();
        if (key && seenSkus.has(key)) throw new Error(`Duplicate SKU found: ${p.sku}.`);
        if (key) seenSkus.add(key);
      }
      if (!confirm(`Restore ${restored.products.length} products and ${restored.movements.length} stock movements? This replaces the current inventory.`)) return;
      if (!await save(restored)) return;
      state = restored; render(); showToast('Inventory restored');
    } catch (error) { showToast(error.message || 'Could not read this backup.'); }
  });
  $('#product-rows').addEventListener('click', event => {
    const button = event.target.closest('[data-action-menu]'); if (!button) return;
    $$('.action-menu').forEach(menu => menu.remove());
    const product = state.products.find(p => p.id === button.dataset.actionMenu); if (!product) return;
    const menu = document.createElement('div'); menu.className = 'action-menu';
    menu.innerHTML = '<button data-action="movement">Adjust stock</button><button data-action="edit">Edit product</button><button data-action="delete">Delete product</button>';
    button.parentElement.append(menu);
    menu.addEventListener('click', async e => {
      const action = e.target.dataset.action; if (!action) return;
      menu.remove();
      if (action === 'movement') openMovement(product);
      if (action === 'edit') openProduct(product);
      if (action === 'delete') {
        if (!confirm(`Delete “${product.name}”? Its movement history will be kept.`)) return;
        if (await commit(draft => { draft.products = draft.products.filter(p => p.id !== product.id); })) showToast('Product deleted');
      }
    });
  });
  document.addEventListener('click', event => { if (!event.target.closest('.row-actions')) $$('.action-menu').forEach(menu => menu.remove()); });
  $('#product-form').addEventListener('submit', async event => {
    event.preventDefault();
    const id = $('#product-id').value;
    const name = $('#product-name').value.trim();
    const sku = $('#product-sku').value.trim();
    if (sku && state.products.some(p => p.sku.toLowerCase() === sku.toLowerCase() && p.id !== id)) { $('#product-sku').setCustomValidity('This SKU is already in use.'); $('#product-sku').reportValidity(); $('#product-sku').setCustomValidity(''); return; }
    const existing = state.products.find(p => p.id === id);
    const product = { id: id || makeId(), name, sku, category: $('#product-category').value.trim(), cost: Number($('#product-cost').value), quantity: Number($('#product-quantity').value), reorderLevel: Number($('#product-reorder').value) };
    const saved = await commit(draft => {
      const target = draft.products.find(p => p.id === id);
      if (target && product.quantity !== target.quantity) {
        const delta = product.quantity - target.quantity;
        draft.movements.unshift({ id: makeId(), productId: target.id, productName: product.name, type: delta > 0 ? 'in' : 'out', quantity: Math.abs(delta), reason: 'Quantity updated while editing', date: new Date().toISOString() });
      }
      if (target) Object.assign(target, product);
      else {
        draft.products.push(product);
        if (product.quantity > 0) draft.movements.unshift({ id: makeId(), productId: product.id, productName: product.name, type: 'in', quantity: product.quantity, reason: 'Opening balance', date: new Date().toISOString() });
      }
      draft.movements = draft.movements.slice(0, 500);
    });
    if (!saved) return;
    $('#product-dialog').close(); showToast(existing ? 'Product updated' : 'Product added');
  });
  $('#movement-form').addEventListener('submit', async event => {
    event.preventDefault();
    const product = state.products.find(p => p.id === $('#movement-id').value);
    if (!product) return;
    const type = $('input[name="movement-type"]:checked').value;
    const quantity = Number($('#movement-quantity').value);
    if (type === 'out' && quantity > product.quantity) { $('#movement-quantity').setCustomValidity(`Only ${product.quantity} units are available.`); $('#movement-quantity').reportValidity(); $('#movement-quantity').setCustomValidity(''); return; }
    if (!await recordMovement(product, type, quantity, $('#movement-reason').value)) return;
    $('#movement-dialog').close(); showToast(type === 'in' ? 'Stock received' : 'Stock removed');
  });
  $('#view-activity-btn').addEventListener('click', () => { renderHistory(); $('#history-dialog').showModal(); });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }));
  render();
  loadInventory();
})();

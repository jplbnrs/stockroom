/* Stockroom dashboard — no framework, one file. */

const state = {
  token: localStorage.getItem('stockroom-token'),
  email: localStorage.getItem('stockroom-email'),
  warehouses: [],
  activeWh: null,
  stock: [],
  movements: [],
}

const app = document.getElementById('app')

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  if (opts.body) headers['Content-Type'] = 'application/json'
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`
  const res = await fetch(`/api${path}`, { ...opts, headers })
  if (res.status === 401 && state.token) {
    signOut()
    throw new Error('session expired — sign in again')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.detail || `request failed (${res.status})`)
  return data
}

function signOut() {
  state.token = null
  state.email = null
  localStorage.removeItem('stockroom-token')
  localStorage.removeItem('stockroom-email')
  renderLogin()
}

/* ── login ──────────────────────────────────────────────── */

function renderLogin(err) {
  app.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <h1>STOCKROOM</h1>
        <p>warehouse ops console — authorized floor staff only</p>
        <div class="field">
          <label for="email">Operator email</label>
          <input id="email" type="email" autocomplete="email" required />
        </div>
        <div class="field">
          <label for="password">Passcode</label>
          <input id="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="primary" type="submit">Sign in</button>
        ${err ? `<p class="msg err">${esc(err)}</p>` : ''}
      </form>
    </div>`
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const btn = e.target.querySelector('button')
    btn.disabled = true
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: document.getElementById('password').value,
        }),
      })
      state.token = data.token
      state.email = data.email
      localStorage.setItem('stockroom-token', data.token)
      localStorage.setItem('stockroom-email', data.email)
      await loadAll()
    } catch (ex) {
      renderLogin(ex.message)
    }
  })
}

/* ── dashboard ──────────────────────────────────────────── */

async function loadAll() {
  app.innerHTML = '<p class="muted">loading…</p>'
  try {
    state.warehouses = await api('/warehouses')
    if (!state.activeWh && state.warehouses.length)
      state.activeWh = state.warehouses[0].id
    ;[state.stock, state.movements] = await Promise.all([
      state.activeWh ? api(`/warehouses/${state.activeWh}/stock`) : [],
      api('/movements?limit=40'),
    ])
    renderDashboard()
  } catch (ex) {
    if (state.token) {
      app.innerHTML = `<p class="msg err">${esc(ex.message)}</p>`
    }
  }
}

function fmtTime(iso) {
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })} ${d
    .toTimeString()
    .slice(0, 5)}`
}

function renderDashboard() {
  const wh = state.warehouses.find((w) => w.id === state.activeWh)
  const lowCount = state.stock.filter((s) => s.low).length

  app.innerHTML = `
    <div class="topbar">
      <span class="logo">STOCKROOM</span>
      <span class="sub">warehouse ops console</span>
      <span class="spacer"></span>
      <span class="who"><span class="led"></span>${esc(state.email)}</span>
      <button id="signout">Sign out</button>
    </div>

    <div class="tabs">
      ${state.warehouses
        .map(
          (w) => `
        <div class="tab ${w.id === state.activeWh ? 'on' : ''}" data-wh="${w.id}">
          <span class="code">${esc(w.code)}</span>
          <span class="meta">${esc(w.name)} · ${esc(w.region)}</span>
          <span class="meta">${w.skus_stocked} skus ·
            <span class="${w.low_stock > 0 ? 'warn' : ''}">${w.low_stock} low</span>
          </span>
        </div>`,
        )
        .join('')}
    </div>

    <div class="cols">
      <div class="panel">
        <div class="panel-head">
          <span>Stock — ${esc(wh ? wh.code : '—')}</span>
          <span class="count">${state.stock.length} lines</span>
          ${lowCount ? `<span class="count" style="color:var(--red)">${lowCount} below reorder</span>` : ''}
        </div>
        <table>
          <thead>
            <tr>
              <th>SKU</th><th>Item</th><th>Category</th>
              <th class="num">On hand</th><th class="num">Reorder at</th>
            </tr>
          </thead>
          <tbody>
            ${state.stock
              .map(
                (s) => `
              <tr class="${s.low ? 'low' : ''}">
                <td>${esc(s.sku_code)}</td>
                <td>${esc(s.name)}</td>
                <td>${esc(s.category)}</td>
                <td class="num">${s.quantity_on_hand}</td>
                <td class="num">${s.reorder_point}</td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>

      <div>
        <div class="panel" style="margin-bottom:18px">
          <div class="panel-head"><span>Record movement</span></div>
          <form class="form-body" id="movement-form">
            <div class="field">
              <label for="mv-sku">SKU</label>
              <select id="mv-sku" required>
                ${state.stock
                  .map(
                    (s) =>
                      `<option value="${s.sku_id}">${esc(s.sku_code)} — ${esc(s.name)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label for="mv-type">Type</label>
              <select id="mv-type">
                <option value="receipt">receipt (+)</option>
                <option value="shipment">shipment (−)</option>
                <option value="adjustment">adjustment (±)</option>
              </select>
            </div>
            <div class="field">
              <label for="mv-qty">Quantity</label>
              <input id="mv-qty" type="number" value="1" required />
            </div>
            <div class="field">
              <label for="mv-ref">Reference (optional)</label>
              <input id="mv-ref" type="text" placeholder="REF-…" />
            </div>
            <button class="primary" type="submit">Log it</button>
            <span id="mv-msg" class="msg"></span>
          </form>
        </div>

        <div class="panel">
          <div class="panel-head"><span>Recent movements</span></div>
          <ul class="feed">
            ${state.movements
              .map(
                (m) => `
              <li>
                <span class="t">${fmtTime(m.occurred_at)}</span>
                <span class="pill ${esc(m.movement_type)}">${esc(m.movement_type)}</span>
                <span>${esc(m.warehouse_code)} · ${esc(m.sku_code)}</span>
                <span class="spacer"></span>
                <span class="${m.quantity >= 0 ? 'qty-pos' : 'qty-neg'}">
                  ${m.quantity >= 0 ? '+' : ''}${m.quantity}
                </span>
              </li>`,
              )
              .join('')}
          </ul>
        </div>
      </div>
    </div>

    <footer>
      <span>stockroom v1 — movement ledger is append-only</span>
      <span>${state.warehouses.length} sites tracked</span>
    </footer>`

  document.getElementById('signout').addEventListener('click', signOut)
  document.querySelectorAll('.tab').forEach((el) =>
    el.addEventListener('click', async () => {
      state.activeWh = Number(el.dataset.wh)
      await loadAll()
    }),
  )
  document
    .getElementById('movement-form')
    .addEventListener('submit', async (e) => {
      e.preventDefault()
      const msg = document.getElementById('mv-msg')
      const btn = e.target.querySelector('button')
      btn.disabled = true
      msg.textContent = ''
      msg.className = 'msg'
      try {
        await api('/movements', {
          method: 'POST',
          body: JSON.stringify({
            warehouse_id: state.activeWh,
            sku_id: Number(document.getElementById('mv-sku').value),
            movement_type: document.getElementById('mv-type').value,
            quantity: Number(document.getElementById('mv-qty').value),
            reference_code: document.getElementById('mv-ref').value || null,
          }),
        })
        await loadAll()
      } catch (ex) {
        msg.textContent = ex.message
        msg.className = 'msg err'
        btn.disabled = false
      }
    })
}

/* ── boot ───────────────────────────────────────────────── */

if (state.token) loadAll()
else renderLogin()

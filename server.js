require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const pool = new Pool(); // přihlašovací údaje z .env

app.use(cors());          // jen pro vývoj
app.use(express.json());

/* ---------- Pravidla obchodu (ceny dopravy určuje SERVER, ne prohlížeč) ---------- */
const SHIPPING = {
  ppl:        { name: 'PPL – doručení na adresu',     cents: 7900 },
  zasilkovna: { name: 'Zásilkovna – výdejní místo',   cents: 5900, pickup: true },
  personal:   { name: 'Osobní odběr na skladě',       cents: 0 }
};
const PICKUP = ['Praha 1 – Václavské nám. 12', 'Praha 7 – Dukelských hrdinů 30',
                'Brno – Masarykova 5', 'Ostrava – Stodolní 8'];

/* ---------- Pomocné funkce ---------- */
class ApiError extends Error {
  constructor(status, code, message, data) { super(message); Object.assign(this, { status, code, data }); }
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof ApiError) return res.status(e.status).json({ code: e.code, message: e.message, data: e.data });
    console.error(e);
    res.status(500).json({ code: 'SERVER', message: 'Chyba serveru.' });
  }
};
const intId = s => (/^\d{1,9}$/.test(String(s)) ? parseInt(s, 10) : null);

// Transakce: buď se povede všechno, nebo nic (při chybě ROLLBACK)
async function withTx(fn) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

const addHistory = (db, orderId, from, to, reason, actor = 'eshop') => db.query(
  `INSERT INTO order_status_history (order_id, from_status, to_status, actor, reason)
   VALUES ($1, $2, $3, $5, $4)`, [orderId, from, to, reason, actor]);

const addMovement = (db, type, variantId, loc, qty, refId, reason, actor = 'eshop', refType = 'ORDER') => db.query(
  `INSERT INTO stock_movements (type, variant_id, location_code, qty, ref_type, ref_id, reason, actor)
   VALUES ($1, $2, $3, $4, $8, $5, $6, $7)`, [type, variantId, loc, qty, String(refId), reason, actor, refType]);

// Aktér se ukládá jako text "app" nebo "app:jméno" (např. "warehouse:Jan")
const parseActor = a => { const [app, user] = String(a || '').split(':'); return { app, user: user || null }; };
const U = s => String(s || '').trim().slice(0, 40);
const groupBy = (rows, key) => { const m = new Map(); rows.forEach(r => { const k = r[key]; (m.get(k) || m.set(k, []).get(k)).push(r); }); return m; };

// Objednávky ve tvaru, který čeká frontend (ids = pole ID, nebo null = všechny)
async function loadOrders(db, ids) {
  const w = col => (ids ? `WHERE ${col} = ANY($1::int[])` : '');
  const args = ids ? [ids] : [];
  const orders = (await db.query(`SELECT * FROM orders ${w('id')} ORDER BY id`, args)).rows;
  const items = groupBy((await db.query(
    `SELECT order_id, name_snapshot, sku_snapshot, qty, unit_price_cents
     FROM order_items ${w('order_id')} ORDER BY id`, args)).rows, 'order_id');
  const hist = groupBy((await db.query(
    `SELECT order_id, from_status, to_status, actor, reason, at
     FROM order_status_history ${w('order_id')} ORDER BY id`, args)).rows, 'order_id');
  return orders.map(o => {
    const sh = SHIPPING[o.shipping_method] || { name: o.shipping_method };
    return {
      id: String(o.id), number: o.number, customerId: String(o.customer_id),
      customerSnapshot: o.customer_snapshot,
      items: (items.get(o.id) || []).map(i => ({ nameSnapshot: i.name_snapshot, skuSnapshot: i.sku_snapshot,
                                                  qty: i.qty, unitPriceCents: i.unit_price_cents })),
      totals: { itemsCents: o.items_cents, shippingCents: o.shipping_cents, totalCents: o.total_cents },
      shipping: { method: o.shipping_method, methodName: sh.name, pickupPoint: o.pickup_point },
      payment: { method: o.payment_method, status: o.payment_status, paidAt: o.paid_at },
      status: o.status,
      statusHistory: (hist.get(o.id) || []).map(h => ({ from: h.from_status, to: h.to_status, at: h.at,
                                                         actor: parseActor(h.actor), reason: h.reason })),
      rev: o.rev, createdAt: o.created_at, updatedAt: o.updated_at
    };
  });
}
const getOrder = async (db, id) => (await loadOrders(db, [id]))[0] || null;

/* ---------- GET /api/products: katalog ---------- */
app.get('/api/products', wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id::text AS id, p.name, p.description, p.category AS "categoryId",
           COALESCE(
             json_agg(
               json_build_object(
                 'id', v.id::text, 'sku', v.sku, 'ean', v.ean, 'attrs', v.attrs,
                 'priceCents', v.price_cents, 'available', COALESCE(st.available, 0)
               ) ORDER BY v.sku
             ) FILTER (WHERE v.id IS NOT NULL),
             '[]'::json
           ) AS variants
    FROM products p
    LEFT JOIN product_variants v ON v.product_id = p.id AND v.active
    LEFT JOIN (
      SELECT variant_id, SUM(on_hand - reserved)::int AS available
      FROM stock GROUP BY variant_id
    ) st ON st.variant_id = v.id
    WHERE p.active
    GROUP BY p.id
    ORDER BY p.name`);
  res.json(rows);
}));

/* ---------- POST /api/orders: vytvoření objednávky + rezervace skladu ---------- */
app.post('/api/orders', wrap(async (req, res) => {
  const body = req.body || {};
  const cart = body.cart, c = body.customer || {}, sh = body.shipping || {};

  if (!Array.isArray(cart) || !cart.length) throw new ApiError(400, 'EMPTY_CART', 'Košík je prázdný.');
  const m = SHIPPING[sh.method];
  if (!m) throw new ApiError(400, 'VALIDATION', 'Vyberte způsob dopravy.');
  if (m.pickup && !PICKUP.includes(sh.pickupPoint)) throw new ApiError(400, 'VALIDATION', 'Vyberte výdejní místo.');
  if (!['card', 'transfer'].includes(sh.paymentMethod)) throw new ApiError(400, 'VALIDATION', 'Vyberte způsob platby.');
  const need = (v, label) => { if (!String(v || '').trim()) throw new ApiError(400, 'VALIDATION', 'Vyplňte pole: ' + label); };
  need(c.name, 'jméno'); need(c.street, 'ulice'); need(c.city, 'město'); need(c.zip, 'PSČ');
  if (!/^\S+@\S+\.\S+$/.test(c.email || '')) throw new ApiError(400, 'VALIDATION', 'Zadejte platný e-mail.');
  if (c.company) need(c.company.name, 'název firmy');
  [c.name, c.email, c.street, c.city, c.zip, c.company && c.company.name, c.company && c.company.ico, c.company && c.company.dic]
    .forEach(v => { if (String(v || '').length > 100) throw new ApiError(400, 'VALIDATION', 'Pole smí mít nejvýše 100 znaků.'); });

  // sloučit duplicitní řádky košíku
  const want = new Map();
  for (const l of cart) {
    const vid = intId(l && l.variantId), q = parseInt(l && l.qty, 10) || 0;
    if (!vid || q < 1 || q > 99) throw new ApiError(400, 'INVALID_ITEM', 'Položka už není v nabídce.');
    want.set(vid, (want.get(vid) || 0) + q);
  }
  const ids = [...want.keys()];

  const order = await withTx(async db => {
    // 1) produkty a JEJICH CENY z databáze (ceny z prohlížeče nikdy nevěříme)
    const vars = (await db.query(
      `SELECT v.id, v.sku, v.price_cents, v.attrs, p.name
       FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.id = ANY($1::int[]) AND v.active AND p.active`, [ids])).rows;
    if (vars.length !== ids.length) throw new ApiError(409, 'INVALID_ITEM', 'Položka už není v nabídce.');

    // 2) zamknout skladové řádky, aby dva zákazníci nekoupili poslední kus naráz
    const stock = (await db.query(
      `SELECT variant_id, location_code, on_hand, reserved FROM stock
       WHERE variant_id = ANY($1::int[]) ORDER BY variant_id, location_code FOR UPDATE`, [ids])).rows;

    const items = [], short = [];
    for (const v of vars) {
      const qty = want.get(v.id);
      const avail = stock.filter(s => s.variant_id === v.id).reduce((a, s) => a + s.on_hand - s.reserved, 0);
      const label = Object.values(v.attrs || {}).join(' / ');
      if (avail < qty) short.push({ variantId: String(v.id), name: v.name, available: avail, requested: qty });
      items.push({ v, qty, name: v.name + (label ? ' – ' + label : '') });
    }
    if (short.length) throw new ApiError(409, 'INSUFFICIENT_STOCK', 'Některé položky nejsou v požadovaném množství skladem.', short);

    // 3) zákazník (podle e-mailu: najít, nebo založit)
    const email = c.email.trim().toLowerCase();
    const co = c.company || null;
    const { rows: [cu] } = await db.query(
      `INSERT INTO customers (name, email, street, zip, city, company_name, ico, dic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, street = EXCLUDED.street,
         zip = EXCLUDED.zip, city = EXCLUDED.city, company_name = EXCLUDED.company_name,
         ico = EXCLUDED.ico, dic = EXCLUDED.dic
       RETURNING id`,
      [c.name.trim(), email, c.street.trim(), c.zip.trim(), c.city.trim(),
       co && co.name ? co.name : null, co && co.ico ? co.ico : null, co && co.dic ? co.dic : null]);

    // 4) objednávka
    const itemsCents = items.reduce((a, i) => a + i.qty * i.v.price_cents, 0);
    const snapshot = {
      name: c.name.trim(), email,
      address: { street: c.street.trim(), city: c.city.trim(), zip: c.zip.trim(), country: 'CZ' },
      company: co ? { name: co.name, ico: co.ico || '', dic: co.dic || '' } : null
    };
    const { rows: [o] } = await db.query(
      `INSERT INTO orders (number, customer_id, customer_snapshot, status, items_cents, shipping_cents,
                           total_cents, payment_method, payment_status, shipping_method, pickup_point)
       VALUES (to_char(now(), 'YYYY') || '-' || lpad(nextval('order_number_seq')::text, 5, '0'),
               $1, $2::jsonb, 'AWAITING_PAYMENT', $3, $4, $5, $6, 'UNPAID', $7, $8)
       RETURNING id`,
      [cu.id, JSON.stringify(snapshot), itemsCents, m.cents, itemsCents + m.cents,
       sh.paymentMethod, sh.method, m.pickup ? sh.pickupPoint : null]);

    await addHistory(db, o.id, null, 'NEW', 'Objednávka vytvořena');
    await addHistory(db, o.id, 'NEW', 'AWAITING_PAYMENT', 'Checkout dokončen, zásoba rezervována');

    // 5) položky + rezervace zásoby po pozicích
    for (const it of items) {
      await db.query(
        `INSERT INTO order_items (order_id, variant_id, name_snapshot, sku_snapshot, qty, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`, [o.id, it.v.id, it.name, it.v.sku, it.qty, it.v.price_cents]);
      let left = it.qty;
      for (const s of stock.filter(x => x.variant_id === it.v.id)) {
        const take = Math.min(left, s.on_hand - s.reserved);
        if (take <= 0) continue;
        await db.query('UPDATE stock SET reserved = reserved + $1 WHERE variant_id = $2 AND location_code = $3',
                       [take, it.v.id, s.location_code]);
        await db.query('INSERT INTO order_reservations (order_id, variant_id, location_code, qty) VALUES ($1, $2, $3, $4)',
                       [o.id, it.v.id, s.location_code, take]);
        await addMovement(db, 'RESERVE', it.v.id, s.location_code, take, o.id, 'Checkout');
        left -= take;
      }
    }
    return getOrder(db, o.id);
  });
  res.status(201).json(order);
}));

/* ---------- GET /api/orders/:id ---------- */
app.get('/api/orders/:id', wrap(async (req, res) => {
  const id = intId(req.params.id);
  const o = id && await getOrder(pool, id);
  if (!o) throw new ApiError(404, 'NOT_FOUND', 'Objednávka neexistuje.');
  res.json(o);
}));

/* ---------- GET /api/customers/:id/orders: Moje objednávky ---------- */
app.get('/api/customers/:id/orders', wrap(async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.json([]);
  const { rows } = await pool.query(
    `SELECT id, number, status, total_cents, created_at FROM orders
     WHERE customer_id = $1 ORDER BY id DESC`, [id]);
  res.json(rows.map(o => ({ id: String(o.id), number: o.number, status: o.status,
                            createdAt: o.created_at, totals: { totalCents: o.total_cents } })));
}));

/* ---------- POST /api/orders/:id/pay (simulace platby) ---------- */
app.post('/api/orders/:id/pay', wrap(async (req, res) => {
  const id = intId(req.params.id), rev = req.body && req.body.rev;
  const order = await withTx(async db => {
    const { rows: [o] } = id ? await db.query('SELECT id, status, rev FROM orders WHERE id = $1 FOR UPDATE', [id]) : { rows: [] };
    if (!o) throw new ApiError(404, 'NOT_FOUND', 'Objednávka neexistuje.');
    if (rev != null && Number(rev) !== o.rev) throw new ApiError(409, 'STALE_REV', 'Objednávka se mezitím změnila, načtěte ji znovu.');
    if (o.status !== 'AWAITING_PAYMENT') throw new ApiError(409, 'INVALID_TRANSITION', 'Objednávku nelze zaplatit ve stavu ' + o.status + '.');
    await db.query(`UPDATE orders SET status = 'PAID', payment_status = 'PAID', paid_at = now(),
                    rev = rev + 1, updated_at = now() WHERE id = $1`, [id]);
    await addHistory(db, id, 'AWAITING_PAYMENT', 'PAID', 'Platba přijata (simulace)');
    return getOrder(db, id);
  });
  res.json(order);
}));

/* ---------- POST /api/orders/:id/cancel (storno zákazníkem + uvolnění rezervace) ---------- */
app.post('/api/orders/:id/cancel', wrap(async (req, res) => {
  const id = intId(req.params.id), rev = req.body && req.body.rev;
  const order = await withTx(async db => {
    const { rows: [o] } = id ? await db.query('SELECT id, status, rev FROM orders WHERE id = $1 FOR UPDATE', [id]) : { rows: [] };
    if (!o) throw new ApiError(404, 'NOT_FOUND', 'Objednávka neexistuje.');
    if (rev != null && Number(rev) !== o.rev) throw new ApiError(409, 'STALE_REV', 'Objednávka se mezitím změnila, načtěte ji znovu.');
    if (!['NEW', 'AWAITING_PAYMENT', 'PAID'].includes(o.status))
      throw new ApiError(409, 'INVALID_TRANSITION', `Přechod ${o.status} → CANCELLED není povolen.`);
    const res_ = (await db.query(
      'SELECT variant_id, location_code, qty FROM order_reservations WHERE order_id = $1 ORDER BY variant_id, location_code', [id])).rows;
    for (const r of res_) {
      await db.query('UPDATE stock SET reserved = reserved - $1 WHERE variant_id = $2 AND location_code = $3',
                     [r.qty, r.variant_id, r.location_code]);
      await addMovement(db, 'RELEASE', r.variant_id, r.location_code, r.qty, id, 'Storno');
    }
    await db.query('DELETE FROM order_reservations WHERE order_id = $1', [id]);
    await db.query(`UPDATE orders SET status = 'CANCELLED',
                    payment_status = CASE WHEN payment_status = 'PAID' THEN 'REFUNDED' ELSE payment_status END,
                    rev = rev + 1, updated_at = now() WHERE id = $1`, [id]);
    await addHistory(db, id, o.status, 'CANCELLED', (req.body && req.body.reason) || 'Storno zákazníkem');
    return getOrder(db, id);
  });
  res.json(order);
}));

/* =====================================================================
   ADMIN + SKLAD
   ===================================================================== */

// Tabulka povolených přechodů stavů objednávky: [z, do, role]
const TR = [
  ['NEW', 'AWAITING_PAYMENT', 'customer'], ['AWAITING_PAYMENT', 'PAID', 'customer'],
  ['PAID', 'HANDED_TO_WAREHOUSE', 'admin'], ['HANDED_TO_WAREHOUSE', 'PICKING', 'warehouse'],
  ['PICKING', 'PACKED', 'warehouse'], ['PACKED', 'SHIPPED', 'warehouse'],
  ['SHIPPED', 'DELIVERED', 'admin'], ['DELIVERED', 'RETURN_REQUESTED', 'customer,admin'],
  ['RETURN_REQUESTED', 'RETURNED', 'warehouse'], ['NEW', 'CANCELLED', 'customer,admin'],
  ['AWAITING_PAYMENT', 'CANCELLED', 'customer,admin'], ['PAID', 'CANCELLED', 'customer,admin'],
  ['HANDED_TO_WAREHOUSE', 'CANCELLED', 'admin']
];

async function lockOrder(db, id) {
  const { rows: [o] } = id
    ? await db.query('SELECT id, status, rev, customer_snapshot FROM orders WHERE id = $1 FOR UPDATE', [id])
    : { rows: [] };
  if (!o) throw new ApiError(404, 'NOT_FOUND', 'Objednávka neexistuje.');
  return o;
}

async function transition(db, o, to, role, actor, reason) {
  const r = TR.find(x => x[0] === o.status && x[1] === to);
  if (!r) throw new ApiError(409, 'INVALID_TRANSITION', `Přechod ${o.status} → ${to} není povolen.`);
  if (!r[2].split(',').includes(role)) throw new ApiError(403, 'FORBIDDEN', `Role ${role} nesmí provést ${o.status} → ${to}.`);
  await db.query('UPDATE orders SET status = $2, rev = rev + 1, updated_at = now() WHERE id = $1', [o.id, to]);
  await addHistory(db, o.id, o.status, to, reason, actor);
}

/* ---------- Načítání úloh a batchů ve tvaru pro frontend ---------- */
async function loadTasks(db, ids) {
  const w = col => (ids ? `WHERE ${col} = ANY($1::int[])` : '');
  const args = ids ? [ids] : [];
  const tasks = (await db.query(`SELECT * FROM fulfillment_tasks ${w('id')} ORDER BY id`, args)).rows;
  const lines = groupBy((await db.query(
    `SELECT * FROM fulfillment_task_lines ${w('task_id')} ORDER BY task_id, line_no`, args)).rows, 'task_id');
  return tasks.map(t => ({
    id: String(t.id), orderId: String(t.order_id), type: t.type, status: t.status,
    batchId: t.batch_id == null ? null : String(t.batch_id), assignee: t.assignee,
    createdAt: t.created_at, rev: t.rev,
    lines: (lines.get(t.id) || []).map(l => ({ variantId: String(l.variant_id), locationId: l.location_code,
                                                qtyRequired: l.qty_required, qtyPicked: l.qty_picked }))
  }));
}

async function loadBatches(db, ids) {
  const w = col => (ids ? `WHERE ${col} = ANY($1::int[])` : '');
  const args = ids ? [ids] : [];
  const batches = (await db.query(`SELECT * FROM pick_batches ${w('id')} ORDER BY id`, args)).rows;
  const lines = groupBy((await db.query(
    `SELECT * FROM pick_batch_lines ${w('batch_id')} ORDER BY batch_id, location_code, variant_id`, args)).rows, 'batch_id');
  const allocs = (await db.query(
    `SELECT * FROM pick_batch_allocations ${w('batch_id')} ORDER BY task_id, line_no`, args)).rows;
  const tasks = groupBy((await db.query(
    `SELECT id, batch_id FROM fulfillment_tasks
     WHERE batch_id IS NOT NULL AND status <> 'CANCELLED' ${ids ? 'AND batch_id = ANY($1::int[])' : ''} ORDER BY id`, args)).rows, 'batch_id');
  return batches.map(b => ({
    id: String(b.id), status: b.status, assignee: b.assignee, createdAt: b.created_at,
    startedAt: b.started_at, completedAt: b.completed_at, rev: b.rev,
    taskIds: (tasks.get(b.id) || []).map(t => String(t.id)),
    lines: (lines.get(b.id) || []).map(l => ({
      key: l.variant_id + '|' + l.location_code, variantId: String(l.variant_id), locationId: l.location_code,
      qtyRequired: l.qty_required, qtyPicked: l.qty_picked,
      allocations: allocs.filter(a => a.batch_id === b.id && a.variant_id === l.variant_id && a.location_code === l.location_code)
                         .map(a => ({ taskId: String(a.task_id), lineIdx: a.line_no, qty: a.qty }))
    }))
  }));
}

/* ---------- GET /api/admin/snapshot: všechna data pro admin a sklad ---------- */
app.get('/api/admin/snapshot', wrap(async (req, res) => {
  const q = sql => pool.query(sql).then(r => r.rows);
  const [products, variants, customers, locations, stock, movements, orders, tasks, batches] = await Promise.all([
    q('SELECT * FROM products ORDER BY id'),
    q('SELECT * FROM product_variants ORDER BY id'),
    q('SELECT * FROM customers ORDER BY id'),
    q('SELECT * FROM locations ORDER BY code'),
    q('SELECT * FROM stock ORDER BY variant_id, location_code'),
    q('SELECT * FROM (SELECT * FROM stock_movements ORDER BY id DESC LIMIT 200) m ORDER BY id'),
    loadOrders(pool, null), loadTasks(pool, null), loadBatches(pool, null)
  ]);
  const orderNo = new Map(orders.map(o => [o.id, o.number]));
  res.json({
    meta: true,
    products: products.map(p => ({ id: String(p.id), name: p.name, description: p.description,
                                   categoryId: p.category, vatRate: Number(p.vat_rate), active: p.active })),
    variants: variants.map(v => ({ id: String(v.id), productId: String(v.product_id), sku: v.sku, ean: v.ean,
                                   priceCents: v.price_cents, attrs: v.attrs, active: v.active })),
    customers: customers.map(c => ({ id: String(c.id), name: c.name, email: c.email,
                                     address: { street: c.street, zip: c.zip, city: c.city },
                                     company: c.company_name ? { name: c.company_name, ico: c.ico } : null })),
    locations: locations.map(l => ({ code: l.code })),
    stock: stock.map(s => ({ variantId: String(s.variant_id), locationId: s.location_code,
                             onHand: s.on_hand, reserved: s.reserved })),
    movements: movements.map(m => ({ id: String(m.id), at: m.at, type: m.type, variantId: String(m.variant_id),
                                     locationId: m.location_code, qty: m.qty, reason: m.reason,
                                     refId: m.ref_type === 'ORDER' ? (orderNo.get(Number(m.ref_id)) || m.ref_id)
                                          : m.ref_type === 'BATCH' ? 'batch ' + m.ref_id : m.ref_id,
                                     actor: parseActor(m.actor) })),
    orders, tasks, batches, shipments: []
  });
}));

/* ---------- ADMIN: předat zaplacenou objednávku skladu (vznikne skladová úloha) ---------- */
app.post('/api/admin/orders/:id/hand', wrap(async (req, res) => {
  const id = intId(req.params.id), actor = 'admin:' + (U(req.body && req.body.user) || 'admin');
  const task = await withTx(async db => {
    const o = await lockOrder(db, id);
    await transition(db, o, 'HANDED_TO_WAREHOUSE', 'admin', actor, 'Předáno skladu');
    const resv = (await db.query(
      'SELECT variant_id, location_code, qty FROM order_reservations WHERE order_id = $1 ORDER BY id', [id])).rows;
    if (!resv.length) throw new ApiError(409, 'NO_RESERVATION', 'Objednávka nemá rezervaci zásoby.');
    const a = o.customer_snapshot && o.customer_snapshot.address;
    if (!a || !a.street || !a.city) throw new ApiError(409, 'NO_ADDRESS', 'Objednávka nemá vyplněnou adresu.');
    const { rows: [t] } = await db.query(
      `INSERT INTO fulfillment_tasks (order_id, type, status) VALUES ($1, 'FULFILL', 'OPEN') RETURNING id`, [id]);
    for (let i = 0; i < resv.length; i++)
      await db.query(
        `INSERT INTO fulfillment_task_lines (task_id, line_no, variant_id, location_code, qty_required)
         VALUES ($1, $2, $3, $4, $5)`, [t.id, i, resv[i].variant_id, resv[i].location_code, resv[i].qty]);
    return (await loadTasks(db, [t.id]))[0];
  });
  res.status(201).json(task);
}));

/* ---------- ADMIN: storno (uvolní rezervaci, zruší skladovou úlohu) ---------- */
app.post('/api/admin/orders/:id/cancel', wrap(async (req, res) => {
  const id = intId(req.params.id), actor = 'admin:' + (U(req.body && req.body.user) || 'admin');
  const order = await withTx(async db => {
    const o = await lockOrder(db, id), prev = o.status;
    await transition(db, o, 'CANCELLED', 'admin', actor, (req.body && req.body.reason) || 'Storno administrátorem');
    const rs = (await db.query(
      'SELECT variant_id, location_code, qty FROM order_reservations WHERE order_id = $1 ORDER BY variant_id, location_code', [id])).rows;
    for (const r of rs) {
      await db.query('UPDATE stock SET reserved = reserved - $1 WHERE variant_id = $2 AND location_code = $3',
                     [r.qty, r.variant_id, r.location_code]);
      await addMovement(db, 'RELEASE', r.variant_id, r.location_code, r.qty, id, 'Storno', actor);
    }
    await db.query('DELETE FROM order_reservations WHERE order_id = $1', [id]);
    await db.query(`UPDATE orders SET payment_status = CASE WHEN payment_status = 'PAID' THEN 'REFUNDED' ELSE payment_status END
                    WHERE id = $1`, [id]);
    if (prev === 'HANDED_TO_WAREHOUSE') {
      const { rows: [tk] } = await db.query(
        `SELECT id, batch_id FROM fulfillment_tasks WHERE order_id = $1 AND status <> 'CANCELLED' FOR UPDATE`, [id]);
      if (tk) {
        await db.query(`UPDATE fulfillment_tasks SET status = 'CANCELLED', rev = rev + 1 WHERE id = $1`, [tk.id]);
        if (tk.batch_id) { // vyjmout z batche, který ještě neběží
          const al = (await db.query(
            'DELETE FROM pick_batch_allocations WHERE task_id = $1 RETURNING variant_id, location_code, qty', [tk.id])).rows;
          for (const a of al)
            await db.query(`UPDATE pick_batch_lines SET qty_required = qty_required - $1
                            WHERE batch_id = $2 AND variant_id = $3 AND location_code = $4`,
                           [a.qty, tk.batch_id, a.variant_id, a.location_code]);
          await db.query('DELETE FROM pick_batch_lines WHERE batch_id = $1 AND qty_required <= 0', [tk.batch_id]);
          await db.query(
            `UPDATE pick_batches SET rev = rev + 1,
               status = CASE WHEN EXISTS (SELECT 1 FROM fulfillment_tasks WHERE batch_id = $1 AND status <> 'CANCELLED')
                             THEN status ELSE 'CANCELLED' END
             WHERE id = $1`, [tk.batch_id]);
        }
      }
    }
    return getOrder(db, id);
  });
  res.json(order);
}));

/* ---------- SKLAD: vytvoření picking batche z úloh ---------- */
app.post('/api/warehouse/batches', wrap(async (req, res) => {
  const raw = req.body && req.body.taskIds;
  if (!Array.isArray(raw) || !raw.length) throw new ApiError(400, 'EMPTY', 'Vyberte aspoň jednu objednávku.');
  const ids = [...new Set(raw.map(intId))];
  if (ids.some(x => !x)) throw new ApiError(404, 'NOT_FOUND', 'Úloha neexistuje.');
  const batch = await withTx(async db => {
    const tasks = (await db.query(
      'SELECT id, status FROM fulfillment_tasks WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids])).rows;
    if (tasks.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Úloha neexistuje.');
    tasks.forEach(t => { if (t.status !== 'OPEN') throw new ApiError(409, 'TASK_NOT_OPEN', `Úloha ${t.id} už není volná.`); });
    const lines = (await db.query(
      'SELECT * FROM fulfillment_task_lines WHERE task_id = ANY($1::int[]) ORDER BY task_id, line_no', [ids])).rows;
    // sloučit stejné varianty na stejné pozici
    const map = new Map();
    for (const l of lines) {
      const k = l.variant_id + '|' + l.location_code;
      const x = map.get(k) || map.set(k, { variant_id: l.variant_id, location_code: l.location_code, qty: 0, allocs: [] }).get(k);
      x.qty += l.qty_required;
      x.allocs.push({ task_id: l.task_id, line_no: l.line_no, qty: l.qty_required });
    }
    const { rows: [b] } = await db.query(`INSERT INTO pick_batches (status) VALUES ('OPEN') RETURNING id`);
    for (const x of map.values()) {
      await db.query(`INSERT INTO pick_batch_lines (batch_id, variant_id, location_code, qty_required) VALUES ($1, $2, $3, $4)`,
                     [b.id, x.variant_id, x.location_code, x.qty]);
      for (const a of x.allocs)
        await db.query(`INSERT INTO pick_batch_allocations (batch_id, variant_id, location_code, task_id, line_no, qty)
                        VALUES ($1, $2, $3, $4, $5, $6)`, [b.id, x.variant_id, x.location_code, a.task_id, a.line_no, a.qty]);
    }
    await db.query(`UPDATE fulfillment_tasks SET status = 'BATCHED', batch_id = $2, rev = rev + 1 WHERE id = ANY($1::int[])`, [ids, b.id]);
    return (await loadBatches(db, [b.id]))[0];
  });
  res.status(201).json(batch);
}));

async function lockBatch(db, id) {
  const { rows: [b] } = id ? await db.query('SELECT * FROM pick_batches WHERE id = $1 FOR UPDATE', [id]) : { rows: [] };
  if (!b) throw new ApiError(404, 'NOT_FOUND', 'Batch neexistuje.');
  return b;
}

/* ---------- SKLAD: zahájení picku (objednávky HANDED_TO_WAREHOUSE → PICKING) ---------- */
app.post('/api/warehouse/batches/:id/start', wrap(async (req, res) => {
  const id = intId(req.params.id), u = U(req.body && req.body.user);
  if (!u) throw new ApiError(400, 'NO_USER', 'Zadejte jméno skladníka.');
  const batch = await withTx(async db => {
    const b = await lockBatch(db, id);
    if (b.status !== 'OPEN') throw new ApiError(409, 'BATCH_NOT_OPEN', 'Batch už byl zahájen nebo uzavřen.');
    await db.query(`UPDATE pick_batches SET status = 'IN_PROGRESS', assignee = $2, started_at = now(), rev = rev + 1 WHERE id = $1`, [id, u]);
    const tasks = (await db.query(
      `SELECT id, order_id FROM fulfillment_tasks WHERE batch_id = $1 AND status <> 'CANCELLED' ORDER BY id FOR UPDATE`, [id])).rows;
    for (const t of tasks) {
      await db.query(`UPDATE fulfillment_tasks SET status = 'PICKING', assignee = $2, rev = rev + 1 WHERE id = $1`, [t.id, u]);
      const o = await lockOrder(db, t.order_id);
      await transition(db, o, 'PICKING', 'warehouse', 'warehouse:' + u, 'Zahájen picking batch ' + id);
    }
    return (await loadBatches(db, [id]))[0];
  });
  res.json(batch);
}));

/* ---------- SKLAD: pick = sken pozice + EAN + množství (onHand se mění až při expedici) ---------- */
app.post('/api/warehouse/batches/:id/pick', wrap(async (req, res) => {
  const id = intId(req.params.id), body = req.body || {};
  await withTx(async db => {
    const b = await lockBatch(db, id);
    const actor = 'warehouse:' + (U(body.user) || b.assignee || 'sklad');
    if (b.status !== 'IN_PROGRESS') throw new ApiError(409, 'BATCH_NOT_ACTIVE', 'Batch není ve stavu picking.');
    const [vs, loc] = String(body.key || '').split('|'), vid = intId(vs);
    const { rows: [l] } = vid && loc
      ? await db.query('SELECT * FROM pick_batch_lines WHERE batch_id = $1 AND variant_id = $2 AND location_code = $3 FOR UPDATE', [id, vid, loc])
      : { rows: [] };
    if (!l) throw new ApiError(404, 'NO_LINE', 'Řádek batche neexistuje.');
    if (U(body.location).toUpperCase() !== l.location_code.toUpperCase())
      throw new ApiError(409, 'WRONG_LOCATION', 'Špatná pozice. Očekává se ' + l.location_code + '.');
    const { rows: [v] } = await db.query('SELECT ean FROM product_variants WHERE id = $1', [vid]);
    if (!v || U(body.ean) !== v.ean) throw new ApiError(409, 'WRONG_EAN', 'EAN neodpovídá očekávanému produktu.');
    const n = Number(body.qty);
    if (!Number.isInteger(n) || n < 1) throw new ApiError(400, 'BAD_QTY', 'Zadejte celé číslo větší než 0.');
    const rem = l.qty_required - l.qty_picked;
    if (n > rem) throw new ApiError(409, 'QTY_EXCEEDS', 'Zbývá vychystat jen ' + rem + ' ks.');
    // rozdělit vychystané kusy mezi objednávky v batchi
    let left = n;
    const al = (await db.query(
      `SELECT task_id, line_no FROM pick_batch_allocations
       WHERE batch_id = $1 AND variant_id = $2 AND location_code = $3 ORDER BY task_id, line_no`, [id, vid, loc])).rows;
    for (const a of al) {
      if (left <= 0) break;
      const { rows: [tl] } = await db.query(
        'SELECT qty_required, qty_picked FROM fulfillment_task_lines WHERE task_id = $1 AND line_no = $2 FOR UPDATE', [a.task_id, a.line_no]);
      const take = Math.min(left, tl.qty_required - tl.qty_picked);
      if (take > 0) {
        await db.query('UPDATE fulfillment_task_lines SET qty_picked = qty_picked + $3 WHERE task_id = $1 AND line_no = $2',
                       [a.task_id, a.line_no, take]);
        await db.query('UPDATE fulfillment_tasks SET rev = rev + 1 WHERE id = $1', [a.task_id]);
        left -= take;
      }
    }
    await db.query('UPDATE pick_batch_lines SET qty_picked = qty_picked + $4 WHERE batch_id = $1 AND variant_id = $2 AND location_code = $3',
                   [id, vid, loc, n]);
    await db.query('UPDATE pick_batches SET rev = rev + 1 WHERE id = $1', [id]);
    await addMovement(db, 'PICK', vid, loc, n, id, 'Ověřeno skenem', actor, 'BATCH');
  });
  res.json({ ok: true });
}));

/* ---------- SKLAD: dokončení picku (objednávky PICKING → PACKED) ---------- */
app.post('/api/warehouse/batches/:id/complete', wrap(async (req, res) => {
  const id = intId(req.params.id);
  const batch = await withTx(async db => {
    const b = await lockBatch(db, id);
    const actor = 'warehouse:' + (U(req.body && req.body.user) || b.assignee || 'sklad');
    if (b.status !== 'IN_PROGRESS') throw new ApiError(409, 'BATCH_NOT_ACTIVE', 'Batch není ve stavu picking.');
    const open = await db.query('SELECT 1 FROM pick_batch_lines WHERE batch_id = $1 AND qty_picked <> qty_required LIMIT 1', [id]);
    if (open.rowCount) throw new ApiError(409, 'PICK_INCOMPLETE', 'Nejsou vychystány všechny položky.');
    const tasks = (await db.query(
      `SELECT id, order_id FROM fulfillment_tasks WHERE batch_id = $1 AND status = 'PICKING' ORDER BY id FOR UPDATE`, [id])).rows;
    for (const t of tasks) {
      await db.query(`UPDATE fulfillment_tasks SET status = 'PICKED', rev = rev + 1 WHERE id = $1`, [t.id]);
      const o = await lockOrder(db, t.order_id);
      await transition(db, o, 'PACKED', 'warehouse', actor, 'Picking dokončen batch ' + id);
    }
    await db.query(`UPDATE pick_batches SET status = 'DONE', completed_at = now(), rev = rev + 1 WHERE id = $1`, [id]);
    return (await loadBatches(db, [id]))[0];
  });
  res.json(batch);
}));

app.listen(process.env.PORT || 3000, () =>
  console.log('Server běží na http://localhost:' + (process.env.PORT || 3000)));

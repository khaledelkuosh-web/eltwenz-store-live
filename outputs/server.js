const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PRODUCTS = path.join(ROOT, 'products');
const DATA = path.join(ROOT, 'data');
const ORDERS = path.join(DATA, 'orders.jsonl');
const INQUIRIES = path.join(DATA, 'price-inquiries.jsonl');
const CUSTOMERS = path.join(DATA, 'customers.json');
const SHIPPING_RATES = path.join(DATA, 'shipping-rates.json');
const TOKEN_FILE = path.join(DATA, 'admin-token.txt');
const CATALOG = path.join(DATA, 'products.json');
const IS_NETLIFY = Boolean(process.env.NETLIFY);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('لازم تضبط SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY مع بعض.');
}
if (IS_NETLIFY && !USE_SUPABASE) {
  throw new Error('لازم تضبط إعدادات Supabase في Netlify عشان تحفظ بيانات المتجر بأمان.');
}
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
if (!IS_NETLIFY) fs.mkdirSync(DATA, { recursive: true });

let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken && IS_NETLIFY) {
  throw new Error('لازم تضبط ADMIN_TOKEN في إعدادات Netlify قبل النشر.');
}
if (!adminToken) {
  try { adminToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); }
  catch (_) {
    adminToken = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, adminToken, { mode: 0o600, flag: 'wx' });
    console.log('\nرمز دخول لوحة الطلبات (احتفظ به):\n' + adminToken + '\n');
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const rate = new Map();
const authRate = new Map();

function send(res, status, body, type, extraHeaders) {
  res.writeHead(status, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  });
  res.end(type ? body : JSON.stringify(body));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'الصفحة المطلوبة مش موجودة.' });
    send(res, 200, data, mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

function readJson(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (Buffer.byteLength(text) > limit) {
        reject(Object.assign(new Error('حجم الطلب كبير.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); }
      catch (_) { reject(Object.assign(new Error('بيانات الطلب مش مفهومة.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function authorized(req) {
  const value = req.headers.authorization || '';
  const expected = Buffer.from('Bearer ' + adminToken);
  const actual = Buffer.from(value);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function customerSession(req) {
  const raw = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('eltwenzCustomer='));
  if (!raw) return null;
  const value = raw.slice('eltwenzCustomer='.length);
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', adminToken).update(payload).digest('base64url');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.id || data.exp < Date.now()) return null;
    const customers = await readCustomers();
    return customers.find(customer => customer.id === data.id) || null;
  } catch (_) { return null; }
}

function customerCookie(customerId, req, clear) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  if (clear) return 'eltwenzCustomer=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
  const payload = Buffer.from(JSON.stringify({ id: customerId, exp: Date.now() + 30 * 24 * 60 * 60 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', adminToken).update(payload).digest('base64url');
  return 'eltwenzCustomer=' + payload + '.' + signature + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000' + (secure ? '; Secure' : '');
}

async function remoteRead(collection) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/store_records?collection=eq.${encodeURIComponent(collection)}&select=id,payload&order=updated_at.asc`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!response.ok) throw new Error(`Supabase read failed (${response.status}).`);
  const rows = await response.json();
  return rows.map(row => row.payload);
}

async function remoteWrite(collection, values) {
  const rows = (Array.isArray(values) ? values : [values]).map(value => ({
    collection,
    id: collection === 'shipping_rates' ? 'default' : String(value.id),
    payload: value
  }));
  if (!rows.length) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/store_records?on_conflict=collection,id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  });
  if (!response.ok) throw new Error(`Supabase write failed (${response.status}).`);
}

async function readCustomers() {
  if (USE_SUPABASE) return remoteRead('customers');
  if (!fs.existsSync(CUSTOMERS)) return [];
  return JSON.parse(fs.readFileSync(CUSTOMERS, 'utf8').replace(/^\uFEFF/, ''));
}

async function writeCustomers(customers) {
  if (USE_SUPABASE) return remoteWrite('customers', customers);
  const tmp = CUSTOMERS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(customers, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CUSTOMERS);
}

async function readShippingRates() {
  if (USE_SUPABASE) return (await remoteRead('shipping_rates'))[0]?.rates || {};
  if (!fs.existsSync(SHIPPING_RATES)) return {};
  return JSON.parse(fs.readFileSync(SHIPPING_RATES, 'utf8').replace(/^\uFEFF/, ''));
}

async function writeShippingRates(rates) {
  if (USE_SUPABASE) return remoteWrite('shipping_rates', { id: 'default', rates });
  const tmp = SHIPPING_RATES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rates, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SHIPPING_RATES);
}

function publicCustomer(customer) {
  return { id: customer.id, name: customer.name, phone: customer.phone, governorate: customer.governorate, city: customer.city, address: customer.address };
}

async function readOrders() {
  if (USE_SUPABASE) return remoteRead('orders');
  if (!fs.existsSync(ORDERS)) return [];
  return fs.readFileSync(ORDERS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function readProducts() {
  if (USE_SUPABASE) return remoteRead('products');
  if (!fs.existsSync(CATALOG)) return [];
  return JSON.parse(fs.readFileSync(CATALOG, 'utf8').replace(/^\uFEFF/, ''));
}

function customerProductId(product) {
  return String(product.id).replace(/^taager-/, 'item-');
}

function findCatalogProduct(products, id) {
  return products.find(product => product.id === id || customerProductId(product) === id);
}

function customerProduct(product) {
  const { id, name, category, description, badge, image, images, price, discount, stock, active } = product;
  return { id: customerProductId(product), name, category, description, badge, image, images, price, discount, stock, active };
}

async function writeProducts(products) {
  if (USE_SUPABASE) return remoteWrite('products', products);
  const tmp = CATALOG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(products, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CATALOG);
}

async function writeOrders(orders) {
  if (USE_SUPABASE) return remoteWrite('orders', orders);
  const tmp = ORDERS + '.tmp';
  fs.writeFileSync(tmp, orders.map(order => JSON.stringify(order)).join('\n') + (orders.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, ORDERS);
}

async function readInquiries() {
  if (USE_SUPABASE) return remoteRead('inquiries');
  if (!fs.existsSync(INQUIRIES)) return [];
  return fs.readFileSync(INQUIRIES, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function writeInquiries(rows) {
  if (USE_SUPABASE) return remoteWrite('inquiries', rows);
  const tmp = INQUIRIES + '.tmp';
  fs.writeFileSync(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, INQUIRIES);
}

function productInput(body, current) {
  const name = String(body.name ?? current?.name ?? '').trim();
  const category = String(body.category ?? current?.category ?? '').trim();
  const description = String(body.description ?? current?.description ?? '').trim().slice(0, 240);
  const badge = String(body.badge ?? current?.badge ?? category).trim().slice(0, 40);
  const image = String(body.image ?? current?.image ?? '').trim();
  const price = body.price === undefined ? (current?.price ?? null) : (body.price === '' || body.price === null ? null : Number(body.price));
  const stock = body.stock === undefined ? (current?.stock ?? null) : (body.stock === '' || body.stock === null ? null : Number(body.stock));
  const discount = body.discount === undefined ? (current?.discount ?? 0) : (body.discount === '' || body.discount === null ? 0 : Number(body.discount));
  if (name.length < 2 || name.length > 100) throw Object.assign(new Error('اسم المنتج لازم يكون من ٢ لـ١٠٠ حرف.'), { status: 400 });
  if (!category || category.length > 40) throw Object.assign(new Error('اكتب تصنيف المنتج (بحد أقصى ٤٠ حرف).'), { status: 400 });
  if (!Number.isFinite(price) && price !== null || price !== null && (price < 0 || price > 100000000)) throw Object.assign(new Error('السعر لازم يكون رقم صحيح أو فاضي لو لسه مش متحدد.'), { status: 400 });
  if (!Number.isInteger(stock) && stock !== null || stock !== null && (stock < 0 || stock > 10000000)) throw Object.assign(new Error('الكمية لازم تكون رقم صحيح أو فاضية لو مش هتتابع المخزون.'), { status: 400 });
  if (!Number.isFinite(discount) || discount < 0 || discount > 100) throw Object.assign(new Error('الخصم لازم يكون نسبة من ٠ لـ١٠٠٪.'), { status: 400 });
  if (image && !/^https:\/\//i.test(image) && !/^[A-Za-z0-9_.-]+$/.test(image)) throw Object.assign(new Error('رابط الصورة لازم يبدأ بـ https أو يكون اسم ملف داخل مجلد الصور.'), { status: 400 });
  return { name, category, description, badge: badge || category, image, price, stock, discount, active: body.active === undefined ? (current ? current.active !== false : true) : Boolean(body.active) };
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'GET' && url.pathname === '/') return sendFile(res, path.join(ROOT, 'storefront.html'));
  if (req.method === 'GET' && url.pathname === '/admin') return sendFile(res, path.join(ROOT, 'admin.html'));
  if (req.method === 'GET' && url.pathname === '/account') return sendFile(res, path.join(ROOT, 'account.html'));
  if (req.method === 'GET' && /^\/category\/[^/]+$/.test(url.pathname)) return sendFile(res, path.join(ROOT, 'category.html'));
  if (req.method === 'GET' && url.pathname.startsWith('/product/')) return sendFile(res, path.join(ROOT, 'product.html'));
  if (req.method === 'GET' && url.pathname.startsWith('/price-inquiry/')) return sendFile(res, path.join(ROOT, 'price-inquiry.html'));
  if (req.method === 'GET' && url.pathname === '/checkout.js') return sendFile(res, path.join(ROOT, 'checkout.js'));
  if (req.method === 'GET' && url.pathname === '/account.js') return sendFile(res, path.join(ROOT, 'account.js'));
  if (req.method === 'GET' && url.pathname === '/locations.js') return sendFile(res, path.join(ROOT, 'locations.js'));
  if (req.method === 'GET' && url.pathname === '/catalog.js') return sendFile(res, path.join(ROOT, 'catalog.js'));
  if (req.method === 'GET' && url.pathname === '/hero-carousel.js') return sendFile(res, path.join(ROOT, 'hero-carousel.js'));
  if (req.method === 'GET' && url.pathname === '/category.js') return sendFile(res, path.join(ROOT, 'category.js'));
  if (req.method === 'GET' && url.pathname === '/product.js') return sendFile(res, path.join(ROOT, 'product.js'));
  if (req.method === 'GET' && url.pathname === '/price-inquiry.js') return sendFile(res, path.join(ROOT, 'price-inquiry.js'));
  if (req.method === 'GET' && url.pathname === '/product.css') return sendFile(res, path.join(ROOT, 'product.css'));
  if (req.method === 'GET' && url.pathname === '/price-inquiry.css') return sendFile(res, path.join(ROOT, 'price-inquiry.css'));
  if (req.method === 'GET' && url.pathname === '/order.css') return sendFile(res, path.join(ROOT, 'order.css'));
  if (req.method === 'GET' && url.pathname === '/account.css') return sendFile(res, path.join(ROOT, 'account.css'));
  if (req.method === 'GET' && url.pathname === '/catalog.css') return sendFile(res, path.join(ROOT, 'catalog.css'));
  if (req.method === 'GET' && url.pathname === '/category.css') return sendFile(res, path.join(ROOT, 'category.css'));
  if (req.method === 'POST' && url.pathname === '/api/customer/register') {
    try {
      const body = await readJson(req, 8192);
      const name = String(body.name || '').trim(), phone = String(body.phone || '').trim();
      const password = String(body.password || ''), governorate = String(body.governorate || '').trim();
      const city = String(body.city || '').trim(), address = String(body.address || '').trim();
      if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'اكتب الاسم من ٢ لـ٨٠ حرف.' });
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'كلمة المرور لازم تكون ٨ أحرف على الأقل.' });
      if (!governorate || !city || governorate.length > 60 || city.length > 80) return send(res, 400, { error: 'اختار المحافظة والمدينة.' });
      if (address.length < 8 || address.length > 500) return send(res, 400, { error: 'اكتب الشارع والعنوان بالتفصيل.' });
      const customers = await readCustomers();
      const normalizedPhone = phone.replace(/\D/g, '');
      if (customers.some(customer => customer.phone.replace(/\D/g, '') === normalizedPhone)) return send(res, 409, { error: 'في حساب مسجل بنفس رقم التليفون. سجّل دخولك بدل إنشاء حساب جديد.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const customer = { id: crypto.randomUUID(), name, phone, governorate, city, address, passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'), createdAt: new Date().toISOString() };
      customers.push(customer); await writeCustomers(customers);
      return send(res, 201, { ok: true, customer: publicCustomer(customer) });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر إنشاء الحساب.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/customer/login') {
    const key = req.socket.remoteAddress || 'unknown', now = Date.now();
    const attempts = (authRate.get(key) || []).filter(time => now - time < 60 * 60 * 1000);
    if (attempts.length >= 20) return send(res, 429, { error: 'محاولات الدخول كتير. جرّب تاني بعد شوية.' });
    attempts.push(now); authRate.set(key, attempts);
    try {
      const body = await readJson(req, 4096);
      const phone = String(body.phone || '').trim(), password = String(body.password || '');
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      const customer = (await readCustomers()).find(item => item.phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));
      if (!customer || !customer.passwordSalt || !customer.passwordHash) return send(res, 401, { error: 'رقم التليفون أو كلمة المرور مش صحيحة.' });
      const actual = crypto.scryptSync(password, customer.passwordSalt, 64);
      const expected = Buffer.from(customer.passwordHash, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return send(res, 401, { error: 'رقم التليفون أو كلمة المرور مش صحيحة.' });
      return send(res, 200, { ok: true, customer: publicCustomer(customer) }, undefined, { 'Set-Cookie': customerCookie(customer.id, req) });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تسجيل الدخول.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/customer/logout') {
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': customerCookie('', req, true) });
  }
  if (req.method === 'GET' && url.pathname === '/api/customer/me') {
    const customer = await customerSession(req);
    return send(res, 200, { customer: customer ? publicCustomer(customer) : null });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/customer/profile') {
    try {
      const customer = await customerSession(req);
      if (!customer) return send(res, 401, { error: 'سجّل دخولك الأول.' });
      const body = await readJson(req, 8192);
      const name = String(body.name || '').trim(), phone = String(body.phone || '').trim();
      const governorate = String(body.governorate || '').trim(), city = String(body.city || '').trim();
      const address = String(body.address || '').trim(), customers = await readCustomers();
      if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'اكتب الاسم من ٢ لـ٨٠ حرف.' });
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      if (!governorate || !city || governorate.length > 60 || city.length > 80) return send(res, 400, { error: 'اختار المحافظة والمدينة.' });
      if (address.length < 8 || address.length > 500) return send(res, 400, { error: 'اكتب الشارع والعنوان بالتفصيل.' });
      if (customers.some(item => item.id !== customer.id && item.phone.replace(/\D/g, '') === phone.replace(/\D/g, ''))) return send(res, 409, { error: 'رقم التليفون مستخدم في حساب تاني.' });
      Object.assign(customer, { name, phone, governorate, city, address });
      await writeCustomers(customers);
      return send(res, 200, { ok: true, customer: publicCustomer(customer) });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر حفظ بيانات الحساب.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/shipping-rates') {
    try { return send(res, 200, { rates: await readShippingRates() }); }
    catch (_) { return send(res, 500, { error: 'تعذر تحميل أسعار الشحن.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/shipping-rates') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, { rates: await readShippingRates() }); }
    catch (_) { return send(res, 500, { error: 'تعذر تحميل أسعار الشحن.' }); }
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/shipping-rates') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const body = await readJson(req, 8192), rates = body.rates;
      if (!rates || typeof rates !== 'object' || Array.isArray(rates) || Object.keys(rates).length > 40) return send(res, 400, { error: 'بيانات أسعار الشحن غير صحيحة.' });
      for (const [governorate, price] of Object.entries(rates)) {
        if (!governorate || governorate.length > 60 || !Number.isFinite(price) || price < 0 || price > 100000) return send(res, 400, { error: 'راجع أسعار الشحن المدخلة.' });
      }
      await writeShippingRates(rates);
      return send(res, 200, { ok: true, rates });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر حفظ أسعار الشحن.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/products') {
    try { return send(res, 200, { products: (await readProducts()).filter(product => product.active !== false).map(customerProduct) }); }
    catch (_) { return send(res, 500, { error: 'حصلت مشكلة وإحنا بنقرأ المنتجات.' }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/products/')) {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/products/'.length));
      const product = findCatalogProduct(await readProducts(), id);
      if (product && product.active === false) return send(res, 404, { error: 'المنتج مش موجود أو مش متاح حاليًا.' });
      return product ? send(res, 200, { product: customerProduct(product) }) : send(res, 404, { error: 'المنتج مش موجود أو مش متاح حاليًا.' });
    } catch (_) { return send(res, 400, { error: 'تعذر قراءة المنتج.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/price-inquiries') {
    try {
      const body = await readJson(req, 8192);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      const message = String(body.message || '').trim().slice(0, 500);
      const productId = String(body.productId || '').trim();
      const product = findCatalogProduct(await readProducts(), productId);
      if (product && product.active === false) return send(res, 404, { error: 'المنتج مش متاح حاليًا.' });
      if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'اكتب اسمك من حرفين لـ٨٠ حرف.' });
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      if (!product) return send(res, 404, { error: 'المنتج مش متاح حاليًا.' });
      const inquiry = { id: 'ETI-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(), productId, product: product.name, name, phone, message, status: 'جديد', createdAt: new Date().toISOString() };
      if (USE_SUPABASE) await remoteWrite('inquiries', inquiry);
      else fs.appendFileSync(INQUIRIES, JSON.stringify(inquiry) + '\n', { mode: 0o600 });
      return send(res, 201, { ok: true, id: inquiry.id, message: 'وصل استفسارك، والمتجر هيتواصل معاك.' });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'حصلت مشكلة وإحنا بنسجل الاستفسار.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/price-inquiries') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, { inquiries: await readInquiries() }); }
    catch (_) { return send(res, 500, { error: 'حصلت مشكلة وإحنا بنقرأ الاستفسارات.' }); }
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/price-inquiries/')) {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/admin/price-inquiries/'.length));
      const body = await readJson(req, 2048);
      if (!['جديد', 'تم التواصل'].includes(body.status)) return send(res, 400, { error: 'حالة الاستفسار غير معروفة.' });
      const rows = await readInquiries();
      const inquiry = rows.find(row => row.id === id);
      if (!inquiry) return send(res, 404, { error: 'الاستفسار مش موجود.' });
      inquiry.status = body.status;
      inquiry.updatedAt = new Date().toISOString();
      await writeInquiries(rows);
      return send(res, 200, { ok: true });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تحديث الاستفسار.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/products') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, { products: await readProducts() }); }
    catch (_) { return send(res, 500, { error: 'حصلت مشكلة وإحنا بنقرأ المنتجات.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/products') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const body = await readJson(req, 8192);
      const products = await readProducts();
      const product = { id: crypto.randomUUID(), ...productInput(body) };
      if (products.some(item => item.name.toLowerCase() === product.name.toLowerCase() && item.active !== false)) return send(res, 409, { error: 'في منتج بنفس الاسم بالفعل.' });
      products.push(product);
      await writeProducts(products);
      return send(res, 201, { ok: true, product });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر إضافة المنتج.' }); }
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/products/')) {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/admin/products/'.length));
      const body = await readJson(req, 8192);
      const products = await readProducts();
      const index = products.findIndex(product => product.id === id);
      if (index < 0) return send(res, 404, { error: 'المنتج مش موجود.' });
      const updated = { ...products[index], id, ...productInput(body, products[index]) };
      if (products.some((item, i) => i !== index && item.active !== false && item.name.toLowerCase() === updated.name.toLowerCase())) return send(res, 409, { error: 'في منتج تاني بنفس الاسم بالفعل.' });
      products[index] = updated;
      await writeProducts(products);
      return send(res, 200, { ok: true, product: updated });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تعديل المنتج.' }); }
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/products/')) {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/admin/products/'.length));
      const products = await readProducts();
      const product = products.find(item => item.id === id);
      if (!product) return send(res, 404, { error: 'المنتج مش موجود.' });
      product.active = false;
      await writeProducts(products);
      return send(res, 200, { ok: true });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر إخفاء المنتج.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/orders') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, { orders: await readOrders() }); }
    catch (_) { return send(res, 500, { error: 'حصلت مشكلة وإحنا بنقرأ الطلبات.' }); }
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/orders/')) {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/orders/'.length));
      const body = await readJson(req, 2048);
      const allowed = new Set(['جديد', 'تم التأكيد', 'جاري التجهيز', 'تم الشحن', 'مكتمل', 'ملغي']);
      if (!allowed.has(body.status)) return send(res, 400, { error: 'حالة الطلب غير معروفة.' });
      const all = await readOrders();
      const order = all.find(x => x.id === id);
      if (!order) return send(res, 404, { error: 'الطلب مش موجود.' });
      const products = await readProducts();
      let inventoryChanged = false;
      const shouldRestoreInventory = order.inventoryAdjusted && (body.status === 'ملغي' || order.status === 'مكتمل' && body.status !== 'مكتمل');
      if (shouldRestoreInventory) {
        for (const item of order.items) {
          const product = products.find(entry => item.productId ? entry.id === item.productId : entry.name === item.product);
          if (product && Number.isInteger(product.stock)) product.stock += item.quantity;
        }
        order.inventoryAdjusted = false;
        inventoryChanged = true;
      }
      if (body.status === 'مكتمل' && order.status !== 'مكتمل' && !order.inventoryAdjusted) {
        for (const item of order.items) {
          const product = products.find(entry => item.productId ? entry.id === item.productId : entry.name === item.product);
          if (product && Number.isInteger(product.stock) && product.stock < item.quantity) return send(res, 409, { error: 'المخزون الحالي مش كفاية لإكمال الطلب.' });
        }
        for (const item of order.items) {
          const product = products.find(entry => item.productId ? entry.id === item.productId : entry.name === item.product);
          if (product && Number.isInteger(product.stock)) product.stock -= item.quantity;
        }
        order.inventoryAdjusted = true;
        inventoryChanged = true;
      }
      order.status = body.status;
      order.updatedAt = new Date().toISOString();
      if (inventoryChanged) await writeProducts(products);
      await writeOrders(all);
      return send(res, 200, { ok: true });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تحديث الطلب.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const seen = (rate.get(key) || []).filter(time => now - time < 60 * 60 * 1000);
    if (seen.length >= 15) return send(res, 429, { error: 'وصلنا طلبات كتير من نفس الجهاز. جرّب تاني بعد شوية.' });
    seen.push(now); rate.set(key, seen);
    try {
      const body = await readJson(req);
      const name = String(body.name || '').trim();
      const phone = String(body.phone || '').trim();
      const governorate = String(body.governorate || '').trim();
      const city = String(body.city || '').trim();
      const address = String(body.address || '').trim();
      const notes = String(body.notes || '').trim().slice(0, 500);
      if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'اكتب الاسم من ٢ لـ٨٠ حرف.' });
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      if (!governorate || governorate.length > 60 || !city || city.length > 80) return send(res, 400, { error: 'اختار المحافظة والمدينة.' });
      if (address.length < 8 || address.length > 500) return send(res, 400, { error: 'اكتب الشارع والعنوان بالتفصيل.' });
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 12) return send(res, 400, { error: 'اختار منتج واحد على الأقل.' });
      const catalog = await readProducts();
      const items = [];
      for (const item of body.items) {
        const requestedId = String(item.productId || '').trim();
        const product = (requestedId ? findCatalogProduct(catalog, requestedId) : catalog.find(entry => entry.name === String(item.product || '').trim()));
        if (product && product.active === false) return send(res, 400, { error: 'في منتج أو كمية مش صحيحة.' });
        const qty = Number(item.quantity);
        if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) return send(res, 400, { error: 'في منتج أو كمية مش صحيحة.' });
        if (Number.isInteger(product.stock) && qty > product.stock) return send(res, 409, { error: 'الكمية المطلوبة من «' + product.name + '» أكبر من المتاح.' });
        const unitPrice = product.price == null ? null : Number((product.price * (1 - (product.discount || 0) / 100)).toFixed(2));
        items.push({ productId: product.id, product: product.name, quantity: qty, unitPrice, originalUnitPrice: product.price, discountPercent: product.discount || 0 });
      }
      const total = items.every(item => Number.isFinite(item.unitPrice)) ? items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0) : null;
      const subtotal = total;
      const shippingFee = (await readShippingRates())[governorate] ?? null;
      const grandTotal = subtotal != null && shippingFee != null ? Number((subtotal + shippingFee).toFixed(2)) : null;
      const order = {
        id: 'ETS-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
        createdAt: new Date().toISOString(), status: 'جديد', name, phone, governorate, city, address, notes, items,
        subtotal, shippingFee, total: grandTotal, payment: 'السعر وطريقة الدفع يتأكدوا مع العميل قبل الشحن', inventoryAdjusted: false
      };
      if (USE_SUPABASE) await remoteWrite('orders', order);
      else fs.appendFileSync(ORDERS, JSON.stringify(order) + '\n', { mode: 0o600 });
      return send(res, 201, { ok: true, id: order.id, message: 'وصل طلبك بنجاح.' });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'حصلت مشكلة وإحنا بنسجل الطلب.' }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/products/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice('/products/'.length)));
    if (!name || name !== decodeURIComponent(url.pathname.slice('/products/'.length))) return send(res, 400, { error: 'اسم الملف غير صحيح.' });
    return sendFile(res, path.join(PRODUCTS, name));
  }
  send(res, 404, { error: 'الصفحة المطلوبة مش موجودة.' });
}

const server = http.createServer(handleRequest);

async function initializeSupabase() {
  const products = await remoteRead('products');
  if (!products.length) {
    const seedProducts = JSON.parse(fs.readFileSync(CATALOG, 'utf8').replace(/^\uFEFF/, ''));
    await remoteWrite('products', seedProducts);
  }
  const shipping = await remoteRead('shipping_rates');
  if (!shipping.length) {
    const seedRates = JSON.parse(fs.readFileSync(SHIPPING_RATES, 'utf8').replace(/^\uFEFF/, ''));
    await remoteWrite('shipping_rates', { id: 'default', rates: seedRates });
  }
  console.log('Supabase storage connected; only products and shipping rates were seeded.');
}

let supabaseInitialization;
function initializeSupabaseOnce() {
  if (!USE_SUPABASE) return Promise.resolve();
  if (!supabaseInitialization) supabaseInitialization = initializeSupabase();
  return supabaseInitialization;
}

async function startServer() {
  await initializeSupabaseOnce();
  server.listen(PORT, HOST, () => {
    console.log('Eltwenz Store شغال على http://' + HOST + ':' + PORT);
    console.log('لوحة متابعة الطلبات: http://' + HOST + ':' + PORT + '/admin');
    console.log(USE_SUPABASE ? 'بيانات المتجر محفوظة في Supabase.' : 'ملف الطلبات محفوظ محليًا داخل data/orders.jsonl');
  });
}

if (require.main === module) {
  startServer().catch(error => {
    console.error('تعذر الاتصال بـ Supabase. راجع إعدادات SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY وجدول store_records.', error.message);
    process.exitCode = 1;
  });
} else {
  module.exports = { server, handleRequest, initializeSupabaseOnce };
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRelationalStore } = require('./lib/relational-store');
const { createOneDriveStorage } = require('./lib/onedrive-storage');
const { sealSecret, openSecret } = require('./lib/secret-box');

const ROOT = __dirname;
const PRODUCTS = path.join(ROOT, 'products');
const PRODUCT_UPLOADS = path.resolve(process.env.ELTWENZ_IMAGE_UPLOAD_DIR || PRODUCTS);
const DATA = path.resolve(process.env.ELTWENZ_DATA_DIR || path.join(ROOT, 'data'));
const ORDERS = path.join(DATA, 'orders.jsonl');
const INQUIRIES = path.join(DATA, 'price-inquiries.jsonl');
const CUSTOMERS = path.join(DATA, 'customers.json');
const SHIPPING_RATES = path.join(DATA, 'shipping-rates.json');
const TOKEN_FILE = path.join(DATA, 'admin-token.txt');
const CATALOG = path.join(DATA, 'products.json');
const ONEDRIVE_TOKEN_FILE = path.join(DATA, 'onedrive-token.json');
const MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PRODUCT_REQUEST_BYTES = 8 * 1024 * 1024;
const IS_NETLIFY = Boolean(process.env.NETLIFY);
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const STORE_SCHEMA = String(process.env.STORE_SCHEMA || 'legacy').trim().toLowerCase();
const ONEDRIVE_CLIENT_ID = String(process.env.ONEDRIVE_CLIENT_ID || '').trim();
const HOSTED_RUNTIME = IS_NETLIFY || Boolean(process.env.RENDER) || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
if (!['legacy', 'relational'].includes(STORE_SCHEMA)) throw new Error('STORE_SCHEMA لازم يكون legacy أو relational.');
if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error('لازم تضبط SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY مع بعض.');
}
if (STORE_SCHEMA === 'relational' && !USE_SUPABASE) {
  throw new Error('لازم تضبط إعدادات Supabase لاستخدام STORE_SCHEMA=relational.');
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

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret && IS_NETLIFY) {
  throw new Error('لازم تضبط SESSION_SECRET في إعدادات Netlify.');
}
if (!sessionSecret) {
  const sessionSecretFile = path.join(DATA, 'session-secret.txt');
  try { sessionSecret = fs.readFileSync(sessionSecretFile, 'utf8').trim(); }
  catch (_) {
    sessionSecret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(sessionSecretFile, sessionSecret, { mode: 0o600, flag: 'wx' });
  }
}
if (sessionSecret.length < 32 || sessionSecret === adminToken) {
  throw new Error('SESSION_SECRET لازم يكون سرًا منفصلًا وقويًا لا يقل عن ٣٢ حرفًا.');
}

const relationalStore = STORE_SCHEMA === 'relational'
  ? createRelationalStore({ url: SUPABASE_URL, serviceKey: SUPABASE_SERVICE_ROLE_KEY })
  : null;

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const rate = new Map();
const authRate = new Map();
const adminAuthRate = new Map();

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
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('حجم الطلب كبير.'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(Object.assign(new Error('بيانات الطلب مش مفهومة.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function parseProductImage(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_PRODUCT_IMAGE_BYTES / 3) * 4 + 64) {
    throw Object.assign(new Error('حجم الصورة أكبر من ٥ ميجابايت.'), { status: 413 });
  }
  const match = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl);
  if (!match) throw Object.assign(new Error('اختار صورة JPG أو PNG أو WebP.'), { status: 400 });
  const encoded = match[1];
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > MAX_PRODUCT_IMAGE_BYTES || buffer.toString('base64') !== encoded) {
    throw Object.assign(new Error('حجم الصورة غير مناسب أو بياناتها غير سليمة.'), { status: buffer.length > MAX_PRODUCT_IMAGE_BYTES ? 413 : 400 });
  }
  let extension = '';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) extension = '.jpg';
  else if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) extension = '.png';
  else if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') extension = '.webp';
  if (!extension) throw Object.assign(new Error('الملف المختار مش صورة JPG أو PNG أو WebP سليمة.'), { status: 400 });
  return { buffer, extension };
}

function storeProductImage(image) {
  if (IS_NETLIFY || HOSTED_RUNTIME && !process.env.ELTWENZ_IMAGE_UPLOAD_DIR) {
    throw Object.assign(new Error('ارفع الصور على OneDrive بعد ضبط ONEDRIVE_CLIENT_ID وربط الحساب من لوحة الإدارة.'), { status: 503 });
  }
  fs.mkdirSync(PRODUCT_UPLOADS, { recursive: true });
  const name = 'upload-' + crypto.randomUUID() + image.extension;
  fs.writeFileSync(path.join(PRODUCT_UPLOADS, name), image.buffer, { flag: 'wx', mode: 0o644 });
  return name;
}

async function persistProduct(product, imageData) {
  const image = parseProductImage(imageData);
  let storedName = '';
  if (image) {
    if (ONEDRIVE_CLIENT_ID) product.image = await oneDriveStorage.uploadImage(image);
    else {
      storedName = storeProductImage(image);
      product.image = storedName;
    }
  }
  try { await saveProduct(product); }
  catch (error) {
    if (storedName) {
      try { fs.unlinkSync(path.join(PRODUCT_UPLOADS, storedName)); } catch (_) {}
    }
    throw error;
  }
  return product;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const expectedProtocol = req.socket.encrypted || forwarded === 'https' ? 'https:' : 'http:';
    return parsed.host === host && parsed.protocol === expectedProtocol;
  } catch (_) { return false; }
}

function cookieValue(req, name) {
  const prefix = name + '=';
  const raw = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : '';
}

function signedCookie(name, claims, req, maxAge, sameSite = 'Lax', clear = false) {
  const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  if (clear) return `${name}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0` + (secure ? '; Secure' : '');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${name}=${payload}.${signature}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}` + (secure ? '; Secure' : '');
}

function signedClaims(req, name) {
  const value = cookieValue(req, name);
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.exp >= Date.now() ? claims : null;
  } catch (_) { return null; }
}

function validCsrf(req, claims) {
  return Boolean(claims?.csrf && sameOrigin(req) && safeEqual(req.headers['x-csrf-token'], claims.csrf));
}

function authorized(req) {
  const claims = signedClaims(req, 'eltwenzAdmin');
  if (!claims || claims.role !== 'admin') return false;
  return !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || validCsrf(req, claims);
}

async function withinRateLimit(req, namespace, limit, windowMs, memoryStore) {
  const remoteAddress = req.socket.remoteAddress || 'unknown';
  if (relationalStore) {
    const bucket = crypto.createHmac('sha256', sessionSecret).update(`${namespace}:${remoteAddress}`).digest('base64url');
    return relationalStore.consumeRateLimit(bucket, limit, Math.ceil(windowMs / 1000));
  }
  const key = `${namespace}:${remoteAddress}`;
  const now = Date.now();
  const attempts = (memoryStore.get(key) || []).filter(time => now - time < windowMs);
  if (attempts.length >= limit) {
    memoryStore.set(key, attempts);
    return false;
  }
  attempts.push(now);
  memoryStore.set(key, attempts);
  return true;
}

async function customerSessionInfo(req) {
  const claims = signedClaims(req, 'eltwenzCustomer');
  if (!claims?.id) return { customer: null, claims: null };
  try {
    if (relationalStore) return { customer: await relationalStore.findCustomerById(claims.id), claims };
    const customers = await readCustomers();
    return { customer: customers.find(customer => customer.id === claims.id) || null, claims };
  } catch (_) { return { customer: null, claims: null }; }
}

async function findCustomerByPhone(phone) {
  const normalizedPhone = String(phone || '').replace(/\D/g, '');
  if (relationalStore) return relationalStore.findCustomerByPhone(normalizedPhone);
  return (await readCustomers()).find(customer => customer.phone.replace(/\D/g, '') === normalizedPhone) || null;
}

async function customerSession(req) {
  return (await customerSessionInfo(req)).customer;
}

function customerCookie(customerId, csrf, req, clear) {
  if (clear) return signedCookie('eltwenzCustomer', {}, req, 0, 'Lax', true);
  const maxAge = 30 * 24 * 60 * 60;
  return signedCookie('eltwenzCustomer', { id: customerId, csrf, exp: Date.now() + maxAge * 1000 }, req, maxAge);
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

function oneDriveEncryptionKey() {
  return crypto.scryptSync(sessionSecret, 'eltwenz-store:onedrive-refresh-token:v1', 32);
}

function encryptOneDriveRefreshToken(token) {
  return token ? sealSecret(String(token), oneDriveEncryptionKey()) : '';
}

function decryptOneDriveRefreshToken(value) {
  if (!value) return '';
  try { return openSecret(value, oneDriveEncryptionKey()); }
  catch (_) {
    throw Object.assign(new Error('تعذر قراءة اتصال OneDrive المشفر. اربط الحساب مرة تانية.'), { status: 409 });
  }
}

async function readOneDriveRefreshToken() {
  if (USE_SUPABASE) {
    try {
      const record = (await remoteRead('integration_secrets')).find(item => item.id === 'onedrive-refresh-token');
      return decryptOneDriveRefreshToken(record?.encryptedRefreshToken || '');
    } catch (error) {
      if (error.status) throw error;
      throw Object.assign(new Error('تعذر الوصول إلى تخزين اتصال OneDrive في Supabase.'), { status: 503 });
    }
  }
  if (HOSTED_RUNTIME) throw Object.assign(new Error('حفظ اتصال OneDrive محتاج إعداد Supabase الدائم على الاستضافة.'), { status: 503 });
  if (!fs.existsSync(ONEDRIVE_TOKEN_FILE)) return '';
  const record = JSON.parse(fs.readFileSync(ONEDRIVE_TOKEN_FILE, 'utf8'));
  return decryptOneDriveRefreshToken(record.encryptedRefreshToken || '');
}

async function writeOneDriveRefreshToken(token) {
  const record = { id: 'onedrive-refresh-token', encryptedRefreshToken: encryptOneDriveRefreshToken(token) };
  if (USE_SUPABASE) {
    try { return await remoteWrite('integration_secrets', record); }
    catch (_) { throw Object.assign(new Error('تعذر حفظ اتصال OneDrive المشفر في Supabase.'), { status: 503 }); }
  }
  if (HOSTED_RUNTIME) throw Object.assign(new Error('حفظ اتصال OneDrive محتاج إعداد Supabase الدائم على الاستضافة.'), { status: 503 });
  const temporary = ONEDRIVE_TOKEN_FILE + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporary, ONEDRIVE_TOKEN_FILE);
}

const oneDriveStorage = createOneDriveStorage({
  clientId: ONEDRIVE_CLIENT_ID,
  getRefreshToken: readOneDriveRefreshToken,
  setRefreshToken: writeOneDriveRefreshToken
});

async function readCustomers() {
  if (relationalStore) return relationalStore.readCustomers();
  if (USE_SUPABASE) return remoteRead('customers');
  if (!fs.existsSync(CUSTOMERS)) return [];
  return JSON.parse(fs.readFileSync(CUSTOMERS, 'utf8').replace(/^\uFEFF/, ''));
}

async function writeCustomers(customers) {
  if (relationalStore) return relationalStore.writeCustomers(customers);
  if (USE_SUPABASE) return remoteWrite('customers', customers);
  const tmp = CUSTOMERS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(customers, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CUSTOMERS);
}

async function readShippingRates() {
  if (relationalStore) return relationalStore.readShippingRates();
  if (USE_SUPABASE) return (await remoteRead('shipping_rates'))[0]?.rates || {};
  if (!fs.existsSync(SHIPPING_RATES)) return {};
  return JSON.parse(fs.readFileSync(SHIPPING_RATES, 'utf8').replace(/^\uFEFF/, ''));
}

async function writeShippingRates(rates) {
  if (relationalStore) return relationalStore.writeShippingRates(rates);
  if (USE_SUPABASE) return remoteWrite('shipping_rates', { id: 'default', rates });
  const tmp = SHIPPING_RATES + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rates, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SHIPPING_RATES);
}

function publicCustomer(customer) {
  return { id: customer.id, name: customer.name, phone: customer.phone, governorate: customer.governorate, city: customer.city, address: customer.address };
}

async function readOrders() {
  if (relationalStore) return relationalStore.readOrders();
  if (USE_SUPABASE) return remoteRead('orders');
  if (!fs.existsSync(ORDERS)) return [];
  return fs.readFileSync(ORDERS, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function readProducts() {
  if (relationalStore) return relationalStore.readProducts();
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
  if (relationalStore) return relationalStore.writeProducts(products);
  if (USE_SUPABASE) return remoteWrite('products', products);
  const tmp = CATALOG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(products, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CATALOG);
}

async function writeOrders(orders) {
  if (relationalStore) throw new Error('Relational orders must be changed with a transactional order operation.');
  if (USE_SUPABASE) return remoteWrite('orders', orders);
  const tmp = ORDERS + '.tmp';
  fs.writeFileSync(tmp, orders.map(order => JSON.stringify(order)).join('\n') + (orders.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, ORDERS);
}

async function readInquiries() {
  if (relationalStore) return relationalStore.readInquiries();
  if (USE_SUPABASE) return remoteRead('inquiries');
  if (!fs.existsSync(INQUIRIES)) return [];
  return fs.readFileSync(INQUIRIES, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function writeInquiries(rows) {
  if (relationalStore) return relationalStore.writeInquiries(rows);
  if (USE_SUPABASE) return remoteWrite('inquiries', rows);
  const tmp = INQUIRIES + '.tmp';
  fs.writeFileSync(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(tmp, INQUIRIES);
}

async function saveProduct(product) {
  if (relationalStore) return relationalStore.saveProduct(product);
  const products = await readProducts();
  const index = products.findIndex(item => item.id === product.id);
  if (index < 0) products.push(product);
  else products[index] = product;
  return writeProducts(products);
}

async function saveCustomer(customer) {
  if (relationalStore) return relationalStore.saveCustomer(customer);
  const customers = await readCustomers();
  const index = customers.findIndex(item => item.id === customer.id);
  if (index < 0) customers.push(customer);
  else customers[index] = customer;
  return writeCustomers(customers);
}

async function saveInquiry(inquiry) {
  if (relationalStore) return relationalStore.saveInquiry(inquiry);
  const rows = await readInquiries();
  const index = rows.findIndex(item => item.id === inquiry.id);
  if (index < 0) rows.push(inquiry);
  else rows[index] = inquiry;
  return writeInquiries(rows);
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
  if (image && !/^https:\/\//i.test(image) && !/^onedrive:[A-Za-z0-9!_-]{1,256}$/.test(image) && !/^[A-Za-z0-9_.-]+$/.test(image)) throw Object.assign(new Error('رابط الصورة لازم يبدأ بـ https أو يكون اسم ملف داخل مجلد الصور أو معرّف OneDrive صالح.'), { status: 400 });
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
  if (req.method === 'POST' && url.pathname === '/api/admin/session') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
    if (!await withinRateLimit(req, 'admin-login', 10, 60 * 60 * 1000, adminAuthRate)) return send(res, 429, { error: 'محاولات الدخول كتير. جرّب تاني بعد شوية.' });
    try {
      const body = await readJson(req, 4096);
      if (!safeEqual(body.token, adminToken)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
      const csrf = crypto.randomBytes(32).toString('base64url');
      const maxAge = 8 * 60 * 60;
      const cookie = signedCookie('eltwenzAdmin', { role: 'admin', csrf, exp: Date.now() + maxAge * 1000 }, req, maxAge, 'Strict');
      return send(res, 200, { ok: true, csrfToken: csrf }, undefined, { 'Set-Cookie': cookie });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تسجيل الدخول.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/session') {
    const claims = signedClaims(req, 'eltwenzAdmin');
    return claims?.role === 'admin'
      ? send(res, 200, { csrfToken: claims.csrf })
      : send(res, 401, { error: 'رمز الدخول غير صحيح.' });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const claims = signedClaims(req, 'eltwenzAdmin');
    if (claims?.role === 'admin' && !validCsrf(req, claims)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': signedCookie('eltwenzAdmin', {}, req, 0, 'Strict', true) });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/onedrive/status') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    if (!ONEDRIVE_CLIENT_ID) return send(res, 200, { configured: false, connected: false });
    try { return send(res, 200, await oneDriveStorage.status()); }
    catch (err) { return send(res, err.status || 503, { error: err.status ? err.message : 'تعذر قراءة إعداد اتصال OneDrive.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/onedrive/connect') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, await oneDriveStorage.startDeviceFlow()); }
    catch (err) { return send(res, err.status || 502, { error: err.status ? err.message : 'تعذر الاتصال بـMicrosoft لبدء الربط.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/onedrive/poll') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const body = await readJson(req, 2048);
      if (typeof body.sessionId !== 'string' || body.sessionId.length > 80) return send(res, 400, { error: 'جلسة تسجيل الدخول غير صحيحة.' });
      return send(res, 200, await oneDriveStorage.pollDeviceFlow(body.sessionId));
    } catch (err) { return send(res, err.status || 502, { error: err.status ? err.message : 'تعذر التحقق من تسجيل الدخول لدى Microsoft.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/onedrive/disconnect') {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try { return send(res, 200, await oneDriveStorage.disconnect()); }
    catch (err) { return send(res, err.status || 503, { error: err.status ? err.message : 'تعذر فصل اتصال OneDrive.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/customer/register') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
    if (!await withinRateLimit(req, 'customer-register', 10, 60 * 60 * 1000, authRate)) return send(res, 429, { error: 'محاولات إنشاء الحساب كتير. جرّب تاني بعد شوية.' });
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
      if (await findCustomerByPhone(phone)) return send(res, 409, { error: 'في حساب مسجل بنفس رقم التليفون. سجّل دخولك بدل إنشاء حساب جديد.' });
      const salt = crypto.randomBytes(16).toString('hex');
      const customer = { id: crypto.randomUUID(), name, phone, governorate, city, address, passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex'), createdAt: new Date().toISOString() };
      await saveCustomer(customer);
      return send(res, 201, { ok: true, customer: publicCustomer(customer) });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر إنشاء الحساب.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/customer/login') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
    if (!await withinRateLimit(req, 'customer-login', 20, 60 * 60 * 1000, authRate)) return send(res, 429, { error: 'محاولات الدخول كتير. جرّب تاني بعد شوية.' });
    try {
      const body = await readJson(req, 4096);
      const phone = String(body.phone || '').trim(), password = String(body.password || '');
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      const customer = await findCustomerByPhone(phone);
      if (!customer || !customer.passwordSalt || !customer.passwordHash) return send(res, 401, { error: 'رقم التليفون أو كلمة المرور مش صحيحة.' });
      const actual = crypto.scryptSync(password, customer.passwordSalt, 64);
      const expected = Buffer.from(customer.passwordHash, 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return send(res, 401, { error: 'رقم التليفون أو كلمة المرور مش صحيحة.' });
      const csrf = crypto.randomBytes(32).toString('base64url');
      return send(res, 200, { ok: true, customer: publicCustomer(customer), csrfToken: csrf }, undefined, { 'Set-Cookie': customerCookie(customer.id, csrf, req) });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر تسجيل الدخول.' }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/customer/logout') {
    const info = await customerSessionInfo(req);
    if (info.claims && !validCsrf(req, info.claims)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': customerCookie('', '', req, true) });
  }
  if (req.method === 'GET' && url.pathname === '/api/customer/me') {
    const info = await customerSessionInfo(req);
    return send(res, 200, { customer: info.customer ? publicCustomer(info.customer) : null, csrfToken: info.claims?.csrf || null });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/customer/profile') {
    try {
      const info = await customerSessionInfo(req);
      const customer = info.customer;
      if (!customer) return send(res, 401, { error: 'سجّل دخولك الأول.' });
      if (!validCsrf(req, info.claims)) return send(res, 403, { error: 'تعذر التحقق من الطلب.' });
      const body = await readJson(req, 8192);
      const name = String(body.name || '').trim(), phone = String(body.phone || '').trim();
      const governorate = String(body.governorate || '').trim(), city = String(body.city || '').trim();
      const address = String(body.address || '').trim();
      if (name.length < 2 || name.length > 80) return send(res, 400, { error: 'اكتب الاسم من ٢ لـ٨٠ حرف.' });
      if (phone.length < 7 || phone.length > 20 || !/^\+?[\d\s()\-]+$/.test(phone)) return send(res, 400, { error: 'راجع رقم التليفون.' });
      if (!governorate || !city || governorate.length > 60 || city.length > 80) return send(res, 400, { error: 'اختار المحافظة والمدينة.' });
      if (address.length < 8 || address.length > 500) return send(res, 400, { error: 'اكتب الشارع والعنوان بالتفصيل.' });
      const existingPhone = await findCustomerByPhone(phone);
      if (existingPhone && existingPhone.id !== customer.id) return send(res, 409, { error: 'رقم التليفون مستخدم في حساب تاني.' });
      Object.assign(customer, { name, phone, governorate, city, address });
      await saveCustomer(customer);
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
      await saveInquiry(inquiry);
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
      await saveInquiry(inquiry);
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
      const body = await readJson(req, MAX_PRODUCT_REQUEST_BYTES);
      const products = await readProducts();
      const product = { id: crypto.randomUUID(), ...productInput(body) };
      if (products.some(item => item.name.toLowerCase() === product.name.toLowerCase() && item.active !== false)) return send(res, 409, { error: 'في منتج بنفس الاسم بالفعل.' });
      await persistProduct(product, body.imageUpload);
      return send(res, 201, { ok: true, product });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'تعذر إضافة المنتج.' }); }
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/products/')) {
    if (!authorized(req)) return send(res, 401, { error: 'رمز الدخول غير صحيح.' });
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/admin/products/'.length));
      const body = await readJson(req, MAX_PRODUCT_REQUEST_BYTES);
      const products = await readProducts();
      const index = products.findIndex(product => product.id === id);
      if (index < 0) return send(res, 404, { error: 'المنتج مش موجود.' });
      const updated = { ...products[index], id, ...productInput(body, products[index]) };
      if (products.some((item, i) => i !== index && item.active !== false && item.name.toLowerCase() === updated.name.toLowerCase())) return send(res, 409, { error: 'في منتج تاني بنفس الاسم بالفعل.' });
      await persistProduct(updated, body.imageUpload);
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
      await saveProduct(product);
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
      if (relationalStore) {
        await relationalStore.setOrderStatus(id, body.status);
        return send(res, 200, { ok: true });
      }
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
    if (!await withinRateLimit(req, 'create-order', 15, 60 * 60 * 1000, rate)) return send(res, 429, { error: 'وصلنا طلبات كتير من نفس الجهاز. جرّب تاني بعد شوية.' });
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
      if (relationalStore) await relationalStore.createOrder(order);
      else if (USE_SUPABASE) await remoteWrite('orders', order);
      else fs.appendFileSync(ORDERS, JSON.stringify(order) + '\n', { mode: 0o600 });
      return send(res, 201, { ok: true, id: order.id, message: 'وصل طلبك بنجاح.' });
    } catch (err) { return send(res, err.status || 500, { error: err.message || 'حصلت مشكلة وإحنا بنسجل الطلب.' }); }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/products/')) {
    let name;
    try { name = decodeURIComponent(url.pathname.slice('/products/'.length)); }
    catch (_) { return send(res, 400, { error: 'اسم الملف غير صحيح.' }); }
    if (!name || path.basename(name) !== name) return send(res, 400, { error: 'اسم الملف غير صحيح.' });
    const uploadedImage = /^upload-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|png|webp)$/i.test(name);
    return sendFile(res, path.join(uploadedImage ? PRODUCT_UPLOADS : PRODUCTS, name));
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/product-images/')) {
    let itemId;
    try { itemId = decodeURIComponent(url.pathname.slice('/api/product-images/'.length)); }
    catch (_) { return send(res, 400, { error: 'معرّف الصورة غير صحيح.' }); }
    try {
      const imageReference = `onedrive:${itemId}`;
      const isCatalogImage = (await readProducts()).some(product => product.image === imageReference || Array.isArray(product.images) && product.images.includes(imageReference));
      if (!isCatalogImage) return send(res, 404, { error: 'صورة المنتج مش موجودة.' });
      const image = await oneDriveStorage.readImage(itemId);
      const validated = parseProductImage(`data:${image.contentType};base64,${image.buffer.toString('base64')}`);
      const contentType = validated.extension === '.jpg' ? 'image/jpeg' : validated.extension === '.png' ? 'image/png' : 'image/webp';
      if (contentType !== image.contentType) return send(res, 415, { error: 'محتوى صورة OneDrive لا يطابق نوعها.' });
      return send(res, 200, image.buffer, contentType, { 'Cache-Control': 'public, max-age=300, stale-if-error=3600' });
    } catch (err) { return send(res, err.status || 502, { error: err.status ? err.message : 'تعذر تحميل صورة المنتج من OneDrive.' }); }
  }
  send(res, 404, { error: 'الصفحة المطلوبة مش موجودة.' });
}

const server = http.createServer(handleRequest);

async function initializeSupabase() {
  if (relationalStore) {
    const products = await relationalStore.readProducts();
    if (!products.length) {
      const seedProducts = JSON.parse(fs.readFileSync(CATALOG, 'utf8').replace(/^\uFEFF/, ''));
      await relationalStore.writeProducts(seedProducts);
    }
    const shipping = await relationalStore.readShippingRates();
    if (!Object.keys(shipping).length) {
      const seedRates = JSON.parse(fs.readFileSync(SHIPPING_RATES, 'utf8').replace(/^\uFEFF/, ''));
      await relationalStore.writeShippingRates(seedRates);
    }
    console.log('Supabase relational storage connected.');
    return;
  }
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

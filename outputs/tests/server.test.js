'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eltwenz-store-test-'));
const uploadedImages = [];
const productDirectory = path.join(__dirname, '..', 'products');
const adminToken = 'test-admin-token-with-sufficient-length-123456';
process.env.ELTWENZ_DATA_DIR = dataDir;
process.env.ADMIN_TOKEN = adminToken;
process.env.SESSION_SECRET = 'separate-test-session-secret-with-sufficient-length-987654';
process.env.STORE_SCHEMA = 'legacy';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.NETLIFY;
delete process.env.RENDER;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;
delete process.env.ELTWENZ_IMAGE_UPLOAD_DIR;

fs.writeFileSync(path.join(dataDir, 'products.json'), JSON.stringify([{
  id: 'product-1', name: 'Test Watch', category: 'Electronics', description: '', badge: 'Test',
  image: 'watch.jpg', images: ['watch.jpg'], price: 100, discount: 10, stock: 3, active: true
}]));
fs.writeFileSync(path.join(dataDir, 'shipping-rates.json'), JSON.stringify({ Cairo: 25 }));

const { server } = require('../server');
let baseUrl;

test.before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  for (const imagePath of uploadedImages) fs.rmSync(imagePath, { force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function jsonRequest(url, options = {}) {
  const response = await fetch(baseUrl + url, options);
  return { response, data: await response.json() };
}

test('prices orders on the server and uses an HttpOnly admin session with CSRF protection', async () => {
  const products = await jsonRequest('/api/products');
  assert.equal(products.response.status, 200);
  assert.equal(products.data.products[0].price, 100);

  const placed = await jsonRequest('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Buyer', phone: '01000000000', governorate: 'Cairo', city: 'Nasr City', address: 'Test street number 12',
      items: [{ productId: 'product-1', quantity: 2, unitPrice: 1, total: 2 }]
    })
  });
  assert.equal(placed.response.status, 201);

  const login = await jsonRequest('/api/admin/session', {
    method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: adminToken })
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const adminCookie = cookie.split(';')[0];

  const imageStorageStatusDenied = await jsonRequest('/api/admin/image-storage/status');
  assert.equal(imageStorageStatusDenied.response.status, 401);
  const imageStorageStatus = await jsonRequest('/api/admin/image-storage/status', { headers: { Cookie: adminCookie } });
  assert.equal(imageStorageStatus.response.status, 200);
  assert.deepEqual(imageStorageStatus.data, { configured: false, bucketConfigured: false, mode: 'local' });

  const orders = await jsonRequest('/api/orders', { headers: { Cookie: adminCookie } });
  assert.equal(orders.response.status, 200);
  assert.equal(orders.data.orders[0].subtotal, 180);
  assert.equal(orders.data.orders[0].total, 205);

  const denied = await jsonRequest(`/api/orders/${encodeURIComponent(placed.data.id)}`, {
    method: 'PATCH', headers: { Cookie: adminCookie, Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'مكتمل' })
  });
  assert.equal(denied.response.status, 401);

  const completed = await jsonRequest(`/api/orders/${encodeURIComponent(placed.data.id)}`, {
    method: 'PATCH', headers: {
      Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ status: 'مكتمل' })
  });
  assert.equal(completed.response.status, 200);
  const updatedProducts = await jsonRequest('/api/products');
  assert.equal(updatedProducts.data.products[0].stock, 1);

  const uploadedProduct = await jsonRequest('/api/admin/products', {
    method: 'POST', headers: {
      Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Uploaded image test', category: 'Test', price: '10', discount: '0', stock: '1',
      imageUpload: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vWQAAAAASUVORK5CYII='
    })
  });
  assert.equal(uploadedProduct.response.status, 201);
  assert.match(uploadedProduct.data.product.image, /^upload-[a-f0-9-]+\.png$/);
  const uploadedImagePath = path.join(productDirectory, uploadedProduct.data.product.image);
  uploadedImages.push(uploadedImagePath);
  assert.equal(fs.existsSync(uploadedImagePath), true);
  const publicImage = await fetch(baseUrl + '/products/' + encodeURIComponent(uploadedProduct.data.product.image));
  assert.equal(publicImage.status, 200);
  assert.match(publicImage.headers.get('content-type'), /image\/png/);

  const editedProduct = await jsonRequest('/api/admin/products/' + encodeURIComponent(uploadedProduct.data.product.id), {
    method: 'PATCH', headers: {
      Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'Uploaded image test edited' })
  });
  assert.equal(editedProduct.response.status, 200);
  assert.equal(editedProduct.data.product.image, uploadedProduct.data.product.image);

  const rejectedImage = await jsonRequest('/api/admin/products', {
    method: 'POST', headers: {
      Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Invalid upload test', category: 'Test', imageUpload: 'data:image/png;base64,' + Buffer.from('<svg></svg>').toString('base64')
    })
  });
  assert.equal(rejectedImage.response.status, 400);
  assert.match(rejectedImage.data.error, /مش صورة/);

  const supabaseProduct = await jsonRequest('/api/admin/products', {
    method: 'POST', headers: {
      Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'Cloud image reference test', category: 'Test', image: 'https://project-ref.supabase.co/storage/v1/object/public/product-images/upload-123e4567-e89b-42d3-a456-426614174000.jpg' })
  });
  assert.equal(supabaseProduct.response.status, 201);
  assert.match(supabaseProduct.data.product.image, /\/storage\/v1\/object\/public\/product-images\//);
  const customerCatalog = await jsonRequest('/api/products');
  assert.equal(customerCatalog.data.products.find(product => product.id === supabaseProduct.data.product.id).image, supabaseProduct.data.product.image);

  const adminLogout = await jsonRequest('/api/admin/logout', {
    method: 'POST', headers: { Cookie: adminCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken }
  });
  assert.equal(adminLogout.response.status, 200);
  assert.match(adminLogout.response.headers.get('set-cookie'), /Max-Age=0/);
});

test('customer profile writes require same-origin CSRF proof and sessions use HttpOnly cookies', async () => {
  const crossOrigin = await jsonRequest('/api/customer/register', {
    method: 'POST', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(crossOrigin.response.status, 403);

  const registered = await jsonRequest('/api/customer/register', {
    method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Test Customer', phone: '01111111111', password: 'test-password-123',
      governorate: 'Cairo', city: 'Maadi', address: 'Test avenue number 123'
    })
  });
  assert.equal(registered.response.status, 201);

  const login = await jsonRequest('/api/customer/login', {
    method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '01111111111', password: 'test-password-123' })
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  const customerCookie = cookie.split(';')[0];

  const denied = await jsonRequest('/api/customer/profile', {
    method: 'PATCH', headers: { Cookie: customerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Changed Name', phone: '01111111111', governorate: 'Cairo', city: 'Maadi', address: 'Test avenue number 123' })
  });
  assert.equal(denied.response.status, 403);

  const saved = await jsonRequest('/api/customer/profile', {
    method: 'PATCH', headers: {
      Cookie: customerCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken, 'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'Changed Name', phone: '01111111111', governorate: 'Cairo', city: 'Maadi', address: 'Test avenue number 123' })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.customer.name, 'Changed Name');

  const logout = await jsonRequest('/api/customer/logout', {
    method: 'POST', headers: { Cookie: customerCookie, Origin: baseUrl, 'X-CSRF-Token': login.data.csrfToken }
  });
  assert.equal(logout.response.status, 200);
});

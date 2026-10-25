'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eltwenz-supabase-image-test-'));
const projectUrl = 'https://project-ref.supabase.co';
const serviceRoleKey = 'test-server-only-supabase-key';
const records = new Map();
const storageRequests = [];
const actualFetch = globalThis.fetch;

process.env.ELTWENZ_DATA_DIR = dataDir;
process.env.ADMIN_TOKEN = 'test-admin-token-for-supabase-image-123456';
process.env.SESSION_SECRET = 'separate-test-session-secret-for-supabase-image-123456';
process.env.STORE_SCHEMA = 'legacy';
process.env.SUPABASE_URL = projectUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey;
delete process.env.RENDER;
delete process.env.NETLIFY;
delete process.env.AWS_LAMBDA_FUNCTION_NAME;
fs.writeFileSync(path.join(dataDir, 'products.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'shipping-rates.json'), '{}');

function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = String(options.method || 'GET').toUpperCase();
  if (url.endsWith('/storage/v1/bucket/product-images')) return response(200, { id: 'product-images', public: true });
  if (url.includes('/storage/v1/object/product-images/')) {
    storageRequests.push({ url, options });
    return response(200, { Key: url.split('/').pop() });
  }
  if (url.includes('/rest/v1/store_records')) {
    const parsed = new URL(url);
    const collection = parsed.searchParams.get('collection')?.replace(/^eq\./, '') || '';
    if (method === 'GET') return response(200, records.get(collection) || []);
    if (method === 'POST') {
      const rows = JSON.parse(options.body);
      const targetCollection = rows[0]?.collection || collection;
      const current = records.get(targetCollection) || [];
      const byId = new Map(current.map(row => [row.id, row]));
      rows.forEach(row => byId.set(row.id, row));
      records.set(targetCollection, [...byId.values()]);
      return response(201);
    }
  }
  return response(404, { error: 'Not found' });
};

const { server, initializeSupabaseOnce } = require('../server');
let baseUrl;

test.before(async () => {
  await initializeSupabaseOnce();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = actualFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function request(url, options = {}) {
  const result = await actualFetch(baseUrl + url, options);
  return { response: result, data: await result.json() };
}

test('admin product upload stores bytes in Supabase and saves the public image URL', async () => {
  const login = await request('/api/admin/session', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: process.env.ADMIN_TOKEN })
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie').split(';')[0];

  const status = await request('/api/admin/image-storage/status', { headers: { Cookie: cookie } });
  assert.equal(status.response.status, 200);
  assert.deepEqual(status.data, { configured: true, bucketConfigured: true, bucketPublic: true, mode: 'supabase' });

  const product = await request('/api/admin/products', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: baseUrl,
      'X-CSRF-Token': login.data.csrfToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Cloud image integration test',
      category: 'Test',
      imageUpload: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vWQAAAAASUVORK5CYII='
    })
  });
  assert.equal(product.response.status, 201);
  assert.match(product.data.product.image, /^https:\/\/project-ref\.supabase\.co\/storage\/v1\/object\/public\/product-images\/upload-/);
  assert.equal(storageRequests.length, 1);
  assert.equal(storageRequests[0].options.headers.Authorization, 'Bearer ' + serviceRoleKey);
  assert.equal(storageRequests[0].options.headers['Content-Type'], 'image/png');

  const catalog = await request('/api/products');
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.data.products.find(item => item.id === product.data.product.id).image, product.data.product.image);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelationalStore } = require('../lib/relational-store');

function jsonResponse(payload, options = {}) {
  return new Response(JSON.stringify(payload), {
    status: options.status || 200,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
}

test('maps normalized product rows to the storefront product shape', async () => {
  const store = createRelationalStore({
    url: 'https://store.example.supabase.co/',
    serviceKey: 'test-service-key',
    fetchImpl: async () => jsonResponse([{
      id: 'p1', name: 'Watch', category: 'Electronics', description: '', badge: '', image: 'watch.jpg',
      price_egp: '550.00', stock: 3, discount_percent: '10.00', active: true,
      product_images: [{ image_url: 'two.jpg', position: 2 }, { image_url: 'one.jpg', position: 1 }]
    }], { headers: { 'Content-Range': '0-0/1' } })
  });

  const products = await store.readProducts();
  assert.equal(products[0].price, 550);
  assert.equal(products[0].discount, 10);
  assert.deepEqual(products[0].images, ['one.jpg', 'two.jpg']);
});

test('posts order status changes through the transactional database function', async () => {
  let request;
  const store = createRelationalStore({
    url: 'https://store.example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse({ id: 'ETS-1', status: 'مكتمل' });
    }
  });

  await store.setOrderStatus('ETS-1', 'مكتمل');
  assert.equal(request.url, 'https://store.example.supabase.co/rest/v1/rpc/set_store_order_status');
  assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { p_order_id: 'ETS-1', p_status: 'مكتمل' });
});

test('stores only a hashed caller bucket for persistent rate limiting', async () => {
  let request;
  const store = createRelationalStore({
    url: 'https://store.example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return jsonResponse(false);
    }
  });

  const allowed = await store.consumeRateLimit('hmac-bucket', 10, 3600);
  assert.equal(allowed, false);
  assert.equal(request.url, 'https://store.example.supabase.co/rest/v1/rpc/consume_store_rate_limit');
  assert.deepEqual(JSON.parse(request.init.body), {
    p_bucket_key: 'hmac-bucket', p_limit: 10, p_window_seconds: 3600
  });
});

test('looks up a customer by normalized phone and returns only the matching row', async () => {
  let requestedUrl;
  const store = createRelationalStore({
    url: 'https://store.example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async url => {
      requestedUrl = url;
      return jsonResponse([{
        id: 'customer-1', name: 'Test', phone: '+20 1000000000', phone_normalized: '201000000000',
        customer_addresses: []
      }]);
    }
  });

  const customer = await store.findCustomerByPhone('201000000000');
  assert.equal(customer.id, 'customer-1');
  assert.match(requestedUrl, /phone_normalized=eq\.201000000000/);
  assert.match(requestedUrl, /limit=1/);
});

test('turns a database stock conflict into a safe Egyptian Arabic API error', async () => {
  const store = createRelationalStore({
    url: 'https://store.example.supabase.co',
    serviceKey: 'test-service-key',
    fetchImpl: async () => jsonResponse({ code: 'P0001', message: 'INSUFFICIENT_STOCK' }, { status: 400 })
  });

  await assert.rejects(store.setOrderStatus('ETS-1', 'مكتمل'), error => {
    assert.equal(error.status, 409);
    assert.equal(error.message, 'المخزون الحالي مش كفاية لإكمال الطلب.');
    return true;
  });
});

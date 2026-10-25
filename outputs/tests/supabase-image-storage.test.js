'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseImageStorage } = require('../lib/supabase-image-storage');

const projectUrl = 'https://project-ref.supabase.co';
const serviceRoleKey = 'server-only-test-key';
const image = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('uploads a validated image with the server key and returns its public bucket URL', async () => {
  const requests = [];
  const storage = createSupabaseImageStorage({
    url: projectUrl,
    serviceRoleKey,
    uuid: () => '123e4567-e89b-42d3-a456-426614174000',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/storage/v1/bucket/product-images')) return response(200, { id: 'product-images', public: true });
      return response(200);
    }
  });

  const result = await storage.uploadImage({ buffer: image, extension: '.jpg' });
  assert.equal(result, projectUrl + '/storage/v1/object/public/product-images/upload-123e4567-e89b-42d3-a456-426614174000.jpg');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer ' + serviceRoleKey);
  assert.equal(requests[1].options.headers.apikey, serviceRoleKey);
  assert.equal(requests[1].options.headers['Content-Type'], 'image/jpeg');
  assert.equal(requests[1].options.headers['x-upsert'], 'false');
  assert.equal(requests[1].options.body, image);
});

test('reports an absent bucket and gives setup guidance when an upload is attempted', async () => {
  const storage = createSupabaseImageStorage({
    url: projectUrl,
    serviceRoleKey,
    fetchImpl: async () => response(404)
  });
  assert.deepEqual(await storage.status(), { configured: true, bucketConfigured: false, bucketPublic: false });
  await assert.rejects(storage.uploadImage({ buffer: image, extension: '.jpg' }), {
    status: 503,
    message: /أنشئ bucket باسم product-images/
  });
});

test('does not send requests without server credentials and rejects unsupported images', async () => {
  const unconfigured = createSupabaseImageStorage({ url: projectUrl, serviceRoleKey: '', fetchImpl: async () => { throw new Error('unexpected request'); } });
  assert.deepEqual(await unconfigured.status(), { configured: false, bucketConfigured: false });
  await assert.rejects(unconfigured.uploadImage({ buffer: image, extension: '.jpg' }), { status: 503 });

  const configured = createSupabaseImageStorage({ url: projectUrl, serviceRoleKey, fetchImpl: async () => response(200) });
  await assert.rejects(configured.uploadImage({ buffer: image, extension: '.gif' }), { status: 400 });
  await assert.rejects(configured.uploadImage({ buffer: Buffer.alloc(0), extension: '.png' }), { status: 400 });
});

test('refuses to upload when the product image bucket is private', async () => {
  const storage = createSupabaseImageStorage({
    url: projectUrl,
    serviceRoleKey,
    fetchImpl: async () => response(200, { id: 'product-images', public: false })
  });
  assert.deepEqual(await storage.status(), { configured: true, bucketConfigured: true, bucketPublic: false });
  await assert.rejects(storage.uploadImage({ buffer: image, extension: '.jpg' }), {
    status: 503,
    message: /لازم يكون Public/
  });
});

test('deletes only generated product images from the configured public bucket', async () => {
  const requests = [];
  const storage = createSupabaseImageStorage({
    url: projectUrl,
    serviceRoleKey,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(200);
    }
  });
  const validUrl = projectUrl + '/storage/v1/object/public/product-images/upload-123e4567-e89b-42d3-a456-426614174000.webp';
  assert.equal(await storage.deleteImage('https://attacker.example/storage/v1/object/public/product-images/upload-123e4567-e89b-42d3-a456-426614174000.webp'), false);
  assert.equal(await storage.deleteImage(validUrl), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[0].options.body), { prefixes: ['upload-123e4567-e89b-42d3-a456-426614174000.webp'] });
});

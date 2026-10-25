'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOneDriveStorage } = require('../lib/onedrive-storage');

const clientId = '12345678-1234-4234-8234-123456789abc';
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('device-code flow keeps device secrets server-side and uploads/proxies images through Graph', async () => {
  let now = 1_000_000;
  let refreshToken = '';
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (url.endsWith('/devicecode')) return response({
      device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 600, interval: 5
    });
    if (url.endsWith('/token') && String(options.body).includes('device_code=')) {
      if (requests.filter(request => String(request.options.body || '').includes('device_code=')).length === 1) {
        return response({ error: 'authorization_pending' }, 400);
      }
      return response({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 90 });
    }
    if (url.includes('/drive/special/approot:')) return response({ id: 'item!abc-123' });
    if (url.includes('/drive/items/item!abc-123/content')) return new Response(null, { status: 302, headers: { Location: 'https://files.1drv.com/download/image' } });
    if (url === 'https://files.1drv.com/download/image') return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { headers: { 'Content-Type': 'image/png' } });
    if (url.endsWith('/token') && String(options.body).includes('refresh_token=')) {
      return response({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
    }
    throw new Error('Unexpected test request: ' + url);
  };
  const storage = createOneDriveStorage({ clientId, getRefreshToken: async () => refreshToken, setRefreshToken: async value => { refreshToken = value; }, fetchImpl, now: () => now, uuid: () => 'fixed-id' });

  const started = await storage.startDeviceFlow();
  assert.equal(started.userCode, 'ABCD-EFGH');
  assert.equal('deviceCode' in started, false);
  assert.equal(JSON.stringify(started).includes('private-device-code'), false);
  assert.deepEqual(await storage.pollDeviceFlow(started.sessionId), { status: 'pending', retryAfter: 5 });
  now += 5_000;
  assert.deepEqual(await storage.pollDeviceFlow(started.sessionId), { status: 'pending', retryAfter: 5 });
  now += 5_000;
  assert.deepEqual(await storage.pollDeviceFlow(started.sessionId), { status: 'connected' });
  assert.equal(refreshToken, 'refresh-1');

  const reference = await storage.uploadImage({ buffer: Buffer.from('image-bytes'), extension: '.png' });
  assert.equal(reference, 'onedrive:item!abc-123');
  const uploaded = requests.find(request => request.url.includes('/drive/special/approot:'));
  assert.equal(uploaded.options.method, 'PUT');
  assert.equal(uploaded.options.headers.Authorization, 'Bearer access-1');
  assert.match(uploaded.url, /fixed-id\.png/);

  const image = await storage.readImage('item!abc-123');
  assert.equal(image.contentType, 'image/png');
  assert.deepEqual([...image.buffer], [0x89, 0x50, 0x4e, 0x47]);
  const download = requests.find(request => request.url === 'https://files.1drv.com/download/image');
  assert.equal(download.options.headers, undefined);
  assert.equal(download.options.redirect, 'error');
  assert.equal(requests.find(request => request.url.includes('/drive/items/item!abc-123/content')).options.headers.Authorization, 'Bearer access-1');

  now += 31_000;
  await Promise.all([
    storage.uploadImage({ buffer: Buffer.from('new-image-1'), extension: '.jpg' }),
    storage.uploadImage({ buffer: Buffer.from('new-image-2'), extension: '.webp' })
  ]);
  assert.equal(refreshToken, 'refresh-2');
  assert.equal(requests.filter(request => request.url.endsWith('/token')).length, 3);
});

test('rejects an untrusted download redirect and invalid image ids', async () => {
  const requests = [];
  const storage = createOneDriveStorage({
    clientId,
    getRefreshToken: async () => 'refresh-existing',
    setRefreshToken: async () => {},
    fetchImpl: async (input, options = {}) => {
      const url = String(input);
      requests.push({ url, options });
      if (url.endsWith('/token')) return response({ access_token: 'access', expires_in: 3600 });
      if (url.includes('/drive/items/')) return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/image' } });
      throw new Error('Untrusted redirect must not be fetched');
    }
  });
  await assert.rejects(storage.readImage('item123'), /مش تابع لخدمة OneDrive/);
  assert.equal(requests.length, 2);
  await assert.rejects(storage.readImage('../secret'), /معرّف الصورة غير صحيح/);
});

test('requires a valid app registration id and an account connection before image uploads', async () => {
  const unconfigured = createOneDriveStorage({ clientId: '', getRefreshToken: async () => '', setRefreshToken: async () => {}, fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(unconfigured.startDeviceFlow(), { status: 503 });
  const unconnected = createOneDriveStorage({ clientId, getRefreshToken: async () => '', setRefreshToken: async () => {}, fetchImpl: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(unconnected.uploadImage({ buffer: Buffer.from('image'), extension: '.png' }), { status: 409 });
});

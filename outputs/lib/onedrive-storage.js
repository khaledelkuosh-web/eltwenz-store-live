'use strict';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';
const OAUTH_ROOT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const IMAGE_LIMIT = 5 * 1024 * 1024;
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const ITEM_ID = /^[A-Za-z0-9!_-]{1,256}$/;

function providerError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

async function jsonResponse(response, fallback) {
  let body;
  try { body = await response.json(); } catch (_) { body = {}; }
  if (!response.ok) {
    if (body.error === 'authorization_pending') return { pending: true };
    if (body.error === 'slow_down') return { pending: true, slowDown: true };
    if (body.error === 'authorization_declined') throw providerError('تم رفض ربط حساب OneDrive.', 400);
    if (body.error === 'expired_token') throw providerError('انتهت مهلة تسجيل الدخول. ابدأ الربط مرة تانية.', 400);
    if (body.error === 'invalid_grant') throw providerError('انتهت صلاحية ربط OneDrive. اربط الحساب مرة تانية.', 409);
    throw providerError(fallback);
  }
  return body;
}

async function boundedBody(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > IMAGE_LIMIT) throw providerError('حجم صورة OneDrive أكبر من الحد المسموح.', 413);
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > IMAGE_LIMIT) throw providerError('حجم صورة OneDrive أكبر من الحد المسموح.', 413);
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks, size);
}

function createOneDriveStorage({ clientId, getRefreshToken, setRefreshToken, fetchImpl = globalThis.fetch, now = Date.now, uuid = require('node:crypto').randomUUID }) {
  let accessToken = '';
  let accessTokenExpiresAt = 0;
  let refreshPromise = null;
  const pending = new Map();

  function requireConfigured() {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(clientId || ''))) {
      throw providerError('لازم تضيف ONEDRIVE_CLIENT_ID من إعدادات الاستضافة الأول.', 503);
    }
  }

  async function postForm(url, values, fallback) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values)
    });
    return jsonResponse(response, fallback);
  }

  async function getAccessToken() {
    requireConfigured();
    if (accessToken && accessTokenExpiresAt > now() + 60_000) return accessToken;
    if (!refreshPromise) refreshPromise = (async () => {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) throw providerError('اربط حساب OneDrive من لوحة الإدارة الأول.', 409);
      const result = await postForm(`${OAUTH_ROOT}/token`, {
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'Files.ReadWrite.AppFolder offline_access'
      }, 'تعذر تجديد اتصال OneDrive. حاول ربط الحساب مرة تانية.');
      if (typeof result.access_token !== 'string' || !result.access_token) throw providerError('Microsoft لم يرجع رمز اتصال صالحًا. اربط الحساب مرة تانية.');
      accessToken = result.access_token;
      accessTokenExpiresAt = now() + Math.max(60, Number(result.expires_in) || 3600) * 1000;
      if (result.refresh_token) await setRefreshToken(result.refresh_token);
      return accessToken;
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }

  async function status() {
    requireConfigured();
    return { configured: true, connected: Boolean(await getRefreshToken()) };
  }

  async function startDeviceFlow() {
    requireConfigured();
    for (const [id, value] of pending) if (value.expiresAt <= now()) pending.delete(id);
    if (pending.size >= 4) throw providerError('في محاولات ربط كتير شغالة. استنى دقيقة وجرب تاني.', 429);
    const result = await postForm(`${OAUTH_ROOT}/devicecode`, {
      client_id: clientId,
      scope: 'Files.ReadWrite.AppFolder offline_access'
    }, 'تعذر بدء تسجيل الدخول إلى Microsoft. راجع إعداد التطبيق والصلاحيات.');
    const verificationUri = result.verification_uri;
    if (typeof result.device_code !== 'string' || !result.device_code || typeof result.user_code !== 'string' || !result.user_code) {
      throw providerError('Microsoft لم يرجع بيانات تسجيل دخول مكتملة. راجع إعداد التطبيق والصلاحيات.');
    }
    try {
      const parsed = new URL(verificationUri);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !['microsoft.com', 'microsoftonline.com'].some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) throw new Error('invalid verification URL');
    } catch (_) { throw providerError('رد Microsoft بعنوان تسجيل دخول غير متوقع.'); }
    const sessionId = uuid();
    const interval = Math.max(5, Number(result.interval) || 5);
    pending.set(sessionId, {
      deviceCode: result.device_code,
      interval,
      nextPollAt: now() + interval * 1000,
      expiresAt: now() + Math.max(60, Number(result.expires_in) || 900) * 1000,
      verificationUri,
      userCode: String(result.user_code || '').slice(0, 40)
    });
    return { sessionId, verificationUri, userCode: String(result.user_code || '').slice(0, 40), interval, expiresIn: Math.max(60, Number(result.expires_in) || 900) };
  }

  async function pollDeviceFlow(sessionId) {
    requireConfigured();
    const flow = pending.get(String(sessionId || ''));
    if (!flow) throw providerError('جلسة تسجيل الدخول انتهت. ابدأ الربط مرة تانية.', 410);
    if (flow.expiresAt <= now()) {
      pending.delete(sessionId);
      throw providerError('انتهت مهلة تسجيل الدخول. ابدأ الربط مرة تانية.', 410);
    }
    if (now() < flow.nextPollAt) return { status: 'pending', retryAfter: Math.ceil((flow.nextPollAt - now()) / 1000) };
    flow.nextPollAt = now() + flow.interval * 1000;
    let result;
    try {
      result = await postForm(`${OAUTH_ROOT}/token`, {
        client_id: clientId,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: flow.deviceCode
      }, 'تعذر إكمال تسجيل الدخول إلى Microsoft.');
    } catch (error) {
      if (error.message === 'تم رفض ربط حساب OneDrive.' || error.message.startsWith('انتهت مهلة تسجيل الدخول')) pending.delete(sessionId);
      throw error;
    }
    if (result.pending) {
      if (result.slowDown) flow.interval += 5;
      return { status: 'pending', retryAfter: flow.interval };
    }
    if (!result.access_token || !result.refresh_token) throw providerError('Microsoft لم يرجع رمز اتصال صالحًا. راجع صلاحية Files.ReadWrite.AppFolder.');
    await setRefreshToken(result.refresh_token);
    accessToken = result.access_token;
    accessTokenExpiresAt = now() + Math.max(60, Number(result.expires_in) || 3600) * 1000;
    pending.delete(sessionId);
    return { status: 'connected' };
  }

  async function disconnect() {
    await setRefreshToken('');
    accessToken = '';
    accessTokenExpiresAt = 0;
    refreshPromise = null;
    pending.clear();
    return { configured: true, connected: false };
  }

  async function uploadImage({ buffer, extension }) {
    requireConfigured();
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > IMAGE_LIMIT || !IMAGE_MIME[extension]) {
      throw providerError('بيانات الصورة غير صالحة.', 400);
    }
    const token = await getAccessToken();
    const name = `${uuid()}${extension}`;
    const response = await fetchImpl(`${GRAPH_ROOT}/me/drive/special/approot:/${name}:/content`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': IMAGE_MIME[extension] },
      body: buffer
    });
    const item = await jsonResponse(response, 'تعذر رفع الصورة إلى OneDrive.');
    if (typeof item.id !== 'string' || !ITEM_ID.test(item.id)) throw providerError('Microsoft لم يرجع معرّف صورة صالحًا.');
    return `onedrive:${item.id}`;
  }

  async function readImage(itemId) {
    requireConfigured();
    if (!ITEM_ID.test(String(itemId || ''))) throw providerError('معرّف الصورة غير صحيح.', 404);
    const token = await getAccessToken();
    const graphResponse = await fetchImpl(`${GRAPH_ROOT}/me/drive/items/${encodeURIComponent(itemId)}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'manual'
    });
    let response = graphResponse;
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      let downloadUrl;
      try { downloadUrl = new URL(location); } catch (_) { throw providerError('Microsoft رجع عنوان صورة غير صالح.'); }
      const allowedHost = /(?:^|\.)1drv\.com$/i.test(downloadUrl.hostname) || /(?:^|\.)sharepoint\.com$/i.test(downloadUrl.hostname);
      if (downloadUrl.protocol !== 'https:' || !allowedHost) throw providerError('عنوان تنزيل الصورة مش تابع لخدمة OneDrive.');
      response = await fetchImpl(downloadUrl, { redirect: 'error' });
    }
    if (!response.ok) throw providerError('تعذر تحميل صورة المنتج من OneDrive.');
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!Object.values(IMAGE_MIME).includes(contentType)) throw providerError('نوع صورة OneDrive غير مدعوم.', 415);
    const buffer = await boundedBody(response);
    if (!buffer.length) throw providerError('صورة OneDrive فاضية.', 404);
    return { buffer, contentType };
  }

  return { status, startDeviceFlow, pollDeviceFlow, disconnect, uploadImage, readImage };
}

module.exports = { createOneDriveStorage };

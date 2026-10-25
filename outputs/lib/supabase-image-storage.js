'use strict';

const BUCKET = 'product-images';
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storageError(message, status = 503) {
  return Object.assign(new Error(message), { status });
}

function createSupabaseImageStorage({ url, serviceRoleKey, fetchImpl = globalThis.fetch, uuid = require('node:crypto').randomUUID }) {
  let projectUrl = '';
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) projectUrl = parsed.origin;
  } catch (_) {}
  const configured = Boolean(projectUrl && String(serviceRoleKey || '').trim());

  function headers(extra) {
    return {
      apikey: serviceRoleKey,
      Authorization: 'Bearer ' + serviceRoleKey,
      ...(extra || {})
    };
  }

  async function status() {
    if (!configured) return { configured: false, bucketConfigured: false };
    let response;
    try {
      response = await fetchImpl(projectUrl + '/storage/v1/bucket/' + BUCKET, { headers: headers() });
    } catch (_) {
      throw storageError('تعذر الاتصال بتخزين الصور في Supabase. راجع إعدادات المشروع وحاول تاني.');
    }
    if (response.status === 404) return { configured: true, bucketConfigured: false, bucketPublic: false };
    if (!response.ok) throw storageError('تعذر التحقق من مخزن الصور. راجع مفتاح Supabase وصلاحياته.');
    let bucket = {};
    try { bucket = await response.json(); } catch (_) {}
    return { configured: true, bucketConfigured: bucket.id === BUCKET, bucketPublic: bucket.public === true };
  }

  async function uploadImage({ buffer, extension }) {
    if (!configured) throw storageError('ارفع الصور على الاستضافة بعد إعداد Supabase Storage.');
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > 5 * 1024 * 1024 || !IMAGE_MIME[extension]) {
      throw storageError('بيانات الصورة غير صالحة.', 400);
    }
    const bucket = await status();
    if (!bucket.bucketConfigured) throw storageError('مخزن صور Supabase مش متجهز. أنشئ bucket باسم product-images ثم جرّب تاني.');
    if (!bucket.bucketPublic) throw storageError('مخزن الصور لازم يكون Public عشان صور المنتجات تظهر للزوار.');
    const id = String(uuid());
    if (!UUID.test(id)) throw storageError('تعذر إنشاء اسم آمن لصورة المنتج.');
    const name = 'upload-' + id + extension;
    let response;
    try {
      response = await fetchImpl(projectUrl + '/storage/v1/object/' + BUCKET + '/' + name, {
        method: 'POST',
        headers: headers({
          'Content-Type': IMAGE_MIME[extension],
          'Cache-Control': 'public, max-age=31536000, immutable',
          'x-upsert': 'false'
        }),
        body: buffer
      });
    } catch (_) {
      throw storageError('تعذر رفع الصورة إلى Supabase Storage. حاول تاني.');
    }
    if (!response.ok) {
      if (response.status === 404) throw storageError('مخزن صور Supabase مش متجهز. أنشئ bucket باسم product-images ثم جرّب تاني.');
      if (response.status === 401 || response.status === 403) throw storageError('مفتاح Supabase مرفوض. راجع إعداد SUPABASE_SERVICE_ROLE_KEY في الاستضافة.');
      throw storageError('تعذر رفع الصورة إلى Supabase Storage. راجع مساحة التخزين وحاول تاني.');
    }
    return projectUrl + '/storage/v1/object/public/' + BUCKET + '/' + name;
  }

  async function deleteImage(publicUrl) {
    if (!configured) return false;
    let parsed;
    try { parsed = new URL(String(publicUrl || '')); } catch (_) { return false; }
    const prefix = '/storage/v1/object/public/' + BUCKET + '/';
    if (parsed.origin !== projectUrl || !parsed.pathname.startsWith(prefix)) return false;
    const name = decodeURIComponent(parsed.pathname.slice(prefix.length));
    if (!/^upload-[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(name)) return false;
    try {
      const response = await fetchImpl(projectUrl + '/storage/v1/object/' + BUCKET, {
        method: 'DELETE',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: [name] })
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }

  return { configured, status, uploadImage, deleteImage };
}

module.exports = { createSupabaseImageStorage };

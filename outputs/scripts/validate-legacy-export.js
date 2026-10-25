#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ORDER_STATUSES = new Set(['جديد', 'تم التأكيد', 'جاري التجهيز', 'تم الشحن', 'مكتمل', 'ملغي']);
const INQUIRY_STATUSES = new Set(['جديد', 'تم التواصل']);

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function recordsFrom(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.records)) return input.records;
  if (Array.isArray(input?.store_records)) return input.store_records;

  const rows = [];
  for (const collection of ['products', 'customers', 'orders', 'inquiries']) {
    if (Array.isArray(input?.[collection])) {
      for (const payload of input[collection]) rows.push({ collection, id: payload?.id, payload });
    }
  }
  if (input?.shipping_rates && typeof input.shipping_rates === 'object') {
    rows.push({ collection: 'shipping_rates', id: 'default', payload: input.shipping_rates });
  }
  return rows;
}

function validateExport(input) {
  const groups = {
    products: [], customers: [], orders: [], inquiries: [], shippingRates: []
  };
  const counts = { products: 0, customers: 0, orders: 0, inquiries: 0, shippingRates: 0 };
  const issues = {};
  const report = code => { issues[code] = (issues[code] || 0) + 1; };
  const customerIdsByPhone = new Map();

  for (const row of recordsFrom(input)) {
    const collection = String(row?.collection || '');
    const payload = row?.payload;
    if (!['products', 'customers', 'orders', 'inquiries', 'shipping_rates'].includes(collection)) {
      report('unknown_collection');
      continue;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      report(`${collection}_invalid_payload`);
      continue;
    }

    if (collection === 'products') {
      const id = String(payload.id || row.id || '');
      const price = payload.price == null || payload.price === '' ? null : Number(payload.price);
      const basePrice = payload.basePrice == null || payload.basePrice === '' ? null : Number(payload.basePrice);
      const sourceListedPrice = payload.sourceListedPrice == null || payload.sourceListedPrice === '' ? null : Number(payload.sourceListedPrice);
      const sourceListedDiscount = payload.sourceListedDiscount == null || payload.sourceListedDiscount === '' ? null : Number(payload.sourceListedDiscount);
      const stock = payload.stock == null || payload.stock === '' ? null : Number(payload.stock);
      const discount = Number(payload.discount || 0);
      if (!id || typeof payload.name !== 'string' || payload.name.trim().length < 2 || !String(payload.category || '').trim()) {
        report('products_invalid_required_fields');
        continue;
      }
      if (price !== null && (!Number.isFinite(price) || price < 0 || price > 100000000)) report('products_invalid_price');
      if (basePrice !== null && (!Number.isFinite(basePrice) || basePrice < 0 || basePrice > 100000000)) report('products_invalid_base_price');
      if (sourceListedPrice !== null && (!Number.isFinite(sourceListedPrice) || sourceListedPrice < 0 || sourceListedPrice > 100000000)) report('products_invalid_source_listed_price');
      if (sourceListedDiscount !== null && (!Number.isFinite(sourceListedDiscount) || sourceListedDiscount < 0 || sourceListedDiscount > 100)) report('products_invalid_source_listed_discount');
      if (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 10000000)) report('products_invalid_stock');
      if (!Number.isFinite(discount) || discount < 0 || discount > 100) report('products_invalid_discount');
      const images = Array.isArray(payload.images) ? payload.images : [];
      groups.products.push({
        id, name: payload.name.trim(), category: String(payload.category).trim(),
        description: String(payload.description || ''), badge: String(payload.badge || ''),
        image: String(payload.image || ''), images,
        basePrice,
        source: String(payload.source || ''),
        sourceListedPrice,
        sourceListedDiscount,
        price, stock, discount, active: payload.active !== false,
        createdAt: payload.createdAt || null, updatedAt: payload.updatedAt || null
      });
      continue;
    }

    if (collection === 'customers') {
      const id = String(payload.id || row.id || '');
      const phone = String(payload.phone || '');
      const phoneNormalized = normalizePhone(phone);
      if (!id || String(payload.name || '').trim().length < 2 || phoneNormalized.length < 7) {
        report('customers_invalid_required_fields');
        continue;
      }
      if (!payload.passwordSalt || !payload.passwordHash) report('customers_missing_password_hash');
      const customer = { ...payload, id, phone, phoneNormalized };
      groups.customers.push(customer);
      if (customerIdsByPhone.has(phoneNormalized)) report('customers_duplicate_phone');
      else customerIdsByPhone.set(phoneNormalized, id);
      continue;
    }

    if (collection === 'orders') {
      const id = String(payload.id || row.id || '');
      const items = Array.isArray(payload.items) ? payload.items : [];
      if (!id || String(payload.name || '').trim().length < 2 || normalizePhone(payload.phone).length < 7 || items.length === 0) {
        report('orders_invalid_required_fields');
        continue;
      }
      if (!ORDER_STATUSES.has(payload.status || 'جديد')) report('orders_invalid_status');
      for (const item of items) {
        if (!item || !Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 20) {
          report('orders_invalid_item_quantity');
        }
      }
      groups.orders.push({
        ...payload,
        id,
        customerId: customerIdsByPhone.get(normalizePhone(payload.phone)) || null,
        status: payload.status || 'جديد',
        inventoryAdjusted: Boolean(payload.inventoryAdjusted),
        items
      });
      continue;
    }

    if (collection === 'inquiries') {
      const id = String(payload.id || row.id || '');
      if (!id || String(payload.name || '').trim().length < 2 || normalizePhone(payload.phone).length < 7) {
        report('inquiries_invalid_required_fields');
        continue;
      }
      if (!INQUIRY_STATUSES.has(payload.status || 'جديد')) report('inquiries_invalid_status');
      groups.inquiries.push({ ...payload, id, status: payload.status || 'جديد' });
      continue;
    }

    const rates = payload.rates && typeof payload.rates === 'object' ? payload.rates : payload;
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
      report('shipping_rates_invalid_payload');
      continue;
    }
    for (const [governorate, fee] of Object.entries(rates)) {
      if (!governorate || fee == null || !Number.isFinite(Number(fee)) || Number(fee) < 0 || Number(fee) > 100000) {
        report('shipping_rates_invalid_value');
      }
      groups.shippingRates.push({ governorate, feeEgp: Number(fee) });
    }
  }

  for (const order of groups.orders) {
    order.customerId = customerIdsByPhone.get(normalizePhone(order.phone)) || null;
  }

  for (const key of Object.keys(counts)) counts[key] = groups[key].length;
  return { ok: Object.keys(issues).length === 0, counts, issues, data: groups };
}

function main(argv) {
  const inputIndex = argv.indexOf('--input');
  const inputPath = inputIndex >= 0 ? argv[inputIndex + 1] : '';
  if (!inputPath || inputPath.startsWith('--')) {
    process.stderr.write('Usage: node scripts/validate-legacy-export.js --input <export.json>\n');
    return 2;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
  } catch (_) {
    process.stderr.write('Could not read a valid JSON export. No data was changed.\n');
    return 2;
  }

  const result = validateExport(input);
  process.stdout.write(JSON.stringify({ ok: result.ok, counts: result.counts, issues: result.issues }) + '\n');
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { normalizePhone, recordsFrom, validateExport, main };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExport, normalizePhone } = require('../scripts/validate-legacy-export');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('normalizes phone values without retaining punctuation', () => {
  assert.equal(normalizePhone('+20 (10) 1234-5678'), '201012345678');
});

test('validates all supported legacy collections and counts only records', () => {
  const result = validateExport({
    records: [
      { collection: 'products', id: 'p1', payload: { name: 'Watch', category: 'Electronics', price: 500, stock: 4, discount: 10 } },
      { collection: 'customers', id: 'c1', payload: { name: 'Test Customer', phone: '+20 1000000000', passwordSalt: 'salt', passwordHash: 'hash' } },
      { collection: 'orders', id: 'o1', payload: { name: 'Test Customer', phone: '+20 1000000000', status: 'جديد', items: [{ productId: 'p1', quantity: 1 }] } },
      { collection: 'inquiries', id: 'i1', payload: { name: 'Test Customer', phone: '+20 1000000000', status: 'جديد' } },
      { collection: 'shipping_rates', id: 'default', payload: { rates: { Cairo: 45 } } }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, { products: 1, customers: 1, orders: 1, inquiries: 1, shippingRates: 1 });
  assert.deepEqual(result.issues, {});
  assert.equal(result.data.orders[0].customerId, 'c1');
  assert.equal(result.data.shippingRates[0].feeEgp, 45);
});

test('reports validation issue codes without echoing customer data', () => {
  const result = validateExport({
    records: [{ collection: 'customers', id: 'secret-id', payload: { name: 'X', phone: '012', address: 'private address' } }]
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.customers_invalid_required_fields, 1);
  assert.equal(JSON.stringify(result.issues).includes('private address'), false);
  assert.equal(JSON.stringify(result.issues).includes('secret-id'), false);
});

test('validates retained legacy price metadata against database constraints', () => {
  const result = validateExport({ records: [{
    collection: 'products', id: 'p1', payload: {
      name: 'Watch', category: 'Electronics', price: 100,
      basePrice: -1, sourceListedPrice: 'invalid', sourceListedDiscount: 101
    }
  }] });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues, {
    products_invalid_base_price: 1,
    products_invalid_source_listed_price: 1,
    products_invalid_source_listed_discount: 1
  });
});

test('dry-run CLI prints summary counts without echoing record data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eltwenz-export-test-'));
  const inputPath = path.join(directory, 'export.json');
  try {
    fs.writeFileSync(inputPath, JSON.stringify({ records: [{
      collection: 'customers', id: 'private-customer-id',
      payload: { id: 'private-customer-id', name: 'Private Test Name', phone: '01099998888', passwordSalt: 'salt', passwordHash: 'hash' }
    }] }));
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/validate-legacy-export.js'), '--input', inputPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"customers":1/);
    assert.doesNotMatch(result.stdout, /private-customer-id|Private Test Name|01099998888|passwordHash/);
  } finally {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const resolvedDirectory = path.resolve(directory);
    assert.ok(resolvedDirectory.startsWith(tempRoot), 'temporary export directory escaped the system temp directory');
    fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  }
});

test('relational migration enables RLS and limits table/function access to service_role', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/001_relational_schema.sql'), 'utf8');
  assert.match(migration, /alter table public\.customers enable row level security/i);
  assert.match(migration, /alter table public\.store_rate_limits enable row level security/i);
  assert.match(migration, /from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete on table[\s\S]*to service_role/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /revoke all on function public\.set_store_order_status[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.set_store_order_status[\s\S]*to service_role/i);
  assert.match(migration, /for update/i);
  assert.match(migration, /function public\.consume_store_rate_limit/i);
});

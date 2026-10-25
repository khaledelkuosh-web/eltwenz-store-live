'use strict';

function storeError(status = 500, code = 'STORE_ERROR') {
  const messages = {
    INSUFFICIENT_STOCK: 'المخزون الحالي مش كفاية لإكمال الطلب.',
    ORDER_NOT_FOUND: 'الطلب مش موجود.',
    PRODUCT_NOT_FOUND: 'المنتج مش موجود أو مش متاح حاليًا.',
    CUSTOMER_CONFLICT: 'في حساب مسجل بنفس رقم التليفون.',
    INVALID_ORDER: 'بيانات الطلب غير صحيحة.'
  };
  const err = new Error(messages[code] || 'تعذر حفظ بيانات المتجر.');
  err.status = status;
  err.code = code;
  return err;
}

function mapDatabaseError(payload, status) {
  const code = String(payload?.message || '').split(/\s|:/, 1)[0];
  if (code === 'INSUFFICIENT_STOCK') return storeError(409, code);
  if (code === 'ORDER_NOT_FOUND' || payload?.code === 'P0002') return storeError(404, code === 'ORDER_NOT_FOUND' ? code : 'ORDER_NOT_FOUND');
  if (code === 'PRODUCT_NOT_FOUND') return storeError(404, code);
  if (code === 'INVALID_ORDER' || code === 'INVALID_ORDER_ITEM' || payload?.code === '22023') return storeError(400, code === 'INVALID_ORDER' ? code : 'INVALID_ORDER');
  if (payload?.code === '23505') return storeError(409, 'CUSTOMER_CONFLICT');
  return storeError(status >= 500 ? 500 : status);
}

function toProduct(row) {
  const images = Array.isArray(row.product_images)
    ? row.product_images.slice().sort((a, b) => a.position - b.position).map(image => image.image_url)
    : [];
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description || '',
    badge: row.badge || '',
    image: row.image || '',
    images,
    price: row.price_egp == null ? null : Number(row.price_egp),
    basePrice: row.base_price_egp == null ? null : Number(row.base_price_egp),
    source: row.source || '',
    sourceListedPrice: row.source_listed_price_egp == null ? null : Number(row.source_listed_price_egp),
    sourceListedDiscount: row.source_listed_discount == null ? null : Number(row.source_listed_discount),
    stock: row.stock == null ? null : Number(row.stock),
    discount: Number(row.discount_percent || 0),
    active: row.active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toCustomer(row) {
  const address = (row.customer_addresses || []).find(item => item.is_default) || row.customer_addresses?.[0] || {};
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    governorate: address.governorate || '',
    city: address.city || '',
    address: address.address || '',
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toOrder(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    name: row.customer_name,
    phone: row.customer_phone,
    governorate: row.governorate,
    city: row.city,
    address: row.address,
    notes: row.notes || '',
    items: (row.order_items || []).map(item => ({
      productId: item.product_id,
      product: item.product_name,
      quantity: Number(item.quantity),
      unitPrice: item.unit_price_egp == null ? null : Number(item.unit_price_egp),
      originalUnitPrice: item.original_unit_price_egp == null ? null : Number(item.original_unit_price_egp),
      discountPercent: Number(item.discount_percent || 0)
    })),
    subtotal: row.subtotal_egp == null ? null : Number(row.subtotal_egp),
    shippingFee: row.shipping_fee_egp == null ? null : Number(row.shipping_fee_egp),
    total: row.total_egp == null ? null : Number(row.total_egp),
    payment: row.payment_note,
    inventoryAdjusted: Boolean(row.inventory_adjusted)
  };
}

function toInquiry(row) {
  return {
    id: row.id,
    productId: row.product_id,
    product: row.product_name,
    name: row.customer_name,
    phone: row.customer_phone,
    message: row.message || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createRelationalStore({ url, serviceKey, fetchImpl = globalThis.fetch }) {
  const baseUrl = String(url || '').replace(/\/$/, '');
  if (!baseUrl || !serviceKey) throw new Error('Supabase URL and service key are required.');

  async function request(path, options = {}) {
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(options.headers || {})
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${baseUrl}/rest/v1/${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (_) {
      throw storeError(503);
    }

    let payload = null;
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw mapDatabaseError(payload, response.status);
    return { payload, response };
  }

  async function rpc(name, params) {
    return (await request(`rpc/${name}`, { method: 'POST', body: params })).payload;
  }

  async function rows(path) {
    const result = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { payload, response } = await request(path, {
        headers: { Range: `${offset}-${offset + pageSize - 1}`, 'Range-Unit': 'items' }
      });
      if (!Array.isArray(payload)) throw storeError(500);
      result.push(...payload);
      if (payload.length < pageSize) return result;
      const range = response.headers?.get?.('content-range') || '';
      const total = Number(range.split('/')[1]);
      if (Number.isFinite(total) && offset + payload.length >= total) return result;
    }
  }

  return {
    async readProducts() {
      return (await rows('products?select=*,product_images(image_url,position)&order=id.asc')).map(toProduct);
    },
    async writeProducts(products) {
      await rpc('upsert_store_products', { p_products: products });
    },
    async saveProduct(product) {
      await rpc('upsert_store_product', { p_product: product });
    },
    async readCustomers() {
      return (await rows('customers?select=*,customer_addresses(governorate,city,address,is_default,updated_at)&order=id.asc')).map(toCustomer);
    },
    async findCustomerById(id) {
      const found = await rows(`customers?select=*,customer_addresses(governorate,city,address,is_default,updated_at)&id=eq.${encodeURIComponent(id)}&limit=1`);
      return found[0] ? toCustomer(found[0]) : null;
    },
    async findCustomerByPhone(phoneNormalized) {
      const found = await rows(`customers?select=*,customer_addresses(governorate,city,address,is_default,updated_at)&phone_normalized=eq.${encodeURIComponent(phoneNormalized)}&limit=1`);
      return found[0] ? toCustomer(found[0]) : null;
    },
    async writeCustomers(customers) {
      for (const customer of customers) await rpc('upsert_store_customer', { p_customer: customer });
    },
    async saveCustomer(customer) {
      await rpc('upsert_store_customer', { p_customer: customer });
    },
    async readShippingRates() {
      const rates = {};
      for (const row of await rows('shipping_rates?select=governorate,fee_egp&order=governorate.asc')) {
        rates[row.governorate] = Number(row.fee_egp);
      }
      return rates;
    },
    async writeShippingRates(rates) {
      await rpc('replace_store_shipping_rates', { p_rates: rates });
    },
    async readOrders() {
      return (await rows('orders?select=*,order_items(product_id,product_name,quantity,unit_price_egp,original_unit_price_egp,discount_percent)&order=created_at.asc')).map(toOrder);
    },
    async createOrder(order) {
      return rpc('create_store_order', { p_order: order });
    },
    async setOrderStatus(orderId, status) {
      return rpc('set_store_order_status', { p_order_id: orderId, p_status: status });
    },
    async consumeRateLimit(bucketKey, limit, windowSeconds) {
      return rpc('consume_store_rate_limit', {
        p_bucket_key: bucketKey,
        p_limit: limit,
        p_window_seconds: windowSeconds
      });
    },
    async readInquiries() {
      return (await rows('price_inquiries?select=*&order=created_at.asc')).map(toInquiry);
    },
    async writeInquiries(inquiries) {
      for (const inquiry of inquiries) await rpc('upsert_store_inquiry', { p_inquiry: inquiry });
    },
    async saveInquiry(inquiry) {
      await rpc('upsert_store_inquiry', { p_inquiry: inquiry });
    }
  };
}

module.exports = { createRelationalStore, toProduct, toCustomer, toOrder, toInquiry };

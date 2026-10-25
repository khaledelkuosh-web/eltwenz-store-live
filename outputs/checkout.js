(function () {
  const cart = new Map();
  const cartButton = document.getElementById('cartOpen');
  const count = document.getElementById('count');
  const dialog = document.createElement('dialog');
  dialog.className = 'checkout-dialog';
  dialog.id = 'checkout';
  dialog.innerHTML = '<div class="checkout-top"><div><h2>بيانات التوصيل</h2><p>راجع منتجاتك واكتب بياناتك عشان نبعت الطلب للمتجر.</p></div><button type="button" class="close-checkout" aria-label="إغلاق">×</button></div><div class="cart-lines"></div><form><label>الاسم بالكامل<input name="name" required minlength="2" maxlength="80" autocomplete="name" placeholder="اكتب اسمك"></label><label>رقم التليفون<input name="phone" type="tel" inputmode="tel" required minlength="7" maxlength="20" autocomplete="tel" placeholder="01xxxxxxxxx"></label><label>المحافظة<select name="governorate" required><option value="">اختار المحافظة</option></select></label><label>المدينة / المركز<select name="city" required disabled><option value="">اختار المحافظة الأول</option></select></label><label name="otherCityLabel" hidden>اكتب المدينة أو المركز<input name="otherCity" maxlength="80" placeholder="اكتب اسم المدينة أو القرية"></label><label>الشارع والعنوان بالتفصيل<textarea name="address" required minlength="8" maxlength="500" autocomplete="street-address" placeholder="الشارع، رقم العمارة والشقة، وأقرب علامة مميزة"></textarea></label><label>ملاحظات للطلب (اختياري)<textarea name="notes" maxlength="500" placeholder="اللون أو المقاس"></textarea></label><button class="cta submit-order" type="submit">إرسال الطلب</button><div class="order-result" role="status"></div></form>';
  document.body.appendChild(dialog);
  const form = dialog.querySelector('form');
  const result = dialog.querySelector('.order-result');
  const lines = dialog.querySelector('.cart-lines');
  const locations = {
    'القاهرة':['مدينة نصر','مصر الجديدة','المعادي','القاهرة الجديدة','شبرا','حلوان','عين شمس','المطرية','وسط البلد','المرج','مدينة بدر','الشروق'],
    'الجيزة':['الجيزة','6 أكتوبر','الشيخ زايد','الهرم','فيصل','حدائق الأهرام','إمبابة','الدقي','العجوزة','أوسيم','كرداسة','البدرشين','الصف','أطفيح'],
    'الإسكندرية':['الإسكندرية','المنتزه','سيدي جابر','سموحة','محرم بك','العجمي','العامرية','برج العرب'],
    'الدقهلية':['المنصورة','طلخا','ميت غمر','أجا','السنبلاوين','دكرنس','منية النصر','بلقاس','شربين','نبروه'],
    'البحر الأحمر':['الغردقة','رأس غارب','سفاجا','القصير','مرسى علم','الشلاتين','حلايب'],
    'البحيرة':['دمنهور','كفر الدوار','رشيد','إدكو','أبو المطامير','أبو حمص','الدلنجات','حوش عيسى','كوم حمادة','إيتاي البارود'],
    'الفيوم':['الفيوم','سنورس','إطسا','طامية','أبشواي','يوسف الصديق'],
    'الغربية':['طنطا','المحلة الكبرى','كفر الزيات','زفتى','سمنود','قطور','بسيون','السنطة'],
    'الإسماعيلية':['الإسماعيلية','فايد','القنطرة شرق','القنطرة غرب','التل الكبير','أبو صوير','القصاصين'],
    'المنوفية':['شبين الكوم','منوف','أشمون','تلا','قويسنا','بركة السبع','الباجور','السادات'],
    'المنيا':['المنيا','ملوي','مغاغة','بني مزار','سمالوط','أبو قرقاص','دير مواس','مطاي','العدوة'],
    'القليوبية':['بنها','شبرا الخيمة','قليوب','قها','طوخ','الخانكة','الخصوص','العبور','شبين القناطر','كفر شكر'],
    'الوادي الجديد':['الخارجة','الداخلة','الفرافرة','باريس','بلاط'],
    'شمال سيناء':['العريش','بئر العبد','الشيخ زويد','رفح','الحسنة','نخل'],
    'السويس':['السويس','الأربعين','عتاقة','الجناين','فيصل'],
    'جنوب سيناء':['شرم الشيخ','الطور','دهب','نويبع','طابا','سانت كاترين','أبو رديس','أبو زنيمة','رأس سدر'],
    'بورسعيد':['بورسعيد','بورفؤاد'],
    'دمياط':['دمياط','دمياط الجديدة','رأس البر','فارسكور','كفر سعد','الزرقا','عزبة البرج'],
    'أسيوط':['أسيوط','ديروط','القوصية','منفلوط','أبنوب','أبو تيج','الغنايم','ساحل سليم','البداري','صدفا'],
    'سوهاج':['سوهاج','أخميم','جرجا','طهطا','المراغة','البلينا','المنشأة','دار السلام','جهينة'],
    'قنا':['قنا','نجع حمادي','دشنا','قفط','قوص','أبو تشت','فرشوط','نقادة'],
    'الأقصر':['الأقصر','إسنا','أرمنت','القرنة','البياضية','الزينية','الطود'],
    'أسوان':['أسوان','كوم أمبو','إدفو','دراو','أبو سمبل'],
    'بني سويف':['بني سويف','الواسطى','ناصر','إهناسيا','ببا','سمسطا','الفشن'],
    'الشرقية':['الزقازيق','العاشر من رمضان','بلبيس','منيا القمح','أبو حماد','فاقوس','ههيا','أبو كبير','ديرب نجم','كفر صقر','الحسينية'],
    'كفر الشيخ':['كفر الشيخ','دسوق','فوه','مطوبس','بلطيم','الحامول','سيدي سالم','قلين','بيلا'],
    'مطروح':['مرسى مطروح','الحمام','العلمين','الضبعة','سيدي براني','السلوم','سيوة'],
    'أخرى':['مدينة أخرى / قرية']
  };
  const governorate = form.elements.governorate;
  const city = form.elements.city;
  let shippingRates = {}, shippingFee = null;
  const otherCityLabel = form.querySelector('[name="otherCityLabel"]');
  Object.keys(locations).forEach(name => governorate.add(new Option(name, name)));
  governorate.addEventListener('change', function () {
    city.replaceChildren(new Option('اختار المدينة / المركز', ''));
    (locations[governorate.value] || []).forEach(name => city.add(new Option(name, name)));
    city.add(new Option('مدينة / قرية تانية مش موجودة', '__other__'));
    city.disabled = !governorate.value;
    otherCityLabel.hidden = true;
    form.elements.otherCity.required = false;
    shippingFee = Object.prototype.hasOwnProperty.call(shippingRates, governorate.value) ? Number(shippingRates[governorate.value]) : null;
    refreshCart();
  });
  city.addEventListener('change', function () {
    const custom = city.value === '__other__';
    otherCityLabel.hidden = !custom;
    form.elements.otherCity.required = custom;
  });
  fetch('/api/shipping-rates', { cache: 'no-store' }).then(response => response.json()).then(data => {
    shippingRates = data.rates || {};
    shippingFee = Object.prototype.hasOwnProperty.call(shippingRates, governorate.value) ? Number(shippingRates[governorate.value]) : null;
    refreshCart();
  }).catch(() => {});
  const savedProfile = fetch('/api/customer/me', { cache: 'no-store' }).then(response => response.json()).then(data => {
    if (!data.customer) return;
    form.elements.name.value = data.customer.name;
    form.elements.phone.value = data.customer.phone;
    governorate.value = data.customer.governorate;
    governorate.dispatchEvent(new Event('change'));
    if (Array.from(city.options).some(option => option.value === data.customer.city)) city.value = data.customer.city;
    else { city.value = '__other__'; form.elements.otherCity.value = data.customer.city; city.dispatchEvent(new Event('change')); }
    form.elements.address.value = data.customer.address;
  }).catch(() => {});

  function refreshCart() {
    let total = 0;
    let subtotal = 0;
    let hasUnknownPrice = false;
    lines.replaceChildren();
    for (const [productId, entry] of cart) {
      total += entry.quantity;
      const row = document.createElement('div');
      row.className = 'cart-line';
      const photo = document.createElement('div');
      photo.className = 'cart-product-photo';
      if (entry.image) {
        const image = document.createElement('img');
        image.src = /^onedrive:[A-Za-z0-9!_-]+$/.test(entry.image) ? '/api/product-images/' + encodeURIComponent(entry.image.slice('onedrive:'.length)) : /^https:\/\//i.test(entry.image) ? entry.image : '/products/' + encodeURIComponent(entry.image);
        image.alt = entry.name;
        photo.appendChild(image);
      } else photo.textContent = '📦';
      const info = document.createElement('div');
      info.className = 'cart-product-info';
      const title = document.createElement('strong');
      title.textContent = entry.name;
      const price = document.createElement('span');
      price.className = 'cart-item-price';
      price.textContent = entry.price == null ? 'السعر هيتأكد معاك' : 'سعر القطعة: ' + entry.price.toLocaleString('ar-EG') + ' جنيه';
      const lineTotal = document.createElement('small');
      lineTotal.className = 'cart-item-total';
      lineTotal.textContent = entry.price == null ? 'الإجمالي هيتأكد قبل الشحن' : 'الإجمالي: ' + (entry.price * entry.quantity).toLocaleString('ar-EG') + ' جنيه';
      info.append(title, price, lineTotal);
      const controls = document.createElement('div');
      controls.className = 'qty-controls';
      const minus = document.createElement('button');
      minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'تقليل ' + entry.name);
      minus.onclick = function () { const n = cart.get(productId).quantity - 1; if (n < 1) cart.delete(productId); else cart.get(productId).quantity = n; refreshCart(); };
      const amount = document.createElement('span'); amount.textContent = String(entry.quantity);
      const plus = document.createElement('button');
      plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'زيادة ' + entry.name);
      plus.onclick = function () {
        const current = cart.get(productId);
        const next = current.quantity + 1;
        if (current.stock != null && next > current.stock) { result.textContent = 'الكمية المتاحة من «' + current.name + '» هي ' + current.stock + '.'; return; }
        if (next <= 20) current.quantity = next;
        refreshCart();
      };
      controls.append(minus, amount, plus); row.append(photo, info, controls); lines.appendChild(row);
      if (entry.price == null) hasUnknownPrice = true;
      else subtotal += entry.price * entry.quantity;
    }
    count.textContent = String(total);
    const existingTotal = dialog.querySelector('.cart-total');
    if (existingTotal) existingTotal.remove();
    if (total) {
      const summary = document.createElement('div');
      summary.className = 'cart-total';
      const productRow = document.createElement('span');
      productRow.textContent = 'مجموع المنتجات: ' + (hasUnknownPrice ? 'السعر هيتأكد معاك' : subtotal.toLocaleString('ar-EG') + ' جنيه');
      const shippingRow = document.createElement('span');
      shippingRow.textContent = !governorate.value ? 'الشحن: اختار المحافظة' : shippingFee == null ? 'الشحن: هيتأكد معاك' : 'الشحن: ' + shippingFee.toLocaleString('ar-EG') + ' جنيه';
      summary.append(productRow, shippingRow);
      if (!hasUnknownPrice && shippingFee != null) {
        const finalRow = document.createElement('strong');
        finalRow.textContent = 'الإجمالي شامل الشحن: ' + (subtotal + shippingFee).toLocaleString('ar-EG') + ' جنيه';
        summary.appendChild(finalRow);
      }
      lines.appendChild(summary);
    }
    if (!total) {
      const empty = document.createElement('p');
      empty.className = 'muted'; empty.textContent = 'السلة فاضية. اختار منتج من المتجر الأول.'; lines.appendChild(empty);
    }
  }

  document.addEventListener('click', async function (event) {
    const button = event.target.closest('.product .add');
    if (!button || button.disabled) return;
    event.preventDefault();
    const card = button.closest('.product');
    const name = card.querySelector('h3,h1').textContent.trim();
    const productId = card.dataset.id || name;
    const stock = card.dataset.stock === '' || card.dataset.stock === undefined ? null : Number(card.dataset.stock);
    const price = card.dataset.price === '' || card.dataset.price === undefined ? null : Number(card.dataset.price);
    const image = card.querySelector('.product-photo-link img, #productImage, .photo img')?.src || '';
    const entry = cart.get(productId) || { name, quantity: 0, stock, price, image };
    const selectedQuantity = Number(card.querySelector('[name=quantity]')?.value || 1);
    if (stock != null && entry.quantity + selectedQuantity > stock) { if (typeof toast === 'function') toast('الكمية المتاحة من المنتج هي ' + stock); return; }
    if (entry.quantity + selectedQuantity > 20) return;
    entry.quantity += selectedQuantity;
    cart.set(productId, entry);
    result.textContent = '';
    refreshCart();
    if (typeof toast === 'function') toast('اتضاف ' + name + ' لسلة الطلب');
    if (button.dataset.buyNow === 'true') { await savedProfile; dialog.showModal(); }
  });

  cartButton.addEventListener('click', async function () { await savedProfile; result.textContent = ''; refreshCart(); dialog.showModal(); });
  dialog.querySelector('.close-checkout').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
  form.addEventListener('reset', function () { otherCityLabel.hidden = true; form.elements.otherCity.required = false; });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!cart.size) { result.textContent = 'ضيف منتج للسلة الأول.'; return; }
    const submit = form.querySelector('[type=submit]');
    submit.disabled = true; result.textContent = 'بنبعت طلبك...';
    const payload = {
      name: form.elements.name.value.trim(), phone: form.elements.phone.value.trim(),
      governorate: form.elements.governorate.value, city: form.elements.city.value === '__other__' ? form.elements.otherCity.value.trim() : form.elements.city.value,
      address: form.elements.address.value.trim(), notes: form.elements.notes.value.trim(),
      items: Array.from(cart, function (entry) { return { productId: entry[0], product: entry[1].name, quantity: entry[1].quantity }; })
    };
    try {
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'حصلت مشكلة وإحنا بنبعت الطلب.');
      cart.clear(); refreshCart(); form.reset();
      result.textContent = 'طلبك وصل. رقم الطلب: ' + data.id + ' — ' + data.message;
      if (typeof toast === 'function') toast('وصل طلبك للمتجر');
    } catch (error) {
      result.textContent = error.message + ' اتأكد إنك فاتح المتجر من رابط السيرفر المحلي.';
    } finally { submit.disabled = false; }
  });
})();

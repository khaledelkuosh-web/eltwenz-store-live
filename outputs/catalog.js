(function () {
  const grid = document.querySelector('.products');
  const filters = document.querySelector('.filters');
  if (!grid || !filters) return;
  grid.dataset.catalogReady = 'false';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function imageSource(image) {
    if (!image) return '';
    return /^https:\/\//i.test(image) ? image : '/products/' + encodeURIComponent(image);
  }

  async function loadCatalog() {
    try {
      const response = await fetch('/api/products', { cache: 'no-store' });
      if (!response.ok) throw new Error('Catalog request failed');
      const data = await response.json();
      const products = (Array.isArray(data.products) ? data.products : []).filter(product => Number(product.discount || 0) > 0);
      grid.replaceChildren();
      for (const product of products) {
        const card = element('article', undefined, 'product');
        card.dataset.id = product.id;
        card.dataset.kind = product.category;
        card.dataset.mood = 'الكل';
        card.dataset.search = [product.name, product.category, product.description].join(' ');
        const discount = Number(product.discount || 0);
        const salePrice = product.price == null ? null : Number((product.price * (1 - discount / 100)).toFixed(2));
        card.dataset.price = salePrice == null ? '' : String(salePrice);
        card.dataset.stock = product.stock == null ? '' : String(product.stock);

        const photo = element('a', undefined, 'photo product-photo-link');
        photo.href = '/product/' + encodeURIComponent(product.id);
        photo.setAttribute('aria-label', 'تفاصيل ' + product.name);
        if (product.image) {
          const img = element('img');
          img.src = imageSource(product.image);
          img.alt = product.name;
          photo.appendChild(img);
        } else photo.appendChild(element('span', '📦'));
        photo.appendChild(element('span', product.badge || product.category, 'badge'));
        if (discount > 0) photo.appendChild(element('span', 'خصم ' + discount + '%', 'discount-badge'));
        card.appendChild(photo);

        const info = element('div', undefined, 'info');
        info.appendChild(element('small', product.category));
        const title = element('a', undefined, 'product-title-link');
        title.href = '/product/' + encodeURIComponent(product.id);
        title.appendChild(element('h3', product.name));
        info.appendChild(title);
        const bottom = element('div', undefined, 'bottom');
        if (salePrice == null) {
          const ask = element('a', 'اسأل عن السعر', 'price ask-price-link');
          ask.href = '/price-inquiry/' + encodeURIComponent(product.id);
          bottom.appendChild(ask);
        }
        else if (discount > 0) {
          const priceGroup = element('span', undefined, 'price price-group');
          priceGroup.appendChild(element('del', Number(product.price).toLocaleString('ar-EG') + ' جنيه', 'old-price'));
          priceGroup.appendChild(element('strong', salePrice.toLocaleString('ar-EG') + ' جنيه', 'sale-price'));
          bottom.appendChild(priceGroup);
        } else bottom.appendChild(element('span', salePrice.toLocaleString('ar-EG') + ' جنيه', 'price'));
        info.appendChild(bottom);
        if (Number.isInteger(product.stock)) info.appendChild(element('small', product.stock ? 'المتاح: ' + product.stock : 'غير متاح حالياً', 'stock-note'));
        card.appendChild(info);
        grid.appendChild(card);
      }
      if (!products.length) grid.appendChild(element('p', 'مفيش عروض متاحة دلوقتي. تابعنا قريب عشان تشوف الخصومات الجديدة.', 'products-empty'));

      filters.querySelectorAll('.filter').forEach(button => button.classList.toggle('active', button.dataset.kind === 'الكل'));
      if (typeof apply === 'function') apply();
      grid.dataset.catalogReady = 'true';
      window.dispatchEvent(new CustomEvent('catalog:loaded'));
    } catch (_) {
      grid.replaceChildren(element('p', 'مش قادرين نحمّل العروض دلوقتي. جرّب تحدّث الصفحة.', 'products-empty'));
      grid.dataset.catalogReady = 'true';
    }
  }

  loadCatalog();
})();

(function () {
  const grid = document.getElementById('categoryProducts');
  if (!grid) return;
  const config = {
    electronics: { title: 'إلكترونيات', intro: 'ساعات وسماعات وشواحن وأجهزة إلكترونية.', match: p => p.category === 'إلكترونيات' },
    clothes: { title: 'ملابس', intro: 'الملابس المتاحة حاليًا في المتجر.', match: p => p.category === 'ملابس' },
    shoes: { title: 'أحذية', intro: 'الأحذية المتاحة حاليًا في المتجر.', match: p => p.category === 'أحذية' },
    home: { title: 'للبيت', intro: 'أدوات ومنتجات للبيت والمطبخ.', match: p => p.category === 'البيت' },
    all: { title: 'كل المنتجات', intro: 'كل المنتجات المتاحة حاليًا في المتجر.', match: () => true }
  };
  const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || 'all');
  if (['watches', 'accessories', 'devices'].includes(slug)) { location.replace('/category/electronics'); return; }
  const category = config[slug];
  const title = document.getElementById('categoryTitle');
  const crumb = document.getElementById('categoryCrumb');
  const intro = document.getElementById('categoryIntro');
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const imageSource = image => /^onedrive:[A-Za-z0-9!_-]+$/.test(image || '') ? '/api/product-images/' + encodeURIComponent(image.slice('onedrive:'.length)) : /^https:\/\//i.test(image || '') ? image : '/products/' + encodeURIComponent(image || '');
  if (!category) {
    title.textContent = 'القسم مش موجود'; crumb.textContent = 'القسم مش موجود';
    intro.textContent = 'ارجع للمتجر واختار قسم من الأقسام المتاحة.';
    grid.replaceChildren(element('a', 'ارجع للمتجر', 'products-empty')); grid.dataset.catalogReady = 'true'; return;
  }
  title.textContent = category.title; crumb.textContent = category.title; intro.textContent = category.intro;
  document.title = category.title + ' | Eltwenz Store';
  document.querySelectorAll('.category-nav a').forEach(link => link.classList.toggle('active', link.pathname.endsWith('/' + slug)));

  async function load() {
    try {
      const response = await fetch('/api/products', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unable to load products');
      const data = await response.json();
      const products = (Array.isArray(data.products) ? data.products : []).filter(category.match);
      grid.replaceChildren();
      for (const product of products) {
        const discount = Number(product.discount || 0);
        const salePrice = product.price == null ? null : Number((product.price * (1 - discount / 100)).toFixed(2));
        const card = element('article', undefined, 'product');
        const photo = element('a', undefined, 'photo');
        photo.href = '/product/' + encodeURIComponent(product.id);
        if (product.image) { const img = element('img'); img.src = imageSource(product.image); img.alt = product.name; photo.appendChild(img); }
        else photo.appendChild(element('span', '📦'));
        photo.appendChild(element('span', product.badge || product.category, 'badge'));
        if (discount > 0) photo.appendChild(element('span', 'خصم ' + discount + '%', 'discount-badge'));
        card.appendChild(photo);
        const info = element('div', undefined, 'info');
        info.appendChild(element('small', product.category));
        const name = element('a', undefined, 'product-title-link'); name.href = photo.href;
        name.appendChild(element('h2', product.name)); info.appendChild(name);
        const bottom = element('div', undefined, 'bottom');
        if (salePrice === null) {
          const ask = element('a', 'اسأل عن السعر', 'price'); ask.href = '/price-inquiry/' + encodeURIComponent(product.id); bottom.appendChild(ask);
        } else if (discount > 0) {
          const group = element('span', undefined, 'price price-group');
          group.appendChild(element('del', Number(product.price).toLocaleString('ar-EG') + ' جنيه', 'old-price'));
          group.appendChild(element('strong', salePrice.toLocaleString('ar-EG') + ' جنيه', 'sale-price')); bottom.appendChild(group);
        } else bottom.appendChild(element('span', Number(product.price).toLocaleString('ar-EG') + ' جنيه', 'price'));
        info.appendChild(bottom);
        if (Number.isInteger(product.stock)) info.appendChild(element('small', product.stock ? 'المتاح: ' + product.stock : 'غير متاح حالياً', 'stock-note'));
        card.appendChild(info); grid.appendChild(card);
      }
      if (!products.length) grid.appendChild(element('p', 'مفيش منتجات في القسم ده دلوقتي.', 'products-empty'));
      grid.dataset.catalogReady = 'true';
    } catch (_) {
      grid.replaceChildren(element('p', 'مش قادرين نحمّل المنتجات دلوقتي. جرّب تحدّث الصفحة.', 'products-empty'));
      grid.dataset.catalogReady = 'true';
    }
  }
  load();
})();

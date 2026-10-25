(async function () {
  const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
  const loading = document.getElementById('loading');
  const detail = document.getElementById('productDetail');
  const notFound = document.getElementById('notFound');
  const addText = (node, text) => { node.textContent = text; };
  const imageSource = source => /^https:\/\//i.test(source || '') ? source : '/products/' + encodeURIComponent(source || '');
  function addRecommendations(current) {
    const section = document.getElementById('recommendations');
    const grid = document.getElementById('recommendationGrid');
    fetch('/api/products', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(data => {
      const products = (data && Array.isArray(data.products) ? data.products : [])
        .filter(item => item.id !== current.id && item.category === current.category)
        .slice(0, 4);
      if (!products.length) return;
      products.forEach(item => {
        const card = document.createElement('article');
        card.className = 'recommendation-card';
        const link = document.createElement('a');
        link.className = 'recommendation-photo';
        link.href = '/product/' + encodeURIComponent(item.id);
        link.setAttribute('aria-label', 'تفاصيل ' + item.name);
        if (item.image) {
          const image = document.createElement('img');
          image.src = imageSource(item.image);
          image.alt = item.name;
          link.appendChild(image);
        } else link.appendChild(document.createTextNode('📦'));
        const info = document.createElement('div');
        info.className = 'recommendation-info';
        const name = document.createElement('a');
        name.className = 'recommendation-name';
        name.href = link.href;
        name.textContent = item.name;
        info.appendChild(name);
        const discount = Number(item.discount || 0);
        if (item.price == null) {
          const ask = document.createElement('a');
          ask.className = 'recommendation-price ask-price-link';
          ask.textContent = 'اسأل عن السعر';
          ask.href = '/price-inquiry/' + encodeURIComponent(item.id);
          info.appendChild(ask);
        } else {
          const price = Number((item.price * (1 - discount / 100)).toFixed(2));
          if (discount > 0) {
            const oldPrice = document.createElement('del');
            oldPrice.textContent = Number(item.price).toLocaleString('ar-EG') + ' جنيه';
            info.appendChild(oldPrice);
          }
          const amount = document.createElement('span');
          amount.className = 'recommendation-price';
          amount.textContent = price.toLocaleString('ar-EG') + ' جنيه';
          info.appendChild(amount);
        }
        card.append(link, info);
        grid.appendChild(card);
      });
      section.hidden = false;
    }).catch(() => {});
  }
  try {
    const response = await fetch('/api/products/' + encodeURIComponent(id), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.product) throw new Error('not-found');
    const product = data.product;
    const discount = Number(product.discount || 0);
    const salePrice = product.price == null ? null : Number((product.price * (1 - discount / 100)).toFixed(2));
    detail.dataset.id = product.id;
    detail.dataset.stock = product.stock == null ? '' : String(product.stock);
    detail.dataset.price = salePrice == null ? '' : String(salePrice);
    addText(document.getElementById('crumbName'), product.name);
    addText(document.getElementById('productCategory'), product.category);
    addText(document.getElementById('productName'), product.name);
    addText(document.getElementById('productDescription'), product.description || 'تفاصيل المنتج متاحة من المتجر.');
    addText(document.getElementById('productBadge'), product.badge || product.category);
    const image = document.getElementById('productImage');
    image.alt = product.name;
    if (product.image) image.src = imageSource(product.image);
    else image.hidden = true;
    const gallery = document.getElementById('productGallery');
    const images = Array.from(new Set([product.image, ...(Array.isArray(product.images) ? product.images : [])].filter(Boolean)));
    if (images.length > 1) {
      gallery.replaceChildren();
      images.forEach((source, index) => {
        const thumbnail = document.createElement('button');
        thumbnail.type = 'button';
        thumbnail.setAttribute('aria-label', 'عرض الصورة ' + (index + 1));
        thumbnail.setAttribute('aria-current', index === 0 ? 'true' : 'false');
        const preview = document.createElement('img');
        preview.src = imageSource(source);
        preview.alt = product.name + ' - صورة ' + (index + 1);
        thumbnail.appendChild(preview);
        thumbnail.addEventListener('click', () => {
          image.src = preview.src;
          gallery.querySelectorAll('button').forEach(button => button.setAttribute('aria-current', 'false'));
          thumbnail.setAttribute('aria-current', 'true');
        });
        gallery.appendChild(thumbnail);
      });
      gallery.hidden = false;
    }
    const priceBox = document.getElementById('productPrice');
    if (salePrice == null) {
      const ask = document.createElement('a');
      ask.textContent = 'اسأل عن السعر';
      ask.href = '/price-inquiry/' + encodeURIComponent(product.id);
      ask.className = 'product-ask-price';
      priceBox.appendChild(ask);
    }
    else if (discount > 0) {
      const oldPrice = document.createElement('del');
      oldPrice.textContent = Number(product.price).toLocaleString('ar-EG') + ' جنيه';
      const newPrice = document.createElement('strong');
      newPrice.textContent = salePrice.toLocaleString('ar-EG') + ' جنيه';
      const percent = document.createElement('span');
      percent.className = 'discount-badge';
      percent.textContent = 'خصم ' + discount + '%';
      priceBox.append(oldPrice, newPrice, percent);
    } else priceBox.textContent = salePrice.toLocaleString('ar-EG') + ' جنيه';
    const stockText = document.getElementById('productStock');
    const quantity = document.getElementById('productQuantity');
    if (product.stock == null) addText(stockText, 'متاح للطلب');
    else {
      quantity.max = String(Math.min(20, Math.max(1, product.stock)));
      addText(stockText, product.stock > 0 ? 'المتاح: ' + product.stock + ' قطعة' : 'نفد المخزون');
      if (product.stock > 0 && product.stock < 5) stockText.classList.add('low-stock-text');
      if (product.stock === 0) detail.querySelectorAll('.add').forEach(button => { button.disabled = true; });
    }
    document.title = product.name + ' | Eltwenz Store';
    loading.hidden = true;
    detail.hidden = false;
    addRecommendations(product);
  } catch (_) {
    loading.hidden = true;
    notFound.hidden = false;
  }
})();

(function () {
  const carousel = document.getElementById('heroCarousel');
  if (!carousel) return;
  const cards = {
    previous: carousel.querySelector('[data-slot="previous"]'),
    current: carousel.querySelector('[data-slot="current"]'),
    next: carousel.querySelector('[data-slot="next"]')
  };
  const prevButton = document.getElementById('heroPrev');
  const nextButton = document.getElementById('heroNext');
  const detailsButton = document.getElementById('heroDetails');
  const caption = document.getElementById('heroProductName');
  if (!cards.previous || !cards.current || !cards.next || !prevButton || !nextButton) return;

  let products = [];
  let index = 0;
  let pointerStart = null;
  let skipClick = false;
  let moving = false;
  let queuedTurns = 0;

  function imageSource(image) {
    if (!image) return '';
    if (/^onedrive:[A-Za-z0-9!_-]+$/.test(image)) return '/api/product-images/' + encodeURIComponent(image.slice('onedrive:'.length));
    return /^https:\/\//i.test(image) ? image : '/products/' + encodeURIComponent(image);
  }

  function showProduct(card, item, isCurrent) {
    card.href = '/product/' + encodeURIComponent(item.id);
    card.setAttribute('aria-label', 'تفاصيل ' + item.name);
    const image = card.querySelector('img');
    const source = imageSource(item.image);
    if (image.getAttribute('src') !== source) {
      if (image._heroSwapTimer) clearTimeout(image._heroSwapTimer);
      image.style.opacity = '0.3';
      image.style.transform = 'scale(.96)';
      image._heroSwapTimer = setTimeout(() => {
        image.src = source;
        image.alt = item.name;
        const reveal = () => requestAnimationFrame(() => {
          image.style.opacity = '1';
          image.style.transform = 'scale(1)';
        });
        if (typeof image.decode === 'function') image.decode().catch(() => {}).then(reveal);
        else image.onload = reveal;
      }, 80);
    } else {
      image.alt = item.name;
    }
    const name = card.querySelector('.hero-product-caption');
    if (name) name.textContent = isCurrent ? item.name : '';
  }

  function assignRole(card, role) {
    card.dataset.slot = role;
    card.classList.remove('hero-product-featured', 'hero-product-side', 'hero-product-left', 'hero-product-right');
    if (role === 'current') card.classList.add('hero-product-featured');
    else card.classList.add('hero-product-side', role === 'previous' ? 'hero-product-left' : 'hero-product-right');
  }

  function render() {
    if (!products.length) return;
    const total = products.length;
    showProduct(cards.previous, products[(index - 1 + total) % total], false);
    const current = products[index];
    showProduct(cards.current, current, true);
    showProduct(cards.next, products[(index + 1) % total], false);
    if (detailsButton) {
      detailsButton.href = '/product/' + encodeURIComponent(current.id);
      detailsButton.setAttribute('aria-label', 'تفاصيل ' + current.name);
    }
    if (caption) caption.textContent = current.name;
    carousel.setAttribute('aria-label', 'منتج ' + current.name);
  }

  function finishTurn(direction) {
    const oldPrevious = cards.previous;
    const oldCurrent = cards.current;
    const oldNext = cards.next;
    if (direction > 0) {
      cards.previous = oldCurrent;
      cards.current = oldNext;
      cards.next = oldPrevious;
    } else {
      cards.previous = oldNext;
      cards.current = oldPrevious;
      cards.next = oldCurrent;
    }
    assignRole(cards.previous, 'previous');
    assignRole(cards.current, 'current');
    assignRole(cards.next, 'next');
    index = (index + direction + products.length) % products.length;
    carousel.classList.remove('is-moving-next', 'is-moving-previous');
    render();
    moving = false;
    if (queuedTurns) setTimeout(runQueuedTurn, 0);
  }

  function runQueuedTurn() {
    if (moving || !queuedTurns) return;
    const direction = queuedTurns > 0 ? 1 : -1;
    queuedTurns -= direction;
    moving = true;
    carousel.classList.add(direction > 0 ? 'is-moving-next' : 'is-moving-previous');
    setTimeout(() => finishTurn(direction), 340);
  }

  function move(direction, steps = 1) {
    if (!products.length || products.length < 2) return;
    const turns = Math.min(2, Math.max(1, steps));
    queuedTurns = Math.max(-4, Math.min(4, queuedTurns + direction * turns));
    runQueuedTurn();
  }

  prevButton.addEventListener('click', () => move(-1));
  nextButton.addEventListener('click', () => move(1));
  carousel.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); move(-1); }
  });
  carousel.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerStart = { x: event.clientX, y: event.clientY };
  });
  carousel.addEventListener('pointerup', event => {
    if (!pointerStart) return;
    const dx = event.clientX - pointerStart.x;
    const dy = event.clientY - pointerStart.y;
    pointerStart = null;
    if (Math.abs(dx) < 38 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    skipClick = true;
    const steps = Math.min(2, Math.max(1, Math.round(Math.abs(dx) / 170)));
    move(dx < 0 ? 1 : -1, steps);
    setTimeout(() => { skipClick = false; }, 0);
  });
  carousel.addEventListener('pointercancel', () => { pointerStart = null; });
  carousel.querySelectorAll('.hero-product').forEach(card => card.addEventListener('click', event => {
    if (skipClick) { event.preventDefault(); skipClick = false; }
  }));

  fetch('/api/products', { cache: 'no-store' })
    .then(response => { if (!response.ok) throw new Error('Products request failed'); return response.json(); })
    .then(data => {
      products = (Array.isArray(data.products) ? data.products : []).filter(item => item.image);
      if (products.length) render();
      if (products.length < 2) {
        prevButton.hidden = true;
        nextButton.hidden = true;
      }
    })
    .catch(() => {});
})();

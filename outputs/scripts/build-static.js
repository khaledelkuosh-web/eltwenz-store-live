const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'public');
const frontendFiles = [
  'account.css', 'account.html', 'account.js', 'admin.html',
  'catalog.css', 'catalog.js', 'category.css', 'category.html', 'category.js',
  'checkout.js', 'hero-carousel.js', 'locations.js', 'order.css',
  'price-inquiry.css', 'price-inquiry.html', 'price-inquiry.js',
  'product.css', 'product.html', 'product.js', 'storefront.html'
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of frontendFiles) {
  const targetName = file === 'storefront.html' ? 'index.html' : file;
  fs.copyFileSync(path.join(root, file), path.join(output, targetName));
}
fs.cpSync(path.join(root, 'products'), path.join(output, 'products'), { recursive: true });

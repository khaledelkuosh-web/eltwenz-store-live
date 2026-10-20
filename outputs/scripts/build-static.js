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

function writePrettyRoute(route, sourceFile) {
  const routeDirectory = path.join(output, route);
  fs.mkdirSync(routeDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, sourceFile), path.join(routeDirectory, 'index.html'));
}

for (const slug of ['electronics', 'clothes', 'shoes', 'home', 'all']) {
  writePrettyRoute(path.join('category', slug), 'category.html');
}

writePrettyRoute('admin', 'admin.html');
writePrettyRoute('account', 'account.html');

const products = JSON.parse(fs.readFileSync(path.join(root, 'data', 'products.json'), 'utf8'));
for (const product of products) {
  if (typeof product.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(product.id)) continue;
  writePrettyRoute(path.join('product', product.id), 'product.html');
  if (product.price == null) {
    writePrettyRoute(path.join('price-inquiry', product.id), 'price-inquiry.html');
  }
}

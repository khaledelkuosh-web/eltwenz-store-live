'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

test('parses the inline JavaScript in the admin page', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);

  assert.match(html, /<input name="imageFile" type="file"/);
  assert.match(html, /id="productImagePreview"/);
  assert.match(html, /id="connectOneDrive"/);
  assert.match(html, /api\/admin\/onedrive\/connect/);
  assert.doesNotMatch(html, /name="image" maxlength=/);
  assert.ok(scripts.length > 0, 'expected at least one inline script');
  scripts.forEach((source, index) => new vm.Script(source, { filename: `admin.inline.${index}.js` }));
});

test('builds static pages in an isolated temporary directory', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'eltwenz-static-build-'));
  try {
    const files = [
      'account.css', 'account.html', 'account.js', 'admin.html', 'catalog.css', 'catalog.js',
      'category.css', 'category.html', 'category.js', 'checkout.js', 'hero-carousel.js',
      'locations.js', 'order.css', 'price-inquiry.css', 'price-inquiry.html', 'price-inquiry.js',
      'product.css', 'product.html', 'product.js', 'storefront.html'
    ];
    for (const file of files) fs.copyFileSync(path.join(root, file), path.join(stage, file));
    fs.mkdirSync(path.join(stage, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
    fs.copyFileSync(path.join(root, 'scripts', 'build-static.js'), path.join(stage, 'scripts', 'build-static.js'));
    fs.copyFileSync(path.join(root, 'data', 'products.json'), path.join(stage, 'data', 'products.json'));
    fs.cpSync(path.join(root, 'products'), path.join(stage, 'products'), { recursive: true });

    const result = spawnSync(process.execPath, [path.join(stage, 'scripts', 'build-static.js')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const file of ['index.html', 'admin/index.html', 'category/all/index.html']) {
      assert.ok(fs.existsSync(path.join(stage, 'public', file)), `missing generated page: ${file}`);
    }
  } finally {
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    const resolvedStage = path.resolve(stage);
    assert.ok(resolvedStage.startsWith(tempRoot), 'temporary build directory escaped the system temp directory');
    fs.rmSync(resolvedStage, { recursive: true, force: true });
  }
});

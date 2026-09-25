// Set EXTENSION_ROOT to validate an extracted release ZIP instead of this repo.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(process.env.EXTENSION_ROOT || path.join(__dirname, '..'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const refs = [manifest.background.service_worker, manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(item => [...item.js, ...item.css])];
  for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), `Missing manifest file: ${ref}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-bundle-smoke-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://x.com/bundle-smoke', route => route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!doctype html><html><body><article data-testid="tweet"><div data-testid="tweetText">A synthetic test post for loading the release bundle.</div><a href="/audit/status/123">link</a><div role="group"></div></article></body></html>' }));
    await page.goto('https://x.com/bundle-smoke');
    await page.locator('.bx-inline-button').waitFor({ timeout: 10000 });
    await page.locator('.bx-inline-button').click();
    await page.locator('#bx-sidebar.bx-open').waitFor();
    assert((await page.locator('#bx-sidebar').innerText()).includes('巴别塔（回译）'));
    assert.deepEqual(errors, []);
    console.log(`BUNDLE_LOAD_PASS ${manifest.version} ${new URL(worker.url()).host}`);
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

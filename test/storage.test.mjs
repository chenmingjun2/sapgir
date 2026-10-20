import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  key: (index) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  },
};

const storage = await import('../js/storage.js');

const LEGACY_KEYS = [
  'settingsVersion',
  'webSearch',
  'autoSearch',
  'allowFetch',
  'searchBackend',
  'searchProvider',
  'searchKeys',
  'webFetchMode',
  'fallbackDeepSeek',
  'allowPrivateFetch',
  'autoTitle',
];

beforeEach(() => store.clear());

test('loadSettings removes legacy Chat/search fields', async () => {
  localStorage.setItem(
    'dsv2.settings',
    JSON.stringify({
      apiKey: 'key',
      searchCount: 7,
      webSearch: true,
      autoSearch: true,
      allowFetch: true,
      searchBackend: 'builtin',
      searchProvider: 'auto',
      searchKeys: { exa: 'x' },
      webFetchMode: 'local',
      fallbackDeepSeek: true,
      allowPrivateFetch: true,
      autoTitle: true,
      settingsVersion: 2,
    })
  );

  const settings = await storage.loadSettings();
  assert.equal(settings.searchCount, 7);
  for (const key of LEGACY_KEYS) {
    assert.equal(key in settings, false, `${key} should be removed`);
  }
  assert.equal(settings.searchCount, 7);
});

test('saveSettings strips legacy fields', async () => {
  await storage.saveSettings({
    apiKey: 'secret',
    webSearch: true,
    searchBackend: 'builtin',
    searchKeys: { exa: 'x' },
  });
  const raw = JSON.parse(localStorage.getItem('dsv2.settings'));
  assert.equal(raw.apiKey, 'secret');
  for (const key of LEGACY_KEYS) {
    assert.equal(key in raw, false, `${key} should not be persisted`);
  }
});

test('exportAll never includes the API key', async () => {
  await storage.saveSettings({ apiKey: 'secret' });
  const data = await storage.exportAll();
  assert.equal(data.settings.apiKey, '');
});

test('loadSettings clamps native search max_uses to 2-8', async () => {
  await storage.saveSettings({ searchCount: 99 });
  assert.equal((await storage.loadSettings()).searchCount, 8);
  await storage.saveSettings({ searchCount: 1 });
  assert.equal((await storage.loadSettings()).searchCount, 2);
});

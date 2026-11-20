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
  'autoSearch',
  'allowFetch',
  'searchBackend',
  'searchProvider',
  'searchKeys',
  'webFetchMode',
  'fallbackDeepSeek',
  'allowPrivateFetch',
  'autoTitle',
  'thinkingEffort',
  'searchCount',
  'temperature',
];

beforeEach(() => store.clear());

test('loadSettings removes legacy fields but keeps webSearch', async () => {
  localStorage.setItem(
    'dsv2.settings',
    JSON.stringify({
      apiKey: 'key',
      webSearch: false,
      searchCount: 7,
      thinkingEffort: 'max',
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
  assert.equal(settings.webSearch, false);
  for (const key of LEGACY_KEYS) {
    assert.equal(key in settings, false, `${key} should be removed`);
  }
});

test('saveSettings strips legacy fields', async () => {
  await storage.saveSettings({
    apiKey: 'secret',
    searchBackend: 'builtin',
    searchKeys: { exa: 'x' },
    searchCount: 5,
    thinkingEffort: 'high',
  });
  const raw = JSON.parse(localStorage.getItem('dsv2.settings'));
  assert.equal(raw.apiKey, 'secret');
  for (const key of LEGACY_KEYS) {
    assert.equal(key in raw, false, `${key} should not be persisted`);
  }
});

test('webSearch defaults to true', async () => {
  const settings = await storage.loadSettings();
  assert.equal(settings.webSearch, true);
});

test('exportAll never includes the API key', async () => {
  await storage.saveSettings({ apiKey: 'secret' });
  const data = await storage.exportAll();
  assert.equal(data.settings.apiKey, '');
});

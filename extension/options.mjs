/** Options page: key, hourly spend cap and assessment rate cap. The key is never printed or logged. */
const $ = id => document.getElementById(id);
const DEFAULTS = {TYPESAFE_API_KEY: '', spendCapUSD: 0.5, maxPerSecond: 10};
const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
$('key').value = stored.TYPESAFE_API_KEY ?? '';
$('cap').value = stored.spendCapUSD ?? DEFAULTS.spendCapUSD;
$('rate').value = stored.maxPerSecond ?? DEFAULTS.maxPerSecond;
$('save').addEventListener('click', async () => {
  const cap = Number($('cap').value), rate = Number($('rate').value);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 50) return set('Enter a spend cap between 0.01 and 50 USD.');
  if (!Number.isFinite(rate) || rate < 1 || rate > 60) return set('Enter a rate between 1 and 60 messages per second.');
  await chrome.storage.local.set({TYPESAFE_API_KEY: $('key').value.trim(), spendCapUSD: cap, maxPerSecond: Math.floor(rate)});
  set($('key').value.trim() ? 'Saved. Reload the Twitch tab to apply.' : 'Saved with no key. Jev will not be called.');
});
/** One tiny Noul request through the service worker, so the key is never read by this page's fetch. */
$('test').addEventListener('click', async () => {
  const typed = $('key').value.trim();
  if (!typed) return set('Enter a key and save it first.');
  await chrome.storage.local.set({TYPESAFE_API_KEY: typed});
  set('Testing.');
  const reply = await chrome.runtime.sendMessage({type: 'jev.test'});
  set(reply?.ok ? `Key works. ${reply.model} answered in ${reply.elapsedMs} ms.` : `Test failed: ${reply?.message ?? 'no reply from the extension background.'}`);
});
function set(text) { $('status').textContent = text; }

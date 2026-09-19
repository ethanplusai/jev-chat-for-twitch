/** Service worker: the only place that reads the key and the only place that calls Jev.
 * The content script never sees the key, and the key is never written to a log. */
import {JevBrowserClient, StoredSpendWindow, pickSpendArea, buildChatRequest, byteLength, pingJev, JevError} from './jev.mjs';
export const DEFAULTS = Object.freeze({TYPESAFE_API_KEY: '', spendCapUSD: 0.5, maxPerSecond: 10, maxInFlight: 2});
const spend = new StoredSpendWindow({capUSD: DEFAULTS.spendCapUSD});
let inFlight = 0;
/** The spend window is reloaded from chrome.storage.session (or local) on every use, so an
 * hourly cap survives a service-worker teardown instead of restarting at zero. */
async function loadSpend(now) {
  if (!spend.area) spend.area = pickSpendArea();
  await spend.load(now);
  return spend;
}
export function readSettings(stored = {}) {
  const cap = Number(stored.spendCapUSD);
  const rate = Number(stored.maxPerSecond);
  return {
    apiKey: typeof stored.TYPESAFE_API_KEY === 'string' ? stored.TYPESAFE_API_KEY.trim() : '',
    spendCapUSD: Number.isFinite(cap) && cap > 0 && cap <= 50 ? cap : DEFAULTS.spendCapUSD,
    maxPerSecond: Number.isFinite(rate) && rate >= 1 && rate <= 60 ? Math.floor(rate) : DEFAULTS.maxPerSecond
  };
}
async function settings() {
  const stored = await chrome.storage.local.get(['TYPESAFE_API_KEY', 'spendCapUSD', 'maxPerSecond']);
  return readSettings(stored);
}
async function judge(payload) {
  const {apiKey, spendCapUSD} = await settings();
  const now = Date.now();
  await loadSpend(now);
  spend.capUSD = spendCapUSD;
  if (!apiKey) return {ok: false, code: 'no_key', message: 'Add your TypeSafe API key on the options page. Nothing is judged without it.'};
  if (spend.exhausted(now)) return {ok: false, code: 'spend_cap', message: `The hourly cap of $${spendCapUSD.toFixed(2)} is reached. Jev calls are stopped; no heuristic is substituted.`, spentUSD: spend.spent(now)};
  if (inFlight >= DEFAULTS.maxInFlight) return {ok: false, code: 'busy', message: 'Both request slots are in use. These messages stay unassessed.'};
  const request = buildChatRequest(payload.messages, {channel: payload.channel, streamTitle: payload.streamTitle, recentMessages: payload.recentMessages ?? []});
  inFlight++;
  try {
    const client = new JevBrowserClient({apiKey});
    const result = await client.ask(request.state, request.questions);
    const spentUSD = await spend.record(result.estimatedUSD ?? 0, Date.now());
    return {ok: true, answers: result.answers, model: result.model, usage: result.usage, elapsedMs: result.elapsedMs,
      attempts: result.attempts, estimatedUSD: result.estimatedUSD, spentUSD, capUSD: spend.capUSD, requestBytes: byteLength(JSON.stringify(request))};
  } catch (error) {
    return {ok: false, code: error instanceof JevError ? error.code : 'internal_error', message: error instanceof JevError ? error.message : 'The batch could not be judged.'};
  } finally {
    inFlight--;
  }
}
/** One tiny Noul request for the options page Test key button. Reports latency and model id, or the error. */
async function testKey() {
  const {apiKey} = await settings();
  if (!apiKey) return {ok: false, code: 'no_key', message: 'Save a key first, then test it.'};
  try {
    return await pingJev({apiKey});
  } catch (error) {
    return {ok: false, code: error instanceof JevError ? error.code : 'internal_error', message: error instanceof JevError ? error.message : 'The test request failed.'};
  }
}
async function currentSettings() {
  const s = await settings();
  const now = Date.now();
  await loadSpend(now);
  spend.capUSD = s.spendCapUSD;
  return {ok: true, hasKey: s.apiKey.length > 0, spendCapUSD: s.spendCapUSD, maxPerSecond: s.maxPerSecond, spentUSD: spend.spent(now)};
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'jev.judge') { judge(message.payload).then(sendResponse); return true; }
  if (message?.type === 'jev.settings') { currentSettings().then(sendResponse); return true; }
  if (message?.type === 'jev.test') { testKey().then(sendResponse); return true; }
  /* Content scripts cannot call chrome.runtime.openOptionsPage(); the worker does it for them. */
  if (message?.type === 'open-options') {
    chrome.runtime.openOptionsPage?.();
    sendResponse({ok: true});
    return true;
  }
  return false;
});

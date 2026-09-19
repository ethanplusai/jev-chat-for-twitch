/** The injected Jev Chat column: IRC in, one Jev request per batch, selected rows out.
 * Usernames and message text are written with textContent only. No message is ever rewritten. */
import {TwitchIRC, channelFromPath} from './irc.mjs';
import {Batcher} from './jev.mjs';
import {INTENTS, CRITERIA, disposition} from './chat-policy.mjs';
const MAX_ROWS = 300, MAX_DECISIONS = 500, PUMP_MS = 150, MAX_IN_FLIGHT = 2;
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) k === 'onclick' ? node.addEventListener('click', v) : node.setAttribute(k, v);
  for (const kid of kids) node.append(kid);
  return node;
};
const time = ms => new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
const p50 = list => list.length ? [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] : 0;
const state = {
  channel: '', policy: 'helpful', irc: null, batcher: null, inFlight: 0, paused: false, narrow: true, stopped: '',
  decisions: new Map(), messages: new Map(), order: [], maxPerSecond: 10, hasKey: false,
  stats: {received: 0, assessed: 0, unassessed: 0, requests: 0, latencies: [], tokens: 0, usd: 0, model: ''}
};
let ui = null;
function styles() {
  if (document.getElementById('jev-chat-style')) return;
  const link = el('link', {id: 'jev-chat-style', rel: 'stylesheet', href: chrome.runtime.getURL('panel.css')});
  document.head.append(link);
}
function build() {
  const chips = el('div', {class: 'jev-chips'});
  for (const intent of INTENTS) {
    chips.append(el('button', {class: `jev-chip${intent.policy === state.policy ? ' on' : ''}`, 'data-policy': intent.policy, title: intent.note,
      onclick: () => setPolicy(intent.policy)}, intent.label));
  }
  const feed = el('div', {class: 'jev-feed', role: 'log', 'aria-live': 'polite'});
  feed.addEventListener('scroll', () => {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
    if (atBottom && state.paused) resume(); else if (!atBottom && !state.paused) { state.paused = true; ui.pill.hidden = false; }
  });
  const pill = el('button', {class: 'jev-pill', hidden: 'hidden', onclick: resume}, 'Chat paused due to scroll');
  const stats = el('div', {class: 'jev-stats'});
  const status = el('p', {class: 'jev-status'}, 'Starting.');
  const narrow = el('button', {class: 'jev-narrow-toggle', title: 'Narrow the native Twitch chat to make room', onclick: toggleNarrow}, 'Narrow chat');
  const gear = el('button', {class: 'jev-gear', 'aria-label': 'Jev Chat settings', title: 'Jev Chat settings', onclick: openOptions}, '\u2699');
  const card = el('div', {class: 'jev-card', hidden: 'hidden'});
  const panel = el('aside', {id: 'jev-chat-panel', 'aria-label': 'Jev Chat for Twitch'},
    el('header', {class: 'jev-head'}, el('h2', {}, 'Jev Chat'), el('span', {class: 'jev-badge'}, 'for Twitch'), narrow, gear),
    chips, stats, card, el('div', {class: 'jev-feed-wrap'}, feed, pill), status);
  document.body.append(panel);
  ui = {panel, chips, feed, pill, stats, status, card};
  setNarrow(state.narrow);
}
/** Content scripts cannot call chrome.runtime.openOptionsPage(); the service worker does it. */
function openOptions() {
  try { Promise.resolve(chrome.runtime.sendMessage({type: 'open-options'})).catch(() => {}); } catch { /* the worker is gone */ }
}
export const CARDS = Object.freeze({
  no_key: {title: 'Add your TypeSafe key to start filtering',
    body: 'About 2 thousandths of a cent per message; the default cap is $0.50 per hour.', action: 'Open settings'},
  spend_cap: {title: 'Hourly cap reached', body: '', action: 'Change cap'},
  invalid_key: {title: 'Key rejected',
    body: 'TypeSafe did not accept this key. Paste a current key on the settings page and press Test key.', action: 'Open settings'}
});
/** The onboarding, cap and rejected-key states all share one card above the feed. */
function showCard(kind, body = '') {
  const card = CARDS[kind];
  if (!ui || !card) return;
  ui.card.className = `jev-card is-${kind}`;
  ui.card.replaceChildren(
    el('strong', {class: 'jev-card-title'}, card.title),
    el('p', {class: 'jev-card-body'}, body || card.body),
    el('button', {class: 'jev-card-action', onclick: openOptions}, card.action));
  ui.card.hidden = false;
}
function hideCard() {
  if (!ui) return;
  ui.card.replaceChildren();
  ui.card.hidden = true;
}
function resume() { state.paused = false; ui.pill.hidden = true; ui.feed.scrollTop = ui.feed.scrollHeight; }
function toggleNarrow() { setNarrow(!state.narrow); }
function setNarrow(on) {
  state.narrow = on;
  document.documentElement.classList.toggle('jev-narrow', on);
  if (ui) ui.panel.querySelector('.jev-narrow-toggle').textContent = on ? 'Restore chat' : 'Narrow chat';
}
function renderStats() {
  const s = state.stats;
  const cells = [['received', s.received], ['assessed', s.assessed], ['selected', state.order.length],
    ['requests', s.requests], ['p50 ms', p50(s.latencies)], ['tokens', s.tokens.toLocaleString()], ['est. USD', `$${s.usd.toFixed(4)}`]];
  ui.stats.replaceChildren(...cells.map(([label, value]) => el('div', {class: 'jev-metric'}, el('span', {}, label), el('strong', {}, String(value)))));
}
function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `jev-status${kind ? ` is-${kind}` : ''}`;
}
/** One selected row. Username color comes from the IRC color tag; text is never parsed as HTML. */
function row(message, decision) {
  const name = el('span', {class: 'jev-user'}, message.author);
  if (message.color) name.style.color = message.color;
  return el('button', {class: 'jev-row', 'data-id': message.id, onclick: event => popover(message, decision, event.currentTarget)},
    el('span', {class: 'jev-time'}, time(message.at)), name, el('span', {class: 'jev-colon'}, ':'),
    el('span', {class: 'jev-body'}, message.body), el('span', {class: `jev-tag tag-${decision.category}`}, decision.category.replace('_', ' ')));
}
let openPop = null;
function closePop() { openPop?.remove(); openPop = null; }
function popover(message, decision, anchor) {
  closePop();
  const parts = [el('div', {class: 'jev-pop-head'}, el('strong', {}, decision.category.replace('_', ' ')), el('span', {class: 'jev-pop-model'}, decision.model || 'jev')),
    el('p', {class: 'jev-pop-text'}, message.body), el('p', {class: 'jev-pop-label'}, 'Jev probabilities')];
  for (const [category, probability] of Object.entries(decision.probabilities)) {
    const fill = el('div', {class: 'jev-prob-fill'});
    fill.style.width = `${probability * 100}%`;
    parts.push(el('div', {class: 'jev-prob-row'}, el('span', {}, category), el('div', {class: 'jev-prob-track'}, fill), el('span', {}, `${Math.round(probability * 100)}%`)));
  }
  parts.push(el('p', {class: 'jev-pop-note'}, CRITERIA[decision.category] ?? ''));
  parts.push(el('p', {class: 'jev-pop-note'}, `Confidence ${Math.round(decision.confidence * 100)}%. Batch round trip ${decision.elapsedMs} ms. A relevance decision does not establish that the message is true.`));
  const node = el('div', {class: 'jev-pop', role: 'dialog', 'aria-label': 'Decision details'}, ...parts);
  document.body.append(node);
  const box = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, box.left - node.offsetWidth - 12)}px`;
  node.style.top = `${Math.max(8, Math.min(window.innerHeight - node.offsetHeight - 8, box.top))}px`;
  openPop = node;
  setTimeout(() => document.addEventListener('click', function away(e) { if (!node.contains(e.target)) { closePop(); document.removeEventListener('click', away); } }), 0);
}
function append(message, decision) {
  state.order.push(message.id);
  while (state.order.length > MAX_ROWS) {
    const gone = state.order.shift();
    ui.feed.querySelector(`.jev-row[data-id="${CSS.escape(gone)}"]`)?.remove();
  }
  ui.feed.append(row(message, decision));
  if (!state.paused) ui.feed.scrollTop = ui.feed.scrollHeight;
  renderStats();
}
/** Intent switching re-runs disposition() over stored probabilities. It never calls Jev. */
function setPolicy(policy) {
  state.policy = policy;
  for (const chip of ui.chips.children) chip.classList.toggle('on', chip.dataset.policy === policy);
  state.order = [];
  const rows = [];
  for (const [id, decision] of state.decisions) {
    const message = state.messages.get(id);
    if (!message || !disposition(decision.category, decision.probabilities, policy).keep) continue;
    state.order.push(id);
    rows.push(row(message, decision));
  }
  while (state.order.length > MAX_ROWS) { state.order.shift(); rows.shift(); }
  ui.feed.replaceChildren(...rows);
  ui.feed.scrollTop = ui.feed.scrollHeight;
  renderStats();
}
function remember(id, decision) {
  state.decisions.set(id, decision);
  while (state.decisions.size > MAX_DECISIONS) {
    const oldest = state.decisions.keys().next().value;
    state.decisions.delete(oldest);
    state.messages.delete(oldest);
  }
}
function removeRows(predicate) {
  for (const [id, message] of [...state.messages]) {
    if (!predicate(message)) continue;
    ui.feed.querySelector(`.jev-row[data-id="${CSS.escape(id)}"]`)?.remove();
    state.order = state.order.filter(x => x !== id);
    state.decisions.delete(id);
    state.messages.delete(id);
  }
  renderStats();
}
async function sendBatch(batch) {
  state.inFlight++;
  state.stats.requests++;
  try {
    const recentMessages = [...state.messages.values()].slice(-12).map(m => m.body);
    const reply = await chrome.runtime.sendMessage({type: 'jev.judge', payload: {messages: batch, channel: state.channel, streamTitle: document.title.slice(0, 200), recentMessages}});
    if (!reply?.ok) {
      state.stats.unassessed += batch.length;
      if (reply?.code === 'spend_cap' || reply?.code === 'no_key' || reply?.code === 'invalid_key') {
        state.stopped = reply.message;
        setStatus(reply.message, 'stop');
        showCard(reply.code, reply.code === 'spend_cap' ? reply.message : '');
      } else setStatus(`${reply?.message ?? 'The batch could not be judged.'} ${batch.length} messages stay unassessed.`, 'warn');
      return;
    }
    state.stats.assessed += batch.length;
    hideCard();
    state.stats.latencies.push(reply.elapsedMs);
    if (state.stats.latencies.length > 200) state.stats.latencies.shift();
    if (reply.usage) state.stats.tokens += reply.usage.input_tokens + reply.usage.output_tokens;
    state.stats.usd += reply.estimatedUSD ?? 0;
    state.stats.model = reply.model;
    batch.forEach((message, i) => {
      const answer = reply.answers[`message_${i}`];
      if (!answer) return;
      const decision = {category: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence, model: reply.model, elapsedMs: reply.elapsedMs};
      state.messages.set(message.id, message);
      remember(message.id, decision);
      if (disposition(decision.category, decision.probabilities, state.policy).keep) append(message, decision);
    });
    setStatus(`${state.channel} · ${reply.model} · $${reply.spentUSD.toFixed(4)} of $${reply.capUSD.toFixed(2)} this hour. Unassessed: ${state.stats.unassessed}.`);
    renderStats();
  } catch (error) {
    state.stats.unassessed += batch.length;
    setStatus(`The extension background could not be reached. ${batch.length} messages stay unassessed.`, 'warn');
  } finally {
    state.inFlight--;
  }
}
function pump() {
  if (state.stopped || state.inFlight >= MAX_IN_FLIGHT) return;
  const batch = state.batcher?.take(Date.now());
  if (batch?.length) sendBatch(batch);
}
function stop() {
  state.irc?.close();
  state.irc = null;
  state.decisions.clear();
  state.messages.clear();
  state.order = [];
  closePop();
  if (ui) ui.feed.replaceChildren();
}
function attach(channel) {
  stop();
  state.channel = channel;
  state.stopped = '';
  state.stats = {received: 0, assessed: 0, unassessed: 0, requests: 0, latencies: [], tokens: 0, usd: 0, model: ''};
  state.batcher = new Batcher({maxSize: 20, maxWaitMs: 800, maxPerSecond: state.maxPerSecond});
  renderStats();
  setStatus(state.hasKey ? `Connecting to #${channel}.` : 'Add your TypeSafe API key on the options page. Nothing is judged without it.', state.hasKey ? '' : 'stop');
  if (state.hasKey) hideCard(); else showCard('no_key');
  state.irc = new TwitchIRC({
    channel,
    onMessage: message => {
      state.stats.received++;
      if (state.stopped) { state.stats.unassessed++; renderStats(); return; }
      if (state.batcher.add(message, Date.now()) === 'unassessed') state.stats.unassessed++;
      renderStats();
    },
    onRemoval: removal => {
      if (removal.kind === 'message') removeRows(m => m.id === removal.id);
      else if (removal.kind === 'user') removeRows(m => m.login === removal.login);
      else removeRows(() => true);
    },
    onStatus: info => { if (info.state === 'reconnecting') setStatus(`Reconnecting to #${channel} in ${Math.round(info.inMs / 100) / 10}s.`, 'warn'); }
  });
  state.irc.connect();
}
function route() {
  const channel = channelFromPath(location.pathname);
  if (channel === state.channel && (channel === '' || state.irc)) return;
  if (!channel) { stop(); state.channel = ''; ui.panel.hidden = true; return; }
  ui.panel.hidden = false;
  attach(channel);
}
export async function start() {
  styles();
  build();
  try {
    const settings = await chrome.runtime.sendMessage({type: 'jev.settings'});
    state.hasKey = Boolean(settings?.hasKey);
    state.maxPerSecond = settings?.maxPerSecond ?? 10;
  } catch { /* defaults stay in place */ }
  for (const name of ['pushState', 'replaceState']) {
    const original = history[name].bind(history);
    history[name] = (...args) => { const out = original(...args); setTimeout(route, 0); return out; };
  }
  addEventListener('popstate', () => setTimeout(route, 0));
  setInterval(pump, PUMP_MS);
  route();
}

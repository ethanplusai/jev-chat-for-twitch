/** Twitch IRC over WebSocket: line parsing, message shaping and an anonymous read-only client.
 * Nothing here scrapes the Twitch page. The chat comes from the public anonymous IRC endpoint. */
export const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const TAG_UNESCAPE = {':': ';', 's': ' ', '\\': '\\', 'r': '\r', 'n': '\n'};
/** IRCv3 tag values escape ; SPACE \ CR and LF. A trailing lone backslash is dropped. */
export function unescapeTag(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '\\') { out += value[i]; continue; }
    const next = value[i + 1];
    if (next === undefined) break;
    out += Object.hasOwn(TAG_UNESCAPE, next) ? TAG_UNESCAPE[next] : next;
    i++;
  }
  return out;
}
/** Parse one raw line into {tags, prefix, command, params}. Trailing keeps every ':' it contains. */
export function parseLine(line) {
  let rest = line.replace(/[\r\n]+$/, '');
  if (!rest) return null;
  const tags = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    if (end < 0) return null;
    for (const pair of rest.slice(1, end).split(';')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      tags[key] = eq < 0 ? '' : unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(end + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  const params = [];
  while (rest.length) {
    if (rest.startsWith(':')) { params.push(rest.slice(1)); rest = ''; break; }
    const end = rest.indexOf(' ');
    if (end < 0) { params.push(rest); rest = ''; break; }
    if (end > 0) params.push(rest.slice(0, end));
    rest = rest.slice(end + 1);
  }
  const command = params.shift();
  return command ? {tags, prefix, command: command.toUpperCase(), params} : null;
}
const ID_SAFE = /[^a-zA-Z0-9_-]/g;
let fallbackSeq = 0;
/** A PRIVMSG frame becomes the message object the batcher and the panel use. */
export function privmsgToMessage(frame, {now = Date.now} = {}) {
  if (!frame || frame.command !== 'PRIVMSG' || frame.params.length < 2) return null;
  const body = frame.params[1];
  if (typeof body !== 'string' || !body.trim()) return null;
  const login = frame.prefix.split('!')[0] ?? '';
  const author = (frame.tags['display-name'] || login || 'unknown').slice(0, 40);
  const sent = Number(frame.tags['tmi-sent-ts']);
  const raw = frame.tags.id || `local_${Date.now().toString(36)}_${fallbackSeq++}`;
  return {
    id: raw.replace(ID_SAFE, '').slice(0, 64) || `local_${fallbackSeq++}`,
    author, login, body: body.slice(0, 500),
    color: /^#[0-9a-fA-F]{6}$/.test(frame.tags.color ?? '') ? frame.tags.color : '',
    userId: (frame.tags['user-id'] ?? '').replace(ID_SAFE, '').slice(0, 32),
    emotes: (frame.tags.emotes ?? '').slice(0, 400),
    at: Number.isSafeInteger(sent) && sent > 0 ? sent : now(),
    channel: (frame.params[0] ?? '').replace(/^#/, '')
  };
}
/** CLEARCHAT and CLEARMSG are moderator deletions. Both remove rows that are already on screen. */
export function removalFromFrame(frame) {
  if (!frame) return null;
  if (frame.command === 'CLEARMSG') {
    const id = (frame.tags['target-msg-id'] ?? '').replace(ID_SAFE, '');
    return id ? {kind: 'message', id} : null;
  }
  if (frame.command === 'CLEARCHAT') {
    const login = (frame.params[1] ?? '').replace(/^:/, '').trim();
    return login ? {kind: 'user', login: login.toLowerCase()} : {kind: 'all'};
  }
  return null;
}
const NON_CHANNEL = new Set(['directory', 'videos', 'settings', 'p', 'downloads', 'store', 'subscriptions',
  'friends', 'wallet', 'drops', 'prime', 'turbo', 'jobs', 'search', 'u', 'moderator', 'popout', 'team',
  'following', 'inventory', 'payments', 'collections', 'broadcast', 'dashboard', 'legal', 'privacy', 'products']);
/** Channel login from a Twitch URL path, or '' when the page is not a channel page. */
export function channelFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts.length !== 1) return '';
  const name = parts[0].toLowerCase();
  if (NON_CHANNEL.has(name) || !/^[a-z0-9_]{3,25}$/.test(name)) return '';
  return name;
}
export const anonymousNick = (random = Math.random) => `justinfan${10000 + Math.floor(random() * 80000)}`;
/** Read-only anonymous client. Reconnects with capped exponential backoff and never sends chat. */
export class TwitchIRC {
  constructor({channel, onMessage, onRemoval, onStatus, socketFactory = url => new WebSocket(url), now = Date.now} = {}) {
    Object.assign(this, {channel, onMessage, onRemoval, onStatus, socketFactory, now});
    this.socket = null; this.attempt = 0; this.timer = null; this.closed = false; this.buffer = '';
  }
  connect() {
    this.closed = false;
    clearTimeout(this.timer);
    try { this.socket = this.socketFactory(IRC_URL); } catch { return this.scheduleReconnect(); }
    this.socket.addEventListener('open', () => {
      this.attempt = 0;
      this.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      this.send('PASS SCHMOOPIIE');
      this.send(`NICK ${anonymousNick()}`);
      this.send(`JOIN #${this.channel}`);
      this.onStatus?.({state: 'connected', channel: this.channel});
    });
    this.socket.addEventListener('message', event => this.receive(String(event.data ?? '')));
    this.socket.addEventListener('close', () => { if (!this.closed) this.scheduleReconnect(); });
    this.socket.addEventListener('error', () => this.onStatus?.({state: 'error', channel: this.channel}));
  }
  send(text) { try { this.socket?.send(`${text}\r\n`); } catch { /* the close handler reconnects */ } }
  receive(chunk) {
    this.buffer = (this.buffer + chunk).slice(-65536);
    const lines = this.buffer.split(/\r\n|\n/);
    this.buffer = lines.pop() ?? '';
    for (const line of lines) this.handle(line);
  }
  handle(line) {
    const frame = parseLine(line);
    if (!frame) return;
    if (frame.command === 'PING') return this.send('PONG :tmi.twitch.tv');
    if (frame.command === 'RECONNECT') { this.socket?.close(); return; }
    if (frame.command === 'PRIVMSG') {
      const message = privmsgToMessage(frame, {now: this.now});
      if (message) this.onMessage?.(message);
      return;
    }
    const removal = removalFromFrame(frame);
    if (removal) this.onRemoval?.(removal);
  }
  scheduleReconnect() {
    if (this.closed) return;
    const wait = Math.min(30000, 500 * 2 ** this.attempt) + Math.floor(Math.random() * 250);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.onStatus?.({state: 'reconnecting', channel: this.channel, inMs: wait});
    this.timer = setTimeout(() => this.connect(), wait);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    try { this.socket?.close(); } catch { /* already gone */ }
    this.socket = null;
  }
}

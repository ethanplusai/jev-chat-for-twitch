# How it works

Technical notes for the Jev Chat for Twitch extension. The root `README.md` covers installing and using it.

## Pipeline

- Chat comes from Twitch's public anonymous IRC WebSocket (`wss://irc-ws.chat.twitch.tv:443`), not from scraping the page DOM. The extension joins read-only as `justinfan<digits>` and never sends chat.
- Messages are batched at **20 messages or 800 ms**, whichever comes first, into one Jev request with one `message_<i>` Choice question per message, over the shared categories and instructions in `extension/chat-policy.mjs`.
- At most **2 requests are in flight**. Anything above the per-second cap or above what the caps allow is counted **unassessed** and is never shown as selected.
- Switching intent re-runs the selection policy locally over the probabilities already stored. It makes no new calls.
- Moderator deletions (`CLEARMSG`, `CLEARCHAT`) remove the matching rows.
- The last 300 selected rows and the last 500 decisions are kept in memory only. Nothing is persisted except your settings and the hourly spend window.
- No message is ever rewritten. Usernames and message text are rendered as text, never as HTML. Every row is an original chat message that a Jev decision selected.

## Files

| File | Purpose |
| --- | --- |
| `extension/manifest.json` | MV3 manifest. `storage` permission only; host permissions limited to `www.twitch.tv`, `irc-ws.chat.twitch.tv`, `api.typesafe.ai`. Default CSP, no remote code. |
| `extension/background.mjs` | Module service worker. The only place that reads the key and the only place that calls Jev. Enforces the hourly spend cap and the 2-in-flight cap, and opens the options page for the content script. |
| `extension/content.mjs` | Classic content script that dynamically imports `panel.mjs` through `chrome.runtime.getURL`, because MV3 content scripts are not modules. |
| `extension/panel.mjs` | The injected column: IRC intake, batching, decision storage, rows, chips, stats, popover, pause pill, narrow toggle, settings gear, onboarding card, SPA routing. |
| `extension/irc.mjs` | IRCv3 line parsing with tag escapes, PRIVMSG shaping, CLEARCHAT/CLEARMSG, channel-path filtering, anonymous client with capped backoff. |
| `extension/jev.mjs` | Request building, answer validation, retry, `Batcher`, `SpendWindow`, `StoredSpendWindow`, and the `pingJev` test request. |
| `extension/chat-policy.mjs` | Categories, selection policies and the intent chips. |
| `extension/options.html` / `options.mjs` | Key, hourly spend cap (default $0.50), maximum messages per second (default 10), and the Test key button. |
| `extension/panel.css` | The column's palette. No Twitch assets. |

The IRC WebSocket runs in the content script (Twitch's own page CSP already allows that host, and the content script survives service-worker suspension), while every Jev call runs in the service worker, so the API key never enters the page context and is not subject to page-origin CORS.

## Settings and state

The column header has a gear button beside **Narrow chat**. A content script cannot call `chrome.runtime.openOptionsPage()`, so the gear sends an `open-options` message to the service worker, which calls it.

The panel body shows one card when something needs attention: no key stored, the hourly cap reached, or a key rejected with HTTP 401. Each card has a button that opens the settings page. The card disappears as soon as a batch is judged.

The hourly spend window is written to `chrome.storage.session` when the browser has it, otherwise to `chrome.storage.local`, as an array of `{ts, usd}` entries pruned to the last hour on read. A service-worker teardown no longer resets the cap.

On the options page, **Test key** sends one tiny Jev request (a single Noul over the text `hello`) through the service worker and reports the round trip and the model id, or the error. The key field stays masked.

## Measured numbers

Measured on a live channel on 2026-09-19 with `jev-1.13.0`. A 20-message batch used 10,075 input tokens in 702 ms, about 504 input tokens per message. A 45-second run on a live esports channel received 104 messages, assessed 103 over 30 requests at a 215 ms median, and selected 21 under the Helpful intent for about $0.0027.

Selection quality was observed on one channel for about a minute. That is evidence the pipeline works end to end, not a measurement of model quality.

## Known limits

- The narrowing rule targets `[data-a-target="right-column"]` and `.right-column` plus a `body` padding. Twitch can rename those at any time; the body padding is the part that actually guarantees room.
- Only `CLEARCHAT` and `CLEARMSG` deletions are handled. Rows removed by Twitch's AutoMod after display are not.
- The per-message instruction still mentions `currentScene`, which this state does not carry (it sends `channel` and `streamTitle` instead). It is kept verbatim so the request shape matches the web app it was ported from.

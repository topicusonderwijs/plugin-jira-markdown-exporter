<div align="center">

# Jira Markdown Exporter

**Export any Jira Cloud issue to clean, portable Markdown — with one click.**

Open source, no telemetry, no API tokens. It uses your existing Jira browser session and does everything locally.

[![License: MIT](https://img.shields.io/badge/License-MIT-0052CC.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome%20%2B%20Firefox-Manifest%20V3-0052CC.svg)](manifest.json)
[![No telemetry](https://img.shields.io/badge/telemetry-none-006644.svg)](#privacy--security)
[![Tests](https://img.shields.io/badge/tests-node%3Atest-006644.svg)](test/)
[![No build step](https://img.shields.io/badge/build-none-42526E.svg)](#development)

</div>

---

## Contents

- [Why](#why)
- [Features](#features)
- [Install](#install-unpacked)
- [Browser support](#browser-support)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Privacy & security](#privacy--security)
- [Permissions](#permissions)
- [Jira Data Center / Server](#jira-data-center--server)
- [Development](#development)
- [Project structure](#project-structure)
- [How this differs from closed-source exporters](#how-this-differs-from-closed-source-exporters)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Why

Copying a Jira issue into a doc, a PR description, an LLM prompt, or a wiki means
losing the formatting or hand-cleaning a wall of HTML. Existing "export to
Markdown" extensions are closed source, sometimes bundle analytics, and
occasionally ask you to paste an API token.

**Jira Markdown Exporter** does the same job in the open: a small, auditable
Manifest V3 extension that converts an issue's **Atlassian Document Format (ADF)**
into faithful Markdown, entirely in your browser.

## Features

- **One-click export** — from the toolbar popup, or a **Copy Markdown** button
  injected right into the issue's action bar.
- **Faithful ADF → Markdown** — headings, all inline marks, nested lists, code
  blocks, tables, panels, task/decision lists, mentions, emoji, dates, status
  lozenges, inline cards, and inline media.
- **Full issue, not just the description** — title, type, status, assignee,
  labels, custom fields, comments, and attachments.
- **No API token** — authenticates with your existing Jira session cookies.
- **Copy or download** — copy to clipboard, save `{ISSUE}.md`, or save the
  Markdown plus every attachment into a self-contained `{ISSUE}/` folder.
- **Remembers your choices** — the comments / custom fields / attachments
  toggles persist between sessions.
- **Works in the board detail panel** — detects the issue from `?selectedIssue=`,
  not just full-page `/browse/` views.
- **Graceful fallback** — scrapes the rendered DOM when the REST API is
  unavailable (restricted or on-prem instances).
- **100% local** — nothing is ever sent to a third-party server.

> 💡 Want to see the UI before installing? Open
> [`docs/popup-preview.html`](docs/popup-preview.html) in any browser.

## Install (unpacked)

The extension ships as plain files — no build step. The same folder loads in
both browser families; see [Browser support](#browser-support).

**Chrome, Edge, Brave**

1. **Download** or clone this repository.
2. Open **`chrome://extensions`**.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the project folder (the one containing
   `manifest.json`).
5. Open any Jira Cloud issue and click the extension icon.

**Firefox** (140+, as set by `strict_min_version`)

1. **Download** or clone this repository.
2. Open **`about:debugging#/runtime/this-firefox`**.
3. Click **Load Temporary Add-on…** and pick the `manifest.json` in the project
   folder.
4. Open any Jira Cloud issue and click the extension icon.

> Temporary add-ons are removed when Firefox restarts. For a permanent install,
> run `npm run build:firefox` and submit / self-distribute the resulting
> `dist/firefox-*.zip` — unsigned add-ons cannot be installed permanently in
> release Firefox.

## Browser support

| | Chrome / Edge / Brave | Firefox |
| --- | --- | --- |
| Manifest | V3 | V3 |
| Background | service worker | event page (`background.scripts`) |
| Extension API | `chrome.*` (promises) | `browser.*` (promises) |
| Host permissions | granted at install | granted at install (Firefox 127+) |

The repository's `manifest.json` declares **both** background forms, so the
unpacked folder works in either browser; each ignores the key it doesn't
support. Every script resolves its API namespace once
(`globalThis.browser ?? globalThis.chrome`) and uses promises throughout —
Firefox's `chrome.*` alias is callback-only, so `browser.*` is what makes
`await` work there.

For store uploads, `npm run build` writes clean per-browser packages to `dist/`
with the irrelevant manifest key stripped (see [Development](#development)).

## Usage

1. Open a Jira Cloud issue — a full page (`…/browse/ABC-123`) or the board/backlog
   **detail panel** (`…?selectedIssue=ABC-123`).
2. Click the extension icon. The popup shows the issue key, type, status, and
   comment/attachment counts.
3. Toggle what to include: **Comments**, **Custom fields**, **Attachments**.
4. Choose an action:
   - **Copy** — Markdown goes straight to your clipboard.
   - **Download** — saves `{ISSUE}.md`; with **Attachments** on, you get an
     `{ISSUE}/` folder containing `{ISSUE}.md` and every attachment.

You can also click the **Copy Markdown** button injected next to the issue's
"Add" action, without opening the popup.

## How it works

```
┌─────────┐   export    ┌──────────────────────────────┐   GET /rest/api/3/issue
│  Popup  │ ──────────▶ │  Content script              │ ─────────────────────────▶ Jira
│ (UI)    │ ◀────────── │  (same-origin, uses cookies) │ ◀─── ADF JSON ─────────────
└────┬────┘   markdown  └──────────────────────────────┘
     │ download
     ▼
┌───────────────────┐   downloads API (.md + attachments)
│ Background script │ ─────────────────────────────────────▶ Downloads/{ISSUE}/
└───────────────────┘
```

1. A **content script** on `*.atlassian.net` detects the current issue key from
   the URL (or the open detail panel).
2. Because it runs **same-origin** with the Jira tab, it calls
   `GET /rest/api/3/issue/{key}?expand=names,renderedFields` with
   `credentials: "include"` — your session cookies authenticate the request. No
   token, no OAuth.
3. The returned **ADF** is converted by
   [`src/adfToMarkdown.js`](src/adfToMarkdown.js) and assembled into a full
   document by [`src/jiraToMarkdown.js`](src/jiraToMarkdown.js).
4. Attachments are downloaded natively by the **background script** via the
   `downloads` API (cookies + redirects, no CORS) — Jira's attachment URLs
   redirect to a media CDN that blocks cross-origin `fetch`, so they can't be
   read in-page, but a native download works.
5. The generated `.md` is handed to the background script as **text**, which
   turns it into the URL form its browser's `downloads` API accepts: a `blob:`
   URL in Firefox (which rejects `data:` URLs, but whose background context is a
   real page), a `data:` URL in Chrome (whose service worker has no
   `URL.createObjectURL`).

All cookie-authenticated network access happens **only** in the content script,
which keeps the extension's permission surface small.

### The converter is reusable on its own

[`src/adfToMarkdown.js`](src/adfToMarkdown.js) is written UMD-style, so it runs in
the browser **and** as a Node module with zero dependencies:

```js
const { adfToMarkdown } = require('./src/adfToMarkdown.js');

console.log(adfToMarkdown(adfDocument, { baseUrl: 'https://acme.atlassian.net' }));
```

## Privacy & security

- **No third-party servers.** Issue data never leaves your browser.
- **No telemetry, no analytics, no remote code.**
- **No stored credentials.** Auth is your existing session cookie, used only for
  same-origin requests to your Jira instance.
- **Auditable.** Plain, unminified vanilla JS — read every line.

## Permissions

| Permission | Why it's needed |
| --- | --- |
| `host_permissions: https://*.atlassian.net/*` | Run the content script on Jira Cloud and read issue data from its API. |
| `activeTab` | Let the popup talk to the Jira tab you opened it on. |
| `scripting` | Inject the content script on demand if the tab was open before the extension loaded (so you don't have to reload the tab). |
| `downloads` | Save the `.md` file and download attachments. |
| `clipboardWrite` | The **Copy to Clipboard** action. |
| `storage` | Remember your export toggles between sessions. |
| `optional_host_permissions: https://*/*` | Requested **only** if you enable Data Center support for a self-hosted domain. Not granted by default. |

In Firefox 127 and later, host permissions are shown in the install prompt and
granted on installation, as in Chrome; on earlier versions they had to be
enabled by hand. The extension also declares that it collects no data
(`data_collection_permissions: { "required": ["none"] }`), which Firefox
understands from version 140 — hence `strict_min_version: "140.0"`, in line
with the current ESR.

## Jira Data Center / Server

The extension targets **Jira Cloud** first. Self-hosted instances differ:

- **API path & format.** Cloud uses `/rest/api/3/` (ADF). Data Center / Server use
  `/rest/api/2/`, which returns **wiki markup** rather than ADF. The content
  script tries `/3/` then falls back to `/2/`; where a v2 response isn't ADF, the
  **DOM-scraping fallback** ([`src/domScraper.js`](src/domScraper.js)) fills the
  gap.
- **Host permission.** Your DC instance isn't on `atlassian.net`. To use it, add
  your domain to `content_scripts[].matches` and `host_permissions` in
  `manifest.json` (e.g. `https://jira.mycompany.com/*`) and reload the extension.

## Development

No dependencies, no bundler. Requires Node ≥ 18 for the tests.

```bash
npm test              # run unit tests (node:test) — no deps
npm run build         # write dist/chrome/ + dist/firefox/ (and .zip if `zip` exists)
npm run build:firefox # one target only
```

`scripts/build.mjs` copies the extension files and rewrites `manifest.json` per
target: Chrome keeps `background.service_worker` (and loses
`browser_specific_settings`), Firefox keeps `background.scripts`. This is only
needed for store uploads — the repo folder itself loads unpacked in both.

Tests live in [`test/`](test/) and cover the ADF converter and the full-issue
assembler. Both modules are dependency-free UMD, so they run directly under
`node --test` with no DOM or bundler.

## Project structure

```
jira-markdown-exporter/
├── manifest.json                # MV3 manifest (Chrome + Firefox background keys)
├── scripts/build.mjs            # per-browser packages in dist/ (no deps)
├── src/
│   ├── background.js            # SW (Chrome) / event page (Firefox): owns downloads
│   ├── content.js               # issue detection, cookie-auth API fetch, in-page button
│   ├── adfToMarkdown.js         # ⭐ standalone ADF → Markdown converter (UMD, unit-tested)
│   ├── jiraToMarkdown.js        # assembles a full issue into one Markdown document
│   ├── domScraper.js            # DOM-scraping fallback for restricted instances
│   └── popup.html / .css / .js  # popup UI, export options, downloads
├── icons/                       # generated PNG icons (16 / 48 / 128)
├── docs/popup-preview.html      # standalone design preview of the popup
├── tools/generate-icons.js      # regenerates icons with zero dependencies
├── test/                        # node:test unit tests (no deps)
├── package.json
├── LICENSE                      # MIT
└── README.md
```

## How this differs from closed-source exporters

| | Jira Markdown Exporter | Typical closed-source exporter |
| --- | --- | --- |
| License | **MIT, source-available** | Proprietary |
| Telemetry | **None** | Often bundled analytics |
| Data flow | **Local only** | May proxy through vendor servers |
| Auth | **Existing session cookies** | Sometimes requires an API token |
| Auditability | **Plain, unminified JS** | Minified / obfuscated |
| ADF conversion | **Open, unit-tested module** | Black box |

## Limitations

- Inline-image links in the Markdown point to Jira URLs (online); the downloaded
  local copies aren't yet referenced from the `.md`.
- The DOM-scraping fallback is best-effort and depends on Jira's current markup.
- Very old Data Center wiki markup is passed through rather than fully re-parsed
  (use the DOM fallback there).

## Contributing

Issues and pull requests are welcome. Please keep the **no build step / no runtime
dependencies** constraint — prefer vanilla JS. If a bundler ever becomes
necessary, [Vite](https://vitejs.dev/) is the intended choice. Run `npm test`
before opening a PR.

## License

[MIT](LICENSE) © 2026 Topicus.Education BV. Built by Adnan al Jawabra and Pim Jansen.

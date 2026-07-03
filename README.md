# Jira Markdown Exporter

A free, open-source (MIT) **Manifest V3 Chrome extension** that exports Jira
Cloud issues to clean **Markdown**. Open an issue, click the extension icon, and
copy or download the whole issue — description, comments, custom fields,
attachments — as a portable `.md` file.

It is a transparent, no-telemetry alternative to closed-source exporters such as
"Jira Export Markdown".

- ✅ **No API tokens.** Authenticates with your existing Jira browser session.
- ✅ **100% local.** Nothing is ever sent to a third-party server.
- ✅ **Auditable.** Vanilla JS, no build step, no minified blobs.
- ✅ **ADF-aware.** Faithful Atlassian Document Format → Markdown conversion.
- ✅ **Attachment bundling.** Optionally download `{ISSUE}.zip` with images/files.
- ✅ **Fallback mode.** DOM scraping when the REST API is unavailable.

---

## How it works

1. A content script runs on `*.atlassian.net` and detects the current issue key
   from the tab URL (`/browse/EFK-549`, board `?selectedIssue=…`, etc.).
2. Because that script runs **same-origin** with the Jira tab, it calls
   `GET /rest/api/3/issue/{key}?expand=names,renderedFields` with
   `credentials: "include"` — your logged-in session cookies authenticate the
   request automatically. No token entry, no OAuth dance.
3. The returned **Atlassian Document Format (ADF)** is converted to Markdown by
   [`src/adfToMarkdown.js`](src/adfToMarkdown.js) and assembled into a full
   document by [`src/jiraToMarkdown.js`](src/jiraToMarkdown.js).
4. The popup offers **Copy to Clipboard** and **Download `.md`** (with an
   optional **Bundle attachments (.zip)** toggle).

```
Popup ──"export"──▶ Content script (same-origin fetch, cookies)
  ▲                        │
  │◀── markdown + meta ─────┘
  │
  └──"download"──▶ Background worker ──▶ chrome.downloads
```

All cookie-authenticated network access happens **only** in the content script.
The popup and background worker never touch Jira directly, which keeps the
permission surface minimal.

---

## Install (unpacked)

1. Clone or download this repository.
2. (Optional) regenerate icons: `npm run icons` (only needed if you edit them).
3. Open `chrome://extensions` in Chrome/Edge/Brave.
4. Toggle **Developer mode** (top-right).
5. Click **Load unpacked** and select the project folder (the one containing
   `manifest.json`).
6. Open any Jira Cloud issue (e.g. `https://acme.atlassian.net/browse/ABC-1`)
   and click the extension icon — or use the injected **⧉ Copy Markdown** button
   next to the issue title.

No build step is required; the extension ships as plain files.

---

## Permissions & why each is needed

| Permission | Why |
| --- | --- |
| `host_permissions: https://*.atlassian.net/*` | Run the content script on Jira Cloud and read issue data from its API. |
| `activeTab` | Let the popup talk to the issue tab you explicitly opened it on. |
| `downloads` | Save the generated `.md` / `.zip` file. |
| `clipboardWrite` | "Copy to Clipboard" action. |
| `optional_host_permissions: https://*/*` | Requested **only** if you enable Data Center support for a self-hosted domain (see below). Not granted by default. |

There is no `storage`, no analytics, no remote code. Read the source — it's
short.

---

## Data Center / Server (self-hosted Jira)

The extension targets **Jira Cloud** first. Self-hosted Jira differs:

- **API path:** Cloud uses `/rest/api/3/` (which returns ADF). Data Center /
  Server use **`/rest/api/2/`**, which returns **wiki markup** (not ADF) in
  rich-text fields. The content script already tries `/3/` then falls back to
  `/2/`; when a v2 response contains wiki markup rather than ADF, the ADF
  converter passes plain strings through unchanged and the **DOM-scraping
  fallback** ([`src/domScraper.js`](src/domScraper.js)) fills the gap.
- **Host permission:** your DC instance is not on `atlassian.net`. To use it,
  add your domain to `manifest.json` `content_scripts[].matches` and
  `host_permissions` (e.g. `https://jira.mycompany.com/*`), then reload the
  extension. The `optional_host_permissions` entry is there so a future UI can
  request this at runtime instead.

---

## Project structure

```
jira-markdown-exporter/
├── manifest.json              # MV3 manifest
├── src/
│   ├── background.js          # service worker: owns downloads
│   ├── content.js             # issue detection, cookie-auth API fetch, in-page button
│   ├── adfToMarkdown.js       # ⭐ standalone ADF → Markdown converter (UMD, unit-tested)
│   ├── jiraToMarkdown.js      # assembles a full issue into one Markdown doc
│   ├── domScraper.js          # DOM-scraping fallback for restricted instances
│   ├── zip.js                 # dependency-free ZIP (STORE) writer for attachment bundles
│   ├── popup.html/.css/.js    # popup UI + export options
├── icons/                     # generated PNG icons (16/48/128)
├── tools/generate-icons.js    # regenerates icons with zero deps
├── test/                      # node:test unit tests (no deps)
├── package.json
├── LICENSE                    # MIT
└── README.md
```

### The converter is reusable on its own

[`src/adfToMarkdown.js`](src/adfToMarkdown.js) is written UMD-style — it runs in
the browser (as a content-script global `adfToMarkdown`) **and** as a Node
module — so you can reuse it outside the extension:

```js
const { adfToMarkdown } = require('./src/adfToMarkdown.js');
console.log(adfToMarkdown(someAdfDocument, { baseUrl: 'https://acme.atlassian.net' }));
```

It handles paragraphs, headings, all inline marks (bold/italic/strike/underline/
sub-sup/code/links), bullet & ordered lists (nested), code blocks, blockquotes,
rules, hard breaks, mentions, emoji, dates, status lozenges, inline/embed cards,
tables, task lists, decision lists, panels, expands, and inline media (via a
pluggable `mediaResolver`).

---

## Development

```bash
npm test          # run the unit tests (node:test, Node 18+, no deps)
npm run icons     # regenerate PNG icons
```

Tests live in [`test/`](test/) and cover the ADF converter and the full-issue
assembler. Because both modules are dependency-free UMD, they run directly under
`node --test` with no bundler or DOM.

---

## How this differs from closed-source alternatives

| | This extension | Typical closed-source exporter |
| --- | --- | --- |
| License | **MIT, source-available** | Proprietary |
| Telemetry | **None** | Often bundled analytics |
| Data flow | **Local only** | May proxy through vendor servers |
| Auth | **Existing session cookies** | Sometimes requires pasting an API token |
| Auditability | **Plain, unminified JS** | Minified / obfuscated |
| ADF conversion | **Open, unit-tested module** | Black box |

---

## Limitations

- Inline-image resolution depends on Jira exposing the attachment `content` URL;
  images embedded from external sources are linked, not downloaded.
- The DOM-scraping fallback is best-effort and depends on Jira's current markup.
- Wiki-markup rich text from very old Data Center instances is passed through
  rather than fully re-parsed (use the DOM fallback there).

## Contributing

Issues and PRs welcome. Keep the "no build step / no runtime deps" constraint:
prefer vanilla JS, and if a bundler becomes necessary, Vite is the intended
choice.

## License

[MIT](LICENSE) © 2026 Adnan al Jawabra

/*
 * content.js
 * ----------
 * Runs in the page context of every *.atlassian.net tab.
 *
 * Responsibilities:
 *   1. Detect the current issue key + Jira base URL from the URL / DOM.
 *   2. Fetch issue data from the REST API. Because this code runs *same-origin*
 *      with the Jira tab, `credentials: "include"` reuses the user's existing
 *      session cookies — no API token needed.
 *   3. Convert to Markdown via jiraToMarkdown / adfToMarkdown (loaded before
 *      this file), falling back to DOM scraping when the API is unavailable.
 *   4. Answer messages from the popup, and inject an in-page "Copy Markdown"
 *      button next to the issue title.
 *
 * All conversion is local; nothing leaves the browser.
 */
(function () {
  'use strict';

  // Jira Cloud = /rest/api/3/ (ADF). Data Center = /rest/api/2/ (wiki markup).
  // We try v3 first, then v2 as a fallback for on-prem instances.
  const API_VERSIONS = ['3', '2'];

  function getBaseUrl() {
    return `${location.protocol}//${location.host}`;
  }

  const KEY_RE = /([A-Z][A-Z0-9]+-\d+)/;

  function decodeUrl(u) {
    try {
      return decodeURIComponent(u);
    } catch (_) {
      return u;
    }
  }

  // Detect the issue key from a variety of Jira URL shapes plus the DOM.
  //
  // Priority matters: on a board or backlog the *path* often contains a project
  // key that is NOT the issue currently open in the detail panel (e.g.
  // /projects/ABC/boards/1?selectedIssue=DEF-2). So query/hash params that name
  // the focused issue are checked before path-based patterns, and the DOM
  // fallback is scoped to the open modal — never a card sitting behind it.
  function detectIssueKey() {
    const href = decodeUrl(location.href);

    // 1. Params that identify the *focused* issue (board / backlog modal view).
    const paramPatterns = [
      /[?&#]selectedIssue=([A-Z][A-Z0-9]+-\d+)/, // ?selectedIssue=ABC-1 (board/backlog modal)
      /[?&#]issueKey=([A-Z][A-Z0-9]+-\d+)/,
      /[?&#](?:modal|issue)=([A-Z][A-Z0-9]+-\d+)/, // ?modal=ABC-1 / ?issue=ABC-1
    ];
    for (const re of paramPatterns) {
      const m = href.match(re);
      if (m) return m[1];
    }

    // 2. Direct issue paths (full-page views).
    const pathPatterns = [
      /\/browse\/([A-Z][A-Z0-9]+-\d+)/, // /browse/EFK-549
      /\/issues\/([A-Z][A-Z0-9]+-\d+)/, // /jira/.../issues/EFK-549
      /\/queues\/[^?#]*?\/([A-Z][A-Z0-9]+-\d+)/, // JSM queues .../queues/custom/1/ABC-1
    ];
    for (const re of pathPatterns) {
      const m = href.match(re);
      if (m) return m[1];
    }

    // 3. DOM fallback, scoped to the open issue modal / detail panel so we do
    //    not accidentally grab a key from a board card rendered behind it.
    const scopedSelectors = [
      '[role="dialog"] a[href*="/browse/"]',
      '[data-testid*="issue-view"] a[href*="/browse/"]',
      '[data-testid*="foundation.breadcrumbs"] a[href*="/browse/"]',
      '#ghx-detail-head a[href*="/browse/"]', // classic RapidBoard detail view
    ];
    for (const sel of scopedSelectors) {
      const el = document.querySelector(sel);
      const src = el && (el.getAttribute('href') || el.textContent);
      const m = src && decodeUrl(src).match(KEY_RE);
      if (m) return m[1];
    }

    // 4. Last resort: a global key element (full-page classic view).
    const globalEl = document.querySelector('#key-val');
    const gm = globalEl && globalEl.textContent.match(KEY_RE);
    return gm ? gm[1] : null;
  }

  function getContext() {
    return { key: detectIssueKey(), baseUrl: getBaseUrl(), host: location.host };
  }

  // Fetch the issue JSON from the REST API using session cookies.
  async function fetchIssueJson(key) {
    let lastError = null;
    for (const version of API_VERSIONS) {
      const url = `${getBaseUrl()}/rest/api/${version}/issue/${encodeURIComponent(
        key
      )}?expand=names,renderedFields`;
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const json = await res.json();
          return { json, version };
        }
        lastError = new Error(`API v${version} responded ${res.status} ${res.statusText}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Failed to reach the Jira REST API.');
  }

  // Produce Markdown for an issue key. Tries the API, then DOM scraping.
  async function exportIssue(key, options) {
    options = options || {};
    key = key || detectIssueKey();
    if (!key) throw new Error('No Jira issue detected on this page.');

    const baseUrl = getBaseUrl();
    try {
      const { json, version } = await fetchIssueJson(key);
      const markdown = self.jiraIssueToMarkdown(json, {
        baseUrl,
        includeComments: options.includeComments !== false,
        includeCustomFields: options.includeCustomFields !== false,
      });
      const attachments = (json.fields && json.fields.attachment) || [];
      return {
        ok: true,
        source: `api-v${version}`,
        key: json.key || key,
        markdown,
        attachments: attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          url: a.content,
          mimeType: a.mimeType,
          size: a.size,
        })),
      };
    } catch (apiError) {
      // Fallback: scrape the rendered DOM (Data Center / restricted access).
      try {
        const scraped = self.JiraDomScraper.scrapeIssue(key);
        return {
          ok: true,
          source: 'dom-scrape',
          key: scraped.key,
          markdown: scraped.markdown,
          attachments: [],
          warning: `REST API unavailable (${apiError.message}); used DOM scraping fallback.`,
        };
      } catch (scrapeError) {
        return {
          ok: false,
          error: `API failed: ${apiError.message}. DOM fallback failed: ${scrapeError.message}`,
        };
      }
    }
  }

  // Download attachment bytes (same-origin, with cookies) and return them as
  // base64 so they can be transferred to the popup for zipping.
  async function fetchAttachments(attachments) {
    const results = [];
    for (const att of attachments || []) {
      if (!att.url) continue;
      try {
        const res = await fetch(att.url, { credentials: 'include' });
        if (!res.ok) throw new Error(`${res.status}`);
        const buf = await res.arrayBuffer();
        results.push({
          filename: att.filename || `attachment-${att.id}`,
          base64: arrayBufferToBase64(buf),
        });
      } catch (err) {
        results.push({ filename: att.filename, error: String(err) });
      }
    }
    return results;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---- messaging with the popup ---------------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.action === 'getContext') {
          sendResponse({ ok: true, context: getContext() });
        } else if (msg.action === 'export') {
          sendResponse(await exportIssue(msg.key, msg.options));
        } else if (msg.action === 'fetchAttachments') {
          sendResponse({ ok: true, files: await fetchAttachments(msg.attachments) });
        } else {
          sendResponse({ ok: false, error: `Unknown action: ${msg.action}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true; // keep the message channel open for the async response
  });

  // ---- in-page "Copy Markdown" button ---------------------------------------

  let injecting = false;

  async function copyMarkdownFromButton(btn) {
    const original = btn.textContent;
    btn.textContent = '⏳ Exporting…';
    btn.disabled = true;
    try {
      const result = await exportIssue(null, {});
      if (!result.ok) throw new Error(result.error);
      await navigator.clipboard.writeText(result.markdown);
      btn.textContent = '✅ Copied!';
    } catch (err) {
      btn.textContent = '⚠️ Failed';
      console.error('[Jira Markdown Exporter]', err);
    } finally {
      setTimeout(() => {
        btn.textContent = original;
        btn.disabled = false;
      }, 2000);
    }
  }

  // Inject the button stylesheet once. Styling lives in a class (.CopyBtnForJira)
  // rather than inline styles so it's easy to tweak and blends with Jira's own
  // buttons (inherits the surrounding font).
  const BUTTON_STYLE_ID = 'jme-copy-md-style';
  function ensureStyle() {
    if (document.getElementById(BUTTON_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = BUTTON_STYLE_ID;
    style.textContent = `
.CopyBtnForJira {
  background-color: rgb(0, 82, 204);
  color: white;
  text-align: center;
  max-width: 100%;
  font-size: inherit;
  font-style: normal;
  font-family: inherit;
  font-weight: 600;
  display: inline-block;
  margin-left: 10px;
  padding: 10px 10px;
  line-height: 1;
  cursor: pointer;
  text-decoration: none;
  border-width: medium;
  border-style: none;
  border-color: currentcolor;
  border-image: initial;
  border-radius: 3px;
}
.CopyBtnForJira:hover { background-color: rgb(7, 71, 166); }
.CopyBtnForJira:disabled { opacity: 0.6; cursor: default; }
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function makeButton() {
    ensureStyle();
    const btn = document.createElement('button');
    btn.id = 'jme-copy-md-btn';
    btn.className = 'CopyBtnForJira';
    btn.type = 'button';
    btn.textContent = '⧉ Copy Markdown';
    btn.title = 'Copy this Jira issue as Markdown';
    btn.addEventListener('click', () => copyMarkdownFromButton(btn));
    return btn;
  }

  // Where to place the button. We deliberately avoid the summary heading: its
  // container doubles as the click-to-edit target, so a button there triggers
  // inline title editing. Instead we place it right after the "Add or create
  // work" (quick-add) trigger, as its *sibling* — never as a child, or we'd
  // nest a <button> inside a <button> and hijack the dropdown.
  //
  // The board/backlog detail panel ("popup" issue view) renders its own
  // quick-add bar, so we look inside an open dialog first, then the full page.
  const ADD_BUTTON_SELECTORS = [
    '[role="dialog"] [data-testid$="add-button-dropdown--trigger"]',
    '[data-testid$="add-button-dropdown--trigger"]',
    '[role="dialog"] [data-testid*="quick-add"][data-testid*="add-button"]',
    '[data-testid*="quick-add"][data-testid*="add-button"]',
  ];

  // Fallback containers to append into if the add-button can't be located.
  const QUICK_ADD_CONTAINER_SELECTORS = [
    '[role="dialog"] [data-testid$="quick-add-items-compact"]',
    '[data-testid$="quick-add-items-compact"]',
    '[data-testid*="foundation.quick-add"]',
    '#opsbar-opsbar-operations', // classic view operations bar
  ];

  const TRIGGER_TESTID_RE = /add-button-dropdown--trigger|quick-add.*add-button/;

  // Insert (or move) the button. Returns true if it found a home.
  function placeButton(btn) {
    // Preferred: as the next sibling of the "Add or create work" trigger.
    for (const sel of ADD_BUTTON_SELECTORS) {
      const trigger = document.querySelector(sel);
      if (trigger && trigger.parentElement) {
        trigger.insertAdjacentElement('afterend', btn);
        return true;
      }
    }
    // Fallback: append into the quick-add row container.
    for (const sel of QUICK_ADD_CONTAINER_SELECTORS) {
      const bar = document.querySelector(sel);
      if (bar) {
        bar.appendChild(btn);
        return true;
      }
    }
    return false;
  }

  function isCorrectlyPlaced(btn) {
    if (!btn || !btn.isConnected) return false;
    const prev = btn.previousElementSibling;
    const tid = prev && prev.getAttribute && prev.getAttribute('data-testid');
    return !!(tid && TRIGGER_TESTID_RE.test(tid));
  }

  function injectButton() {
    if (injecting) return;
    if (!detectIssueKey()) return;

    const existing = document.getElementById('jme-copy-md-btn');
    // Already sitting right after the add-button in the current view: done.
    if (isCorrectlyPlaced(existing)) return;

    injecting = true;
    try {
      // Reuse the existing node if present (moves it) so we never duplicate.
      const btn = existing || makeButton();
      placeButton(btn); // if no anchor yet, we retry on the next DOM mutation
    } finally {
      injecting = false;
    }
  }

  // Jira is a SPA; the title mounts/re-mounts as the user navigates and as the
  // detail modal opens/closes. Observe DOM changes (throttled) and also hook
  // history navigation so we re-check when only the URL changes.
  let scheduled = false;
  function scheduleInject() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      injectButton();
    }, 300);
  }

  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // SPA route changes (opening a board modal updates the URL via pushState
  // without a DOM mutation near the title).
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const ret = original.apply(this, arguments);
      scheduleInject();
      return ret;
    };
  }
  window.addEventListener('popstate', scheduleInject);
  window.addEventListener('hashchange', scheduleInject);

  scheduleInject();
})();

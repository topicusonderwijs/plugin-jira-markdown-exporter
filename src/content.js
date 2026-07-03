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

  // Extract the lightweight fields the popup shows as chips/counts, so it can
  // render an issue summary without re-parsing the whole payload.
  function buildMeta(f, attachments) {
    const person = (u) => (u ? u.displayName || u.name || null : null);
    const commentCount =
      f.comment && (f.comment.total != null ? f.comment.total : (f.comment.comments || []).length);
    return {
      summary: f.summary || '',
      type: f.issuetype ? { name: f.issuetype.name, iconUrl: f.issuetype.iconUrl } : null,
      status: f.status
        ? {
            name: f.status.name,
            category: (f.status.statusCategory && f.status.statusCategory.key) || 'new',
          }
        : null,
      priority: f.priority ? { name: f.priority.name, iconUrl: f.priority.iconUrl } : null,
      assignee: person(f.assignee),
      commentCount: commentCount || 0,
      attachmentCount: (attachments && attachments.length) || 0,
    };
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
        meta: buildMeta(json.fields || {}, attachments),
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
          meta: scraped.meta || {},
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

  // ---- messaging with the popup ---------------------------------------------
  //
  // Note: attachment binaries are downloaded natively by the background worker
  // via chrome.downloads (cookies + redirects, no CORS). We deliberately do NOT
  // fetch them here — Jira's attachment URLs redirect to a media CDN that
  // blocks cross-origin fetch, so in-page fetching always fails.

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg.action === 'getContext') {
          sendResponse({ ok: true, context: getContext() });
        } else if (msg.action === 'export') {
          sendResponse(await exportIssue(msg.key, msg.options));
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

  // Inline SVG icons (no emoji). All use currentColor so they inherit the
  // button's white text colour. 16px, stroke-based (Lucide-style).
  const ICONS = {
    copy:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    spinner:
      '<svg class="jme-spin" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    check:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    alert:
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  };

  function setButtonState(btn, icon, label) {
    btn.querySelector('.jme-ic').innerHTML = icon;
    btn.querySelector('.jme-label').textContent = label;
  }

  async function copyMarkdownFromButton(btn) {
    setButtonState(btn, ICONS.spinner, 'Exporting…');
    btn.disabled = true;
    try {
      const result = await exportIssue(null, {});
      if (!result.ok) throw new Error(result.error);
      await navigator.clipboard.writeText(result.markdown);
      setButtonState(btn, ICONS.check, 'Copied!');
    } catch (err) {
      setButtonState(btn, ICONS.alert, 'Failed');
      console.error('[Jira Markdown Exporter]', err);
    } finally {
      setTimeout(() => {
        setButtonState(btn, ICONS.copy, 'Copy Markdown');
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
.CopyBtnForJira .jme-ic { display: inline-flex; }
.CopyBtnForJira .jme-spin { animation: jme-rotate 0.7s linear infinite; }
@keyframes jme-rotate { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .CopyBtnForJira .jme-spin { animation: none; } }
`;
    (document.head || document.documentElement).appendChild(style);
  }

  function makeButton() {
    ensureStyle();
    const btn = document.createElement('button');
    btn.id = 'jme-copy-md-btn';
    btn.className = 'CopyBtnForJira';
    btn.type = 'button';
    btn.title = 'Copy this Jira issue as Markdown';
    btn.innerHTML = `<span class="jme-ic">${ICONS.copy}</span><span class="jme-label">Copy Markdown</span>`;
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

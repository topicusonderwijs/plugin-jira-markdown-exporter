/*
 * popup.js
 * --------
 * The extension's action popup. Orchestrates the export:
 *   - asks the content script (running same-origin in the Jira tab) for the
 *     issue Markdown + lightweight metadata,
 *   - renders a compact issue card (key, type, status, comment/attachment
 *     counts) — no full Markdown preview, to keep the popup small,
 *   - copies to clipboard, or downloads a .md file (optionally a .zip bundling
 *     attachments) via the background service worker.
 *
 * The popup never touches the network itself — all cookie-authenticated
 * requests happen in the content script — so this file stays permission-light.
 */
(function () {
  'use strict';

  // Firefox exposes the promise-based `browser` namespace; its `chrome` alias
  // is callback-only. Chrome has no `browser`, and its MV3 `chrome` APIs return
  // promises. Using this alias everywhere keeps one promise-based code path.
  const api = globalThis.browser ?? globalThis.chrome;

  const REPO_URL = 'https://github.com/topicusonderwijs/plugin-jira-markdown-exporter';

  const el = (id) => document.getElementById(id);

  const stateEl = el('state');
  const stateText = el('state-text');
  const issueCard = el('issue-card');
  const optionsEl = el('options');
  const actionsEl = el('actions');
  const badgeEl = el('source-badge');
  const msgEl = el('msg');
  const btnCopy = el('btn-copy');
  const btnDownload = el('btn-download');

  const state = {
    tabId: null,
    baseUrl: '',
    key: null,
    markdown: '',
    attachments: [],
    meta: {},
    source: '',
  };

  el('link-repo').addEventListener('click', (e) => {
    e.preventDefault();
    api.tabs.create({ url: REPO_URL });
  });

  // ---- UI state helpers -----------------------------------------------------

  function showLoading(text) {
    stateEl.classList.remove('hidden', 'error');
    stateText.textContent = text || 'Loading…';
    issueCard.classList.add('hidden');
    optionsEl.classList.add('hidden');
    actionsEl.classList.add('hidden');
    badgeEl.classList.add('hidden');
  }

  function showError(text) {
    stateEl.classList.remove('hidden');
    stateEl.classList.add('error');
    stateText.textContent = text;
    issueCard.classList.add('hidden');
    optionsEl.classList.add('hidden');
    actionsEl.classList.add('hidden');
  }

  function showIssue() {
    stateEl.classList.add('hidden');
    issueCard.classList.remove('hidden');
    optionsEl.classList.remove('hidden');
    actionsEl.classList.remove('hidden');
  }

  // Small inline check icon (no emoji) shown before success messages. Built as
  // real DOM nodes rather than a markup string so nothing is assigned to
  // innerHTML — add-on review flags that, and parsing markup here buys nothing.
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function makeCheckIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = {
      viewBox: '0 0 24 24',
      width: '13',
      height: '13',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    };
    for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    svg.appendChild(path);
    return svg;
  }

  function setMessage(text, kind) {
    msgEl.className = 'msg' + (kind ? ' ' + kind : '');
    msgEl.textContent = '';
    if (!text) return;
    if (kind === 'ok') {
      const ic = document.createElement('span');
      ic.className = 'msg-ic';
      ic.appendChild(makeCheckIcon());
      msgEl.appendChild(ic);
    }
    const t = document.createElement('span');
    t.className = 'msg-text';
    t.textContent = text;
    msgEl.appendChild(t);
  }

  // ---- messaging ------------------------------------------------------------

  // Rejects when no content script is listening (both browsers).
  function sendToTab(tabId, message) {
    return api.tabs.sendMessage(tabId, message);
  }

  async function getActiveTab() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  const CONTENT_FILES = [
    'src/adfToMarkdown.js',
    'src/jiraToMarkdown.js',
    'src/domScraper.js',
    'src/content.js',
  ];

  // Ask the content script for context. If it isn't there — which happens when
  // the tab was open before the extension was (re)loaded — inject it on demand
  // and retry once. Removes the "reload the tab" gotcha.
  async function getContextWithInjection(tabId) {
    try {
      const resp = await sendToTab(tabId, { action: 'getContext' });
      return resp && resp.context;
    } catch (err) {
      const missing = /Receiving end does not exist|Could not establish connection/i.test(
        err.message || ''
      );
      if (!missing) throw err;
      await api.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      const resp = await sendToTab(tabId, { action: 'getContext' });
      return resp && resp.context;
    }
  }

  function currentOptions() {
    return {
      includeComments: el('opt-comments').checked,
      includeCustomFields: el('opt-customfields').checked,
      includeStrikethrough: el('opt-strikethrough').checked,
    };
  }

  // ---- persisted option preferences -----------------------------------------
  // Remember how the user left the toggles, so they stay that way next time.
  const PREFS_KEY = 'exportPrefs';
  const DEFAULT_PREFS = {
    includeComments: true,
    includeCustomFields: true,
    includeStrikethrough: true,
    includeAttachments: false,
  };

  // Source of truth for the attachments preference. The checkbox gets force-
  // disabled/unchecked on issues that have no attachments, so we can't read the
  // user's actual intent back off the DOM — we keep it here instead.
  let attachmentPref = DEFAULT_PREFS.includeAttachments;

  async function loadPrefs() {
    try {
      const data = await api.storage.local.get(PREFS_KEY);
      return { ...DEFAULT_PREFS, ...((data && data[PREFS_KEY]) || {}) };
    } catch (err) {
      return { ...DEFAULT_PREFS };
    }
  }

  function savePrefs() {
    const prefs = {
      includeComments: el('opt-comments').checked,
      includeCustomFields: el('opt-customfields').checked,
      includeStrikethrough: el('opt-strikethrough').checked,
      includeAttachments: attachmentPref,
    };
    api.storage.local.set({ [PREFS_KEY]: prefs });
  }

  function applyPrefs(prefs) {
    el('opt-comments').checked = !!prefs.includeComments;
    el('opt-customfields').checked = !!prefs.includeCustomFields;
    el('opt-strikethrough').checked = !!prefs.includeStrikethrough;
    attachmentPref = !!prefs.includeAttachments;
    el('opt-attachments').checked = attachmentPref;
  }

  // ---- rendering ------------------------------------------------------------

  function renderIssue() {
    const meta = state.meta || {};

    const keyEl = el('issue-key');
    keyEl.textContent = state.key || '—';
    keyEl.href = state.baseUrl && state.key ? `${state.baseUrl}/browse/${state.key}` : '#';

    el('issue-summary').textContent = meta.summary || '(no summary)';

    // Type chip (with icon if available)
    const typeChip = el('type-chip');
    if (meta.type && meta.type.name) {
      typeChip.replaceChildren();
      if (meta.type.iconUrl) {
        const img = document.createElement('img');
        img.src = meta.type.iconUrl;
        img.alt = '';
        img.onerror = () => img.remove();
        typeChip.appendChild(img);
      }
      typeChip.appendChild(document.createTextNode(meta.type.name));
      typeChip.classList.remove('hidden');
    } else {
      typeChip.classList.add('hidden');
    }

    // Status chip (coloured by category)
    const statusChip = el('status-chip');
    if (meta.status && meta.status.name) {
      statusChip.textContent = meta.status.name;
      statusChip.setAttribute('data-category', meta.status.category || 'new');
      statusChip.classList.remove('hidden');
    } else {
      statusChip.classList.add('hidden');
    }

    // Counts
    el('comment-count').textContent = meta.commentCount != null ? meta.commentCount : 0;
    el('attachment-count').textContent =
      meta.attachmentCount != null ? meta.attachmentCount : state.attachments.length;

    // Source badge
    if (state.source === 'dom-scrape') {
      badgeEl.textContent = 'DOM fallback';
      badgeEl.classList.add('warn');
    } else {
      badgeEl.textContent = 'REST API';
      badgeEl.classList.remove('warn');
    }
    badgeEl.classList.remove('hidden');

    // Attachment toggle only meaningful when attachments exist
    const attToggle = el('opt-attachments');
    const attRow = el('row-attachments');
    const hasAtt = state.attachments.length > 0;
    attToggle.disabled = !hasAtt;
    attRow.classList.toggle('disabled', !hasAtt);
    // Reflect the saved preference when attachments exist; force off (display
    // only) when there are none — without touching the stored preference.
    attToggle.checked = hasAtt ? attachmentPref : false;
    el('att-folder').textContent = state.key || 'issue';
  }

  // ---- export flow ----------------------------------------------------------

  async function runExport() {
    showLoading('Reading issue…');
    let response;
    try {
      response = await sendToTab(state.tabId, {
        action: 'export',
        key: state.key,
        options: currentOptions(),
      });
    } catch (err) {
      showError('Lost connection to the Jira page. Reload the tab and retry.');
      return;
    }

    if (!response || !response.ok) {
      showError((response && response.error) || 'Export failed.');
      return;
    }

    state.key = response.key || state.key;
    state.markdown = response.markdown || '';
    state.attachments = response.attachments || [];
    state.meta = response.meta || {};
    state.source = response.source || '';

    renderIssue();
    showIssue();

    const lines = state.markdown ? state.markdown.split('\n').length : 0;
    if (response.warning) setMessage(response.warning, 'error');
    else setMessage(`Ready · ${lines} lines of Markdown`);
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(state.markdown);
      setMessage(`Copied ${state.key} to clipboard`, 'ok');
    } catch (err) {
      setMessage('Clipboard blocked by the browser.', 'error');
    }
  }

  async function onDownload() {
    const includeAttachments = el('opt-attachments').checked && state.attachments.length > 0;
    btnDownload.disabled = true;
    try {
      // When bundling attachments, keep everything together inside the {key}/
      // folder (…/{key}.md + …/attachments). Otherwise save {key}.md at the
      // Downloads root.
      const mdName = includeAttachments ? `${state.key}/${state.key}.md` : `${state.key}.md`;
      await downloadText(state.markdown, mdName);

      if (!includeAttachments) {
        setMessage(`Downloaded ${state.key}.md`, 'ok');
        return;
      }

      // Attachments: hand each remote URL to the downloads API, which downloads
      // it natively (cookies + redirects, no CORS) into a {key}/ folder. We
      // can't fetch the bytes in-page — Jira's media CDN blocks cross-origin
      // fetch — so a client-side .zip isn't possible; a folder is.
      setMessage('Downloading attachments…');
      let ok = 0;
      let failed = 0;
      for (const att of state.attachments) {
        if (!att.url) {
          failed++;
          continue;
        }
        try {
          await downloadUrl(att.url, `${state.key}/${att.filename}`);
          ok++;
        } catch (e) {
          failed++;
        }
      }
      setMessage(
        `Downloaded ${state.key}.md + ${ok} attachment(s)${failed ? ` (${failed} failed)` : ''}`,
        failed ? 'error' : 'ok'
      );
    } catch (err) {
      setMessage('Download failed: ' + (err.message || err), 'error');
    } finally {
      btnDownload.disabled = false;
    }
  }

  // Route a download through the background script (it survives popup close).
  async function requestDownload(payload) {
    const resp = await api.runtime.sendMessage({ action: 'download', ...payload });
    if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'download failed');
    return resp;
  }

  // Download a remote URL (e.g. a Jira attachment) by its href.
  function downloadUrl(url, filename) {
    return requestDownload({ url, filename });
  }

  // Download generated text (the Markdown). The background script turns it into
  // whatever URL form its browser's downloads API accepts — blob: in Firefox,
  // data: in Chrome — so the popup can close without killing the download.
  function downloadText(text, filename) {
    return requestDownload({ text, mime: 'text/markdown', filename });
  }

  btnCopy.addEventListener('click', onCopy);
  btnDownload.addEventListener('click', onDownload);
  // Comments / custom fields change the generated Markdown → persist + re-export.
  el('opt-comments').addEventListener('change', () => {
    savePrefs();
    runExport();
  });
  el('opt-customfields').addEventListener('change', () => {
    savePrefs();
    runExport();
  });
  el('opt-strikethrough').addEventListener('change', () => {
    savePrefs();
    runExport();
  });
  // Attachments only affects download, not the Markdown → update intent + persist.
  el('opt-attachments').addEventListener('change', () => {
    attachmentPref = el('opt-attachments').checked;
    savePrefs();
  });

  // ---- bootstrap ------------------------------------------------------------

  (async function init() {
    showLoading('Detecting issue…');
    // Restore the toggles to how the user last left them before exporting.
    applyPrefs(await loadPrefs());

    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      showError('No active tab.');
      return;
    }
    state.tabId = tab.id;

    let ctx;
    try {
      ctx = await getContextWithInjection(tab.id);
    } catch (err) {
      showError('This tab isn’t a Jira page. Open a Jira issue and try again.');
      return;
    }

    if (!ctx || !ctx.key) {
      showError('No Jira issue detected here. Open an issue (…/browse/ABC-123).');
      return;
    }

    state.key = ctx.key;
    state.baseUrl = ctx.baseUrl || '';
    await runExport();
  })();
})();

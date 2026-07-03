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

  // Detect the issue key from a variety of Jira URL shapes plus the DOM.
  function detectIssueKey() {
    const url = location.href;
    const patterns = [
      /\/browse\/([A-Z][A-Z0-9]+-\d+)/,          // /browse/EFK-549
      /[?&]selectedIssue=([A-Z][A-Z0-9]+-\d+)/,   // board ?selectedIssue=EFK-549
      /[?&]issueKey=([A-Z][A-Z0-9]+-\d+)/,
      /\/issues\/([A-Z][A-Z0-9]+-\d+)/,           // /jira/.../issues/EFK-549
    ];
    for (const re of patterns) {
      const m = url.match(re);
      if (m) return m[1];
    }
    // DOM fallbacks (issue view rendered but URL doesn't carry the key).
    const domSelectors = ['#key-val', '[data-testid$="current-issue.item"]'];
    for (const sel of domSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const m = el.textContent.match(/[A-Z][A-Z0-9]+-\d+/);
        if (m) return m[0];
      }
    }
    return null;
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

  function makeButton() {
    const btn = document.createElement('button');
    btn.id = 'jme-copy-md-btn';
    btn.type = 'button';
    btn.textContent = '⧉ Copy Markdown';
    btn.title = 'Copy this Jira issue as Markdown';
    Object.assign(btn.style, {
      marginLeft: '8px',
      padding: '4px 10px',
      fontSize: '12px',
      fontWeight: '600',
      color: '#fff',
      background: '#0052cc',
      border: 'none',
      borderRadius: '3px',
      cursor: 'pointer',
      verticalAlign: 'middle',
    });
    btn.addEventListener('click', () => copyMarkdownFromButton(btn));
    return btn;
  }

  function injectButton() {
    if (injecting) return;
    if (document.getElementById('jme-copy-md-btn')) return;
    if (!detectIssueKey()) return;

    const anchor = document.querySelector(
      'h1[data-testid="issue.views.issue-base.foundation.summary.heading"], #summary-val, h1#summary-val'
    );
    if (!anchor || !anchor.parentElement) return;

    injecting = true;
    try {
      anchor.parentElement.appendChild(makeButton());
    } finally {
      injecting = false;
    }
  }

  // Jira is a SPA; the title mounts/re-mounts as the user navigates. Observe
  // DOM changes (throttled) and (re)inject the button as needed.
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      injectButton();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  injectButton();
})();

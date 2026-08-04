/*
 * background.js — Manifest V3 background script.
 *
 * Runs as a service worker in Chrome and as an event page in Firefox, which
 * does not implement `background.service_worker` (the manifest declares both
 * keys; each browser picks the one it supports). Everything here must work in
 * either context: no DOM, no `window`, and all listeners registered
 * synchronously at top level so an idle-suspended background wakes up for them.
 *
 * Deliberately thin. All cookie-authenticated network access happens in the
 * content script (same-origin with the Jira tab); the popup handles the UI.
 * The background exists mainly to own downloads, which must survive the popup
 * closing.
 */

// Firefox exposes the promise-based `browser` namespace; its `chrome` alias is
// callback-only. Chrome has no `browser`, and its MV3 `chrome` APIs return
// promises. Using this alias everywhere keeps one promise-based code path.
const api = globalThis.browser ?? globalThis.chrome;

api.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Jira Markdown Exporter] installed.');
  }
});

// If a user has no popup context (e.g. popup disabled), clicking the icon on a
// Jira tab still triggers a copy via the content script.
api.action.onClicked.addListener(async (tab) => {
  // Only fires when no default_popup is set; harmless otherwise.
  if (!tab || !tab.id) return;
  try {
    const result = await api.tabs.sendMessage(tab.id, { action: 'export', options: {} });
    if (result && result.ok) {
      console.log('[Jira Markdown Exporter] exported', result.key);
    }
  } catch (err) {
    console.warn('[Jira Markdown Exporter] action click failed:', err);
  }
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'download') {
    handleDownload(msg).then(sendResponse, (err) =>
      sendResponse({ ok: false, error: (err && err.message) || String(err) })
    );
    return true; // async response
  }
  return false;
});

async function handleDownload(msg) {
  const { url, revoke } = toDownloadUrl(msg);
  try {
    // Native downloads use the browser cookie jar and follow redirects without
    // CORS restrictions — which is why attachments are downloaded here rather
    // than fetched in-page.
    const downloadId = await api.downloads.download({
      url,
      filename: sanitizeFilename(msg.filename),
      saveAs: false,
    });
    if (revoke) revokeWhenSettled(downloadId, url);
    return { ok: true, downloadId };
  } catch (err) {
    if (revoke) URL.revokeObjectURL(url);
    throw err;
  }
}

// Remote attachment URLs (`msg.url`) go straight through. Generated Markdown
// arrives as text and has to become something downloads.download() accepts,
// and the browsers disagree on what that is:
//   - Firefox rejects data: URLs at the API schema level, but its background
//     context is a real page, so a blob: URL created *here* is accepted.
//   - Chrome's service worker has no URL.createObjectURL, but takes data: URLs.
function toDownloadUrl(msg) {
  if (msg.url) return { url: msg.url, revoke: false };
  const mime = msg.mime || 'text/markdown';
  const text = msg.text || '';
  if (typeof URL.createObjectURL === 'function') {
    return { url: URL.createObjectURL(new Blob([text], { type: mime })), revoke: true };
  }
  return { url: `data:${mime};charset=utf-8;base64,${base64Utf8(text)}`, revoke: false };
}

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// A blob: URL stays alive only as long as we hold it, so release it once the
// download reaches a terminal state (never before — the fetch is still running).
function revokeWhenSettled(downloadId, url) {
  const onChanged = (delta) => {
    if (delta.id !== downloadId || !delta.state) return;
    const s = delta.state.current;
    if (s === 'complete' || s === 'interrupted') {
      api.downloads.onChanged.removeListener(onChanged);
      URL.revokeObjectURL(url);
    }
  };
  api.downloads.onChanged.addListener(onChanged);
}

// downloads.download rejects paths with traversal or characters illegal on
// Windows. Keep forward slashes (they create subfolders) and issue-key
// hyphens; replace only genuinely illegal characters.
function sanitizeFilename(name) {
  var illegal = new RegExp('[<>:"\\\\|?*\\x00-\\x1f]', 'g');
  return String(name || 'issue.md')
    .replace(/\.\.+/g, '.')
    .replace(illegal, '_')
    .replace(/^\/+/, '');
}

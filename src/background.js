/*
 * background.js — Manifest V3 service worker.
 *
 * Deliberately thin. All cookie-authenticated network access happens in the
 * content script (same-origin with the Jira tab); the popup handles the UI.
 * The worker exists mainly to own downloads, which must survive the popup
 * closing.
 */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Jira Markdown Exporter] installed.');
  }
});

// If a user has no popup context (e.g. popup disabled), clicking the icon on a
// Jira tab still triggers a copy via the content script.
chrome.action.onClicked.addListener(async (tab) => {
  // Only fires when no default_popup is set; harmless otherwise.
  if (!tab || !tab.id) return;
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: 'export', options: {} });
    if (result && result.ok) {
      console.log('[Jira Markdown Exporter] exported', result.key);
    }
  } catch (err) {
    console.warn('[Jira Markdown Exporter] action click failed:', err);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'download') {
    chrome.downloads.download(
      {
        // `url` may be a data: URL (the generated Markdown) or a remote
        // https: attachment URL. Native downloads use the browser cookie jar
        // and follow redirects without CORS restrictions — which is why
        // attachments are downloaded here rather than fetched in-page.
        url: msg.url || msg.dataUrl,
        filename: sanitizeFilename(msg.filename),
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, downloadId });
        }
      }
    );
    return true; // async response
  }
  return false;
});

// chrome.downloads rejects paths with traversal or characters illegal on
// Windows. Keep forward slashes (they create subfolders) and issue-key
// hyphens; replace only genuinely illegal characters.
function sanitizeFilename(name) {
  var illegal = new RegExp('[<>:"\\\\|?*\\x00-\\x1f]', 'g');
  return String(name || 'issue.md')
    .replace(/\.\.+/g, '.')
    .replace(illegal, '_')
    .replace(/^\/+/, '');
}

/*
 * popup.js
 * --------
 * The extension's action popup. Orchestrates the export:
 *   - asks the content script (running same-origin in the Jira tab) for the
 *     issue Markdown,
 *   - shows a live preview,
 *   - copies to clipboard, or downloads a .md file (optionally a .zip bundling
 *     attachments) via the background service worker.
 *
 * The popup never touches the network itself — all cookie-authenticated
 * requests happen in the content script — so this file stays permission-light.
 */
(function () {
  'use strict';

  const REPO_URL = 'https://github.com/topicusonderwijs/plugin-jira-markdown-exporter';

  const el = (id) => document.getElementById(id);
  const statusEl = el('status');
  const controlsEl = el('controls');
  const previewWrap = el('preview-wrap');
  const previewEl = el('preview');
  const actionsEl = el('actions');
  const msgEl = el('msg');
  const badgeEl = el('source-badge');
  const btnCopy = el('btn-copy');
  const btnDownload = el('btn-download');

  let state = {
    tabId: null,
    key: null,
    markdown: '',
    attachments: [],
    source: '',
  };

  el('link-repo').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: REPO_URL });
  });

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', !!isError);
  }

  function setMessage(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  function currentOptions() {
    return {
      includeComments: el('opt-comments').checked,
      includeCustomFields: el('opt-customfields').checked,
    };
  }

  async function runExport() {
    setStatus('Exporting…');
    actionsEl.classList.add('hidden');
    previewWrap.classList.add('hidden');
    badgeEl.classList.add('hidden');

    let response;
    try {
      response = await sendToTab(state.tabId, {
        action: 'export',
        key: state.key,
        options: currentOptions(),
      });
    } catch (err) {
      setStatus(
        'Could not talk to the Jira page. Reload the issue tab and try again.',
        true
      );
      return;
    }

    if (!response || !response.ok) {
      setStatus((response && response.error) || 'Export failed.', true);
      return;
    }

    state.key = response.key || state.key;
    state.markdown = response.markdown || '';
    state.attachments = response.attachments || [];
    state.source = response.source || '';

    previewEl.value = state.markdown;
    setStatus(`Ready · ${state.key} · ${countLines(state.markdown)} lines`);

    badgeEl.textContent = response.source === 'dom-scrape' ? 'DOM fallback' : 'REST API';
    badgeEl.classList.remove('hidden');

    // Attachment toggle only makes sense when the API exposed attachments.
    const attToggle = el('opt-attachments');
    attToggle.disabled = state.attachments.length === 0;
    attToggle.parentElement.style.opacity = state.attachments.length === 0 ? 0.5 : 1;

    controlsEl.classList.remove('hidden');
    previewWrap.classList.remove('hidden');
    actionsEl.classList.remove('hidden');

    if (response.warning) setMessage(response.warning, 'error');
    else setMessage(`${state.attachments.length} attachment(s) available`);
  }

  function countLines(text) {
    return text ? text.split('\n').length : 0;
  }

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(state.markdown);
      setMessage('Copied to clipboard ✓', 'ok');
    } catch (err) {
      setMessage('Clipboard blocked — select the text and copy manually.', 'error');
    }
  }

  async function onDownload() {
    const includeAttachments =
      el('opt-attachments').checked && state.attachments.length > 0;

    btnDownload.disabled = true;
    try {
      if (includeAttachments) {
        setMessage('Fetching attachments…');
        const resp = await sendToTab(state.tabId, {
          action: 'fetchAttachments',
          attachments: state.attachments,
        });
        const files = [{ name: `${state.key}.md`, data: state.markdown }];
        let failed = 0;
        for (const f of (resp && resp.files) || []) {
          if (f.error || !f.base64) {
            failed++;
            continue;
          }
          files.push({
            name: `${state.key}/${f.filename}`,
            data: MiniZip.base64ToBytes(f.base64),
          });
        }
        const blob = MiniZip.build(files);
        await downloadBlob(blob, `${state.key}.zip`);
        setMessage(
          `Downloaded ${state.key}.zip${failed ? ` (${failed} attachment(s) failed)` : ''} ✓`,
          failed ? 'error' : 'ok'
        );
      } else {
        const blob = new Blob([state.markdown], { type: 'text/markdown' });
        await downloadBlob(blob, `${state.key}.md`);
        setMessage(`Downloaded ${state.key}.md ✓`, 'ok');
      }
    } catch (err) {
      setMessage('Download failed: ' + (err.message || err), 'error');
    } finally {
      btnDownload.disabled = false;
    }
  }

  // Hand the download to the background service worker via a data URL. The
  // worker outlives the popup, so the download completes even after the popup
  // closes.
  function downloadBlob(blob, filename) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        chrome.runtime.sendMessage(
          { action: 'download', dataUrl: reader.result, filename },
          (resp) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'download failed'));
            resolve(resp);
          }
        );
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  btnCopy.addEventListener('click', onCopy);
  btnDownload.addEventListener('click', onDownload);
  el('opt-comments').addEventListener('change', runExport);
  el('opt-customfields').addEventListener('change', runExport);

  // ---- bootstrap ------------------------------------------------------------

  (async function init() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('No active tab.', true);
      return;
    }
    state.tabId = tab.id;

    let ctx;
    try {
      const resp = await sendToTab(tab.id, { action: 'getContext' });
      ctx = resp && resp.context;
    } catch (err) {
      setStatus(
        'This tab isn’t a Jira page (or needs a reload). Open a Jira issue and try again.',
        true
      );
      return;
    }

    if (!ctx || !ctx.key) {
      setStatus('No Jira issue detected. Open an issue (e.g. …/browse/ABC-123).', true);
      return;
    }

    state.key = ctx.key;
    setStatus(`Found ${ctx.key} on ${ctx.host}`);
    await runExport();
  })();
})();

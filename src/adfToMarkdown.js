/*
 * adfToMarkdown.js
 * -----------------
 * Standalone, dependency-free converter from Atlassian Document Format (ADF)
 * to GitHub-flavoured Markdown.
 *
 * ADF is the JSON tree Jira Cloud returns for rich-text fields (description,
 * comment bodies, some custom fields). See:
 * https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 *
 * This module is written UMD-style so it works in three contexts unchanged:
 *   - as a CommonJS module in Node (for unit tests)          -> module.exports
 *   - as a plain <script> in the popup / a content script     -> window/self globals
 *
 * The only public entry point is adfToMarkdown(adf, options).
 *
 * options (all optional):
 *   - mediaResolver(attrs)  -> { url, alt } | string | null
 *         Resolve a media/mediaInline node (attrs.id / attrs.collection / attrs.alt)
 *         to a concrete href. Used to turn inline images into ![alt](url).
 *   - baseUrl               -> string, prepended to root-relative links.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.AdfConverter = api;
    root.adfToMarkdown = api.adfToMarkdown;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- inline mark handling -------------------------------------------------

  // Escape only the characters that change meaning in *inline* text. We keep
  // this minimal on purpose — over-escaping (e.g. every "." or "-") produces
  // noisy output like "a\.b" for no benefit. Block-level markers such as "#"
  // or "-" only matter at line start and are handled by the block renderers.
  function escapeText(text) {
    return String(text).replace(/([\\`*_\[\]])/g, '\\$1');
  }

  // Wrap a string of already-rendered inline text with the given ADF marks.
  // Marks are applied inner-to-outer; `code` short-circuits because Markdown
  // code spans cannot contain other formatting.
  function applyMarks(text, marks, options) {
    if (!marks || !marks.length) return text;

    // If there is a code mark, it dominates: render as an inline code span and
    // drop everything else (you cannot bold inside a code span in Markdown).
    if (marks.some((m) => m.type === 'code')) {
      // Choose a backtick fence long enough to survive backticks in the text.
      const longestRun = (text.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
      const fence = '`'.repeat(longestRun + 1);
      const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
      return `${fence}${pad}${text}${pad}${fence}`;
    }

    let out = text;
    let link = null;
    for (const mark of marks) {
      switch (mark.type) {
        case 'strong':
          out = `**${out}**`;
          break;
        case 'em':
          out = `*${out}*`;
          break;
        case 'strike':
          out = `~~${out}~~`;
          break;
        case 'underline':
          // Markdown has no underline; HTML degrades gracefully everywhere.
          out = `<u>${out}</u>`;
          break;
        case 'subsup':
          out = mark.attrs && mark.attrs.type === 'sub' ? `<sub>${out}</sub>` : `<sup>${out}</sup>`;
          break;
        case 'link':
          link = mark.attrs || {};
          break;
        case 'textColor':
        case 'backgroundColor':
          // No portable Markdown equivalent; keep the text, drop the colour.
          break;
        default:
          break;
      }
    }
    if (link && link.href) {
      let href = link.href;
      if (options && options.baseUrl && href.startsWith('/')) href = options.baseUrl + href;
      const title = link.title ? ` "${link.title.replace(/"/g, '\\"')}"` : '';
      out = `[${out}](${href}${title})`;
    }
    return out;
  }

  // ---- inline node rendering ------------------------------------------------

  // Render a run of inline nodes (text, mention, emoji, hardBreak, ...) to a
  // single Markdown string.
  function renderInline(nodes, options) {
    if (!nodes) return '';
    let out = '';
    for (const node of nodes) {
      out += renderInlineNode(node, options);
    }
    return out;
  }

  function renderInlineNode(node, options) {
    if (!node) return '';
    switch (node.type) {
      case 'text': {
        const marks = node.marks || [];
        // Inside a code span the text is verbatim — never escape it, or the
        // backslashes leak into the rendered code.
        const isCode = marks.some((m) => m.type === 'code');
        const raw = node.text || '';
        return applyMarks(isCode ? raw : escapeText(raw), marks, options);
      }
      case 'hardBreak':
        return '  \n';
      case 'mention':
        return `@${(node.attrs && (node.attrs.text || node.attrs.displayName)) || 'unknown'}`.replace(/^@@/, '@');
      case 'emoji':
        return (node.attrs && (node.attrs.text || node.attrs.shortName)) || '';
      case 'date': {
        const ts = node.attrs && node.attrs.timestamp;
        if (!ts) return '';
        const d = new Date(Number(ts));
        return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
      }
      case 'status':
        return `\`${(node.attrs && node.attrs.text) || ''}\``;
      case 'inlineCard':
      case 'blockCard':
      case 'embedCard': {
        const url = node.attrs && (node.attrs.url || (node.attrs.data && node.attrs.data.url));
        return url ? `[${url}](${url})` : '';
      }
      case 'mediaInline':
        return renderMedia(node, options, true);
      default:
        // Unknown inline node: try to recurse into content, else drop it.
        return node.content ? renderInline(node.content, options) : '';
    }
  }

  function renderMedia(node, options, inline) {
    const attrs = node.attrs || {};
    let resolved = null;
    if (options && typeof options.mediaResolver === 'function') {
      resolved = options.mediaResolver(attrs);
    }
    let url;
    let alt = attrs.alt || '';
    if (resolved && typeof resolved === 'object') {
      url = resolved.url;
      alt = resolved.alt || alt;
    } else if (typeof resolved === 'string') {
      url = resolved;
    }
    if (!url) {
      // Cannot resolve to a real href; leave a stable, human-readable marker.
      const label = alt || attrs.id || 'attachment';
      url = `attachment:${attrs.id || label}`;
      alt = alt || label;
    }
    const img = `![${alt}](${url})`;
    return inline ? img : img;
  }

  // ---- block node rendering -------------------------------------------------

  // Render an array of block nodes, joined by blank lines.
  function renderBlocks(nodes, options) {
    if (!nodes) return '';
    const parts = [];
    for (const node of nodes) {
      const rendered = renderBlockNode(node, options);
      if (rendered !== null && rendered !== undefined && rendered !== '') {
        parts.push(rendered);
      }
    }
    return parts.join('\n\n');
  }

  const PANEL_EMOJI = {
    info: 'ℹ️',
    note: '📝',
    warning: '⚠️',
    error: '❌',
    success: '✅',
  };

  function renderBlockNode(node, options) {
    if (!node) return '';
    switch (node.type) {
      case 'doc':
        return renderBlocks(node.content, options);

      case 'paragraph':
        return renderInline(node.content, options);

      case 'heading': {
        const level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) || 1));
        return `${'#'.repeat(level)} ${renderInline(node.content, options)}`;
      }

      case 'blockquote':
        return prefixLines(renderBlocks(node.content, options), '> ');

      case 'bulletList':
        return renderList(node, options, false, 0);

      case 'orderedList':
        return renderList(node, options, true, 0);

      case 'codeBlock': {
        const lang = (node.attrs && node.attrs.language) || '';
        const code = renderCodeText(node.content);
        const fence = pickFence(code);
        return `${fence}${lang}\n${code}\n${fence}`;
      }

      case 'rule':
        return '---';

      case 'panel': {
        const type = (node.attrs && node.attrs.panelType) || 'info';
        const emoji = PANEL_EMOJI[type] || 'ℹ️';
        const body = renderBlocks(node.content, options);
        return prefixLines(`${emoji} ${body}`, '> ');
      }

      case 'table':
        return renderTable(node, options);

      case 'mediaSingle':
      case 'mediaGroup':
        return (node.content || []).map((m) => renderMedia(m, options, false)).join('\n\n');

      case 'media':
        return renderMedia(node, options, false);

      case 'taskList':
        return (node.content || [])
          .map((item) => renderTaskItem(item, options))
          .filter(Boolean)
          .join('\n');

      case 'decisionList':
        return (node.content || [])
          .map((item) => `- 🔵 ${renderInline(item.content, options)}`)
          .join('\n');

      case 'expand':
      case 'nestedExpand': {
        const title = (node.attrs && node.attrs.title) || 'Details';
        const body = renderBlocks(node.content, options);
        return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
      }

      default:
        // Unknown block: recurse if possible so we never silently lose content.
        return node.content ? renderBlocks(node.content, options) : '';
    }
  }

  function renderTaskItem(item, options) {
    if (!item || item.type !== 'taskItem') return '';
    const done = item.attrs && item.attrs.state === 'DONE';
    return `- [${done ? 'x' : ' '}] ${renderInline(item.content, options)}`;
  }

  // Lists can nest arbitrarily; `depth` controls indentation (2 spaces / level).
  function renderList(node, options, ordered, depth) {
    const indent = '  '.repeat(depth);
    const items = node.content || [];
    const lines = [];
    let index = (node.attrs && node.attrs.order) || 1;
    for (const item of items) {
      if (!item || item.type !== 'listItem') continue;
      const marker = ordered ? `${index}.` : '-';
      const { lead, rest } = renderListItem(item, options, depth);
      lines.push(`${indent}${marker} ${lead}`);
      if (rest) lines.push(rest);
      index += 1;
    }
    return lines.join('\n');
  }

  // A listItem may contain paragraphs plus nested lists. The first paragraph
  // becomes the "lead" on the bullet line; nested lists / extra blocks are
  // indented underneath.
  function renderListItem(item, options, depth) {
    const children = item.content || [];
    let lead = '';
    const restParts = [];
    let leadTaken = false;

    for (const child of children) {
      if (!leadTaken && child.type === 'paragraph') {
        lead = renderInline(child.content, options);
        leadTaken = true;
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        restParts.push(renderList(child, options, child.type === 'orderedList', depth + 1));
      } else {
        // Any other block (code, nested paragraph, blockquote) is indented.
        const rendered = renderBlockNode(child, options);
        if (rendered) restParts.push(prefixLines(rendered, '  '.repeat(depth + 1)));
      }
    }
    return { lead, rest: restParts.filter(Boolean).join('\n') };
  }

  function renderTable(node, options) {
    const rows = (node.content || []).filter((r) => r.type === 'tableRow');
    if (!rows.length) return '';

    const grid = rows.map((row) =>
      (row.content || []).map((cell) => ({
        header: cell.type === 'tableHeader',
        text: cellToText(cell, options),
      }))
    );

    const colCount = grid.reduce((m, r) => Math.max(m, r.length), 0);
    const firstRowIsHeader = grid[0].every((c) => c.header) && grid[0].length > 0;

    const lines = [];
    let bodyStart = 0;

    if (firstRowIsHeader) {
      lines.push(rowToMarkdown(grid[0], colCount));
      lines.push(separatorRow(colCount));
      bodyStart = 1;
    } else {
      // Synthesize an empty header so the table stays valid GFM.
      lines.push(rowToMarkdown(new Array(colCount).fill({ text: '' }), colCount));
      lines.push(separatorRow(colCount));
    }

    for (let i = bodyStart; i < grid.length; i++) {
      lines.push(rowToMarkdown(grid[i], colCount));
    }
    return lines.join('\n');
  }

  function cellToText(cell, options) {
    // Cells hold block content; flatten to a single line for the table.
    const text = renderBlocks(cell.content, options)
      .replace(/\r?\n+/g, '<br>')
      .replace(/\|/g, '\\|');
    return text;
  }

  function rowToMarkdown(cells, colCount) {
    const padded = [];
    for (let i = 0; i < colCount; i++) {
      padded.push((cells[i] && cells[i].text) || '');
    }
    return `| ${padded.join(' | ')} |`;
  }

  function separatorRow(colCount) {
    return `| ${new Array(colCount).fill('---').join(' | ')} |`;
  }

  // ---- helpers --------------------------------------------------------------

  function renderCodeText(content) {
    if (!content) return '';
    return content.map((n) => (n.type === 'text' ? n.text || '' : '')).join('');
  }

  // Choose a backtick fence longer than any run of backticks inside the code.
  function pickFence(code) {
    const longest = (code.match(/`+/g) || []).reduce((a, b) => Math.max(a, b.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
  }

  function prefixLines(text, prefix) {
    return String(text)
      .split('\n')
      .map((line) => prefix + line)
      .join('\n');
  }

  // ---- public entry point ---------------------------------------------------

  function adfToMarkdown(adf, options) {
    options = options || {};
    if (!adf) return '';
    // Accept either a full ADF doc or a bare content array / node.
    if (typeof adf === 'string') return adf; // plain-text field, already Markdown-safe enough
    if (Array.isArray(adf)) return renderBlocks(adf, options).trim();
    if (adf.type === 'doc') return renderBlocks(adf.content, options).trim();
    return renderBlockNode(adf, options).trim();
  }

  return {
    adfToMarkdown,
    // Exposed for unit testing of internals:
    _internal: {
      applyMarks,
      renderInline,
      renderTable,
      escapeText,
    },
  };
});

/*
 * domScraper.js
 * -------------
 * Fallback exporter used when the REST API is unavailable — typically Jira
 * Data Center / Server behind SSO, or when the API returns 401/403/404.
 *
 * It reads the rendered issue view straight from the DOM and produces a
 * best-effort Markdown document. This is inherently less reliable than the API
 * path (Jira's markup changes between versions and between Cloud/DC), so it is
 * only invoked as a last resort.
 *
 * Loaded as a plain content-script global: window.JiraDomScraper.
 */
(function (root) {
  'use strict';

  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && textOf(el)) return textOf(el);
    }
    return '';
  }

  // Convert a rendered HTML element subtree to rough Markdown. Handles the
  // common block/inline tags Jira emits in description/comment bodies.
  //
  // options.includeStrikethrough === false drops <del>/<s>/<strike> subtrees
  // entirely (text included) — see adfToMarkdown.js for why.
  function htmlToMarkdown(node, options) {
    if (!node) return '';
    let out = '';
    node.childNodes.forEach((child) => {
      out += serializeNode(child, options);
    });
    out = out.replace(/\n{3,}/g, '\n\n');
    // Removing an inline element leaves the spaces that surrounded it back to
    // back. Collapse those, but not the two trailing spaces of a <br> hard
    // break — hence the negative lookahead.
    if (options && options.includeStrikethrough === false) {
      out = out.replace(/[ \t]{2,}(?!\n)/g, ' ');
    }
    return out.trim();
  }

  function serializeNode(node, options) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map((c) => serializeNode(c, options)).join('');
    const stripStrike = !!(options && options.includeStrikethrough === false);

    switch (tag) {
      case 'h1': return `\n# ${inner()}\n\n`;
      case 'h2': return `\n## ${inner()}\n\n`;
      case 'h3': return `\n### ${inner()}\n\n`;
      case 'h4': return `\n#### ${inner()}\n\n`;
      case 'h5': return `\n##### ${inner()}\n\n`;
      case 'h6': return `\n###### ${inner()}\n\n`;
      case 'p': return `\n${inner()}\n\n`;
      case 'br': return '  \n';
      case 'strong':
      case 'b': return `**${inner()}**`;
      case 'em':
      case 'i': return `*${inner()}*`;
      case 'del':
      case 's':
      case 'strike': return stripStrike ? '' : `~~${inner()}~~`;
      case 'code': return `\`${node.textContent}\``;
      case 'pre': return `\n\`\`\`\n${node.textContent}\n\`\`\`\n\n`;
      case 'blockquote': return `\n${node.textContent.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        return href ? `[${inner()}](${href})` : inner();
      }
      case 'img': {
        const src = node.getAttribute('src') || '';
        const alt = node.getAttribute('alt') || 'image';
        return src ? `![${alt}](${src})` : '';
      }
      // Items that serialize to nothing are skipped, so a struck-through bullet
      // doesn't leave a bare "-" behind (and doesn't consume an <ol> number).
      case 'ul': {
        const items = listItems(node, options);
        return items.length ? '\n' + items.map((text) => `- ${text}`).join('\n') + '\n\n' : '';
      }
      case 'ol': {
        const items = listItems(node, options);
        return items.length
          ? '\n' + items.map((text, i) => `${i + 1}. ${text}`).join('\n') + '\n\n'
          : '';
      }
      case 'li': return inner();
      case 'hr': return '\n---\n\n';
      case 'table': return `\n${serializeTable(node)}\n\n`;
      default: return inner();
    }
  }

  function listItems(list, options) {
    return Array.from(list.children)
      .filter((c) => c.tagName === 'LI')
      .map((li) => serializeNode(li, options).trim())
      .filter(Boolean);
  }

  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const grid = rows.map((r) =>
      Array.from(r.querySelectorAll('th,td')).map((c) => textOf(c).replace(/\|/g, '\\|'))
    );
    const cols = grid.reduce((m, r) => Math.max(m, r.length), 0);
    const line = (cells) => `| ${Array.from({ length: cols }, (_, i) => cells[i] || '').join(' | ')} |`;
    const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
    return [line(grid[0]), sep, ...grid.slice(1).map(line)].join('\n');
  }

  // Scrape the current issue view. Returns { key, markdown } or throws.
  function scrapeIssue(issueKey, options) {
    options = options || {};
    const key =
      issueKey ||
      firstText(['[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]']) ||
      firstText(['#key-val', 'a#key-val']);

    const summary = firstText([
      'h1[data-testid="issue.views.issue-base.foundation.summary.heading"]',
      '#summary-val',
      'h1#summary-val',
      'h1',
    ]);

    const status = firstText([
      '[data-testid="issue.views.issue-base.foundation.status.status-field-wrapper"] span',
      '#status-val span',
      '#opsbar-transitions_more span',
    ]);

    const assignee = firstText([
      '[data-testid="issue.views.field.user.assignee"]',
      '#assignee-val',
    ]);

    const reporter = firstText([
      '[data-testid="issue.views.field.user.reporter"]',
      '#reporter-val',
    ]);

    const descEl = document.querySelector(
      '[data-testid="issue.views.field.rich-text.description"], #description-val .user-content-block, #descriptionmodule .mod-content'
    );

    const out = [];
    out.push(`# ${key ? key + ': ' : ''}${summary}`.trim());

    const meta = [];
    if (status) meta.push(['Status', status]);
    if (assignee) meta.push(['Assignee', assignee]);
    if (reporter) meta.push(['Reporter', reporter]);
    if (meta.length) {
      out.push('| Field | Value |\n| --- | --- |\n' + meta.map(([k, v]) => `| ${k} | ${v} |`).join('\n'));
    }

    if (descEl) {
      out.push('## Description');
      out.push(htmlToMarkdown(descEl, options));
    }

    // Comments (Cloud markup)
    const commentEls = document.querySelectorAll(
      '[data-testid^="issue-comment-base.ui.comment."], #issue-comments .activity-comment, .issue-data-block.activity-comment'
    );
    if (commentEls.length) {
      out.push('## Comments');
      commentEls.forEach((el) => {
        const author = textOf(
          el.querySelector('[data-testid$="author"], .action-details a, .user-hover')
        );
        const bodyEl = el.querySelector(
          '[data-testid$="comment-body"], .action-body, .user-content-block'
        );
        const body = bodyEl ? htmlToMarkdown(bodyEl, options) : textOf(el);
        out.push(`### ${author || 'Comment'}\n\n${body}`);
      });
    }

    const markdown = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    return {
      key: key || 'issue',
      markdown,
      scraped: true,
      meta: {
        summary,
        status: status ? { name: status, category: 'new' } : null,
        assignee: assignee || null,
        commentCount: commentEls.length,
        attachmentCount: 0,
      },
    };
  }

  root.JiraDomScraper = { scrapeIssue, htmlToMarkdown };
})(typeof self !== 'undefined' ? self : this);

/*
 * jiraToMarkdown.js
 * -----------------
 * Assembles a complete Markdown document from a Jira Cloud issue JSON payload
 * (the shape returned by GET /rest/api/3/issue/{key}).
 *
 * Depends on adfToMarkdown (loaded before it in the content-script list, or
 * required in Node). No other dependencies.
 *
 * Public entry point: jiraIssueToMarkdown(issue, options)
 *   options:
 *     - baseUrl          -> e.g. "https://acme.atlassian.net", used for links
 *                           and to build attachment media resolvers.
 *     - includeComments  -> boolean (default true)
 *     - includeCustomFields -> boolean (default true)
 */
(function (root, factory) {
  const adf =
    typeof module !== 'undefined' && module.exports
      ? require('./adfToMarkdown.js')
      : root.AdfConverter;
  const api = factory(adf);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.jiraIssueToMarkdown = api.jiraIssueToMarkdown;
    root.JiraToMarkdown = api;
  }
})(typeof self !== 'undefined' ? self : this, function (AdfConverter) {
  'use strict';

  const adfToMarkdown = AdfConverter.adfToMarkdown;

  function fmtDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    // Keep it readable and locale-neutral: YYYY-MM-DD HH:mm
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  }

  // Build a media resolver so inline images in ADF resolve to attachment URLs.
  // ADF media nodes reference a media id; Jira attachments expose an id +
  // content URL + filename. We match on id, then fall back to filename in alt.
  function buildMediaResolver(attachments, baseUrl) {
    const byId = new Map();
    const byName = new Map();
    for (const att of attachments || []) {
      if (att.id != null) byId.set(String(att.id), att);
      if (att.filename) byName.set(att.filename, att);
    }
    return function resolver(attrs) {
      if (!attrs) return null;
      let att = null;
      if (attrs.id != null && byId.has(String(attrs.id))) att = byId.get(String(attrs.id));
      if (!att && attrs.alt && byName.has(attrs.alt)) att = byName.get(attrs.alt);
      if (!att) return null;
      return {
        url: att.content || (baseUrl ? `${baseUrl}/secure/attachment/${att.id}/${encodeURIComponent(att.filename || '')}` : att.filename),
        alt: att.filename || attrs.alt || 'attachment',
      };
    };
  }

  // Render an arbitrary field value (string, ADF, option, user, array, ...) to
  // a compact inline Markdown string.
  function renderFieldValue(value, options) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((v) => renderFieldValue(v, options)).filter(Boolean).join(', ');
    }
    // ADF document
    if (value.type === 'doc' && Array.isArray(value.content)) {
      return adfToMarkdown(value, options).replace(/\n+/g, ' ').trim();
    }
    // Common Jira object shapes
    if (value.displayName) return value.displayName; // user
    if (value.name && value.emailAddress) return value.name;
    if (value.value != null) return String(value.value); // select option
    if (value.name) return String(value.name); // status/priority/version/component
    if (value.key && value.summary) return `${value.key} — ${value.summary}`; // linked issue
    if (value.key) return String(value.key);
    if (value.text) return String(value.text);
    return '';
  }

  function person(user) {
    if (!user) return '_Unassigned_';
    return user.displayName || user.name || user.accountId || '_Unknown_';
  }

  // Fields that already appear in the metadata table and shouldn't be repeated
  // in the "Other fields" section.
  const HANDLED_SYSTEM_FIELDS = new Set([
    'summary',
    'description',
    'status',
    'assignee',
    'reporter',
    'creator',
    'priority',
    'issuetype',
    'labels',
    'created',
    'updated',
    'resolution',
    'resolutiondate',
    'duedate',
    'comment',
    'attachment',
    'project',
    'fixVersions',
    'components',
    'parent',
    'subtasks',
    'issuelinks',
    'watches',
    'votes',
    'worklog',
    'progress',
    'aggregateprogress',
    'timespent',
    'timeestimate',
    'timeoriginalestimate',
    'workratio',
    'lastViewed',
    'statuscategorychangedate',
    'timetracking',
    'aggregatetimespent',
    'aggregatetimeestimate',
    'aggregatetimeoriginalestimate',
    'thumbnail',
  ]);

  function jiraIssueToMarkdown(issue, options) {
    options = options || {};
    const includeComments = options.includeComments !== false;
    const includeCustomFields = options.includeCustomFields !== false;
    const fields = (issue && issue.fields) || {};
    const names = issue && issue.names ? issue.names : {}; // present when expand=names
    const baseUrl = options.baseUrl || '';

    const attachments = fields.attachment || [];
    const convOpts = {
      baseUrl,
      mediaResolver: buildMediaResolver(attachments, baseUrl),
    };

    const out = [];

    // ---- Title ----
    const key = issue.key || '';
    const summary = fields.summary || '';
    out.push(`# ${key ? key + ': ' : ''}${summary}`.trim());

    if (baseUrl && key) {
      out.push(`> [${baseUrl}/browse/${key}](${baseUrl}/browse/${key})`);
    }

    // ---- Metadata table ----
    const meta = [];
    const addMeta = (label, val) => {
      if (val !== undefined && val !== null && String(val).trim() !== '') {
        meta.push([label, String(val).replace(/\|/g, '\\|').replace(/\n+/g, ' ')]);
      }
    };
    addMeta('Type', fields.issuetype && fields.issuetype.name);
    addMeta('Status', fields.status && fields.status.name);
    addMeta('Priority', fields.priority && fields.priority.name);
    addMeta('Assignee', fields.assignee ? person(fields.assignee) : '');
    addMeta('Reporter', fields.reporter ? person(fields.reporter) : '');
    addMeta('Resolution', fields.resolution && fields.resolution.name);
    addMeta('Labels', (fields.labels || []).join(', '));
    addMeta('Components', (fields.components || []).map((c) => c.name).join(', '));
    addMeta('Fix Versions', (fields.fixVersions || []).map((v) => v.name).join(', '));
    addMeta('Parent', fields.parent && fields.parent.key ? `${fields.parent.key} — ${(fields.parent.fields && fields.parent.fields.summary) || ''}`.trim() : '');
    addMeta('Created', fmtDate(fields.created));
    addMeta('Updated', fmtDate(fields.updated));
    addMeta('Due', fmtDate(fields.duedate));

    if (meta.length) {
      out.push('| Field | Value |\n| --- | --- |\n' + meta.map(([k, v]) => `| ${k} | ${v} |`).join('\n'));
    }

    // ---- Description ----
    const descMd = fields.description ? adfToMarkdown(fields.description, convOpts) : '';
    if (descMd) {
      out.push('## Description');
      out.push(descMd);
    }

    // ---- Subtasks & linked issues ----
    if (fields.subtasks && fields.subtasks.length) {
      out.push('## Subtasks');
      out.push(
        fields.subtasks
          .map((s) => `- ${s.key} — ${(s.fields && s.fields.summary) || ''} _(${(s.fields && s.fields.status && s.fields.status.name) || ''})_`)
          .join('\n')
      );
    }
    if (fields.issuelinks && fields.issuelinks.length) {
      const links = fields.issuelinks
        .map((l) => {
          const linked = l.outwardIssue || l.inwardIssue;
          if (!linked) return '';
          const rel = l.outwardIssue ? (l.type && l.type.outward) : (l.type && l.type.inward);
          return `- ${rel || 'relates to'}: ${linked.key} — ${(linked.fields && linked.fields.summary) || ''}`;
        })
        .filter(Boolean);
      if (links.length) {
        out.push('## Linked Issues');
        out.push(links.join('\n'));
      }
    }

    // ---- Custom / other fields ----
    if (includeCustomFields) {
      const extra = [];
      for (const fieldKey of Object.keys(fields)) {
        if (HANDLED_SYSTEM_FIELDS.has(fieldKey)) continue;
        const value = fields[fieldKey];
        if (value == null) continue;
        if (Array.isArray(value) && value.length === 0) continue;
        const rendered = renderFieldValue(value, convOpts);
        if (!rendered || !rendered.trim()) continue;
        const label = names[fieldKey] || fieldKey;
        extra.push([label, rendered.replace(/\|/g, '\\|').replace(/\n+/g, ' ')]);
      }
      if (extra.length) {
        out.push('## Other Fields');
        out.push('| Field | Value |\n| --- | --- |\n' + extra.map(([k, v]) => `| ${k} | ${v} |`).join('\n'));
      }
    }

    // ---- Attachments ----
    if (attachments.length) {
      out.push('## Attachments');
      out.push(
        attachments
          .map((a) => {
            const href = a.content || (baseUrl ? `${baseUrl}/secure/attachment/${a.id}/${encodeURIComponent(a.filename || '')}` : '');
            const size = a.size ? ` (${formatBytes(a.size)})` : '';
            return href ? `- [${a.filename}](${href})${size}` : `- ${a.filename}${size}`;
          })
          .join('\n')
      );
    }

    // ---- Comments ----
    if (includeComments && fields.comment && fields.comment.comments && fields.comment.comments.length) {
      out.push('## Comments');
      for (const c of fields.comment.comments) {
        const author = person(c.author);
        const when = fmtDate(c.created);
        const body = adfToMarkdown(c.body, convOpts);
        out.push(`### ${author} — ${when}\n\n${body}`);
      }
    }

    return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = Number(bytes);
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  return { jiraIssueToMarkdown, renderFieldValue, buildMediaResolver };
});

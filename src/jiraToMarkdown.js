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
 *     - includeSubtasks  -> boolean (default true); false drops the whole
 *                           Subtasks section.
 *     - includeStrikethrough -> boolean (default true); false removes struck
 *                           text outright. See adfToMarkdown.js.
 *
 * Section order: title, metadata, description, linked issues, other fields,
 * attachments, comments, then subtasks last — see the Subtasks block below.
 *
 * Subtasks render as a flat list when the payload only holds Jira's stubs, and
 * as a section per subtask when their fields have been enriched with real
 * bodies (content.js does that via a follow-up request).
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
    // Date-only fields (duedate) carry no time; formatting them as a timestamp
    // would invent one and shift it by the local UTC offset.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) return String(value).trim();
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

  // Description and comment bodies arrive as ADF on Jira Cloud (v3) and as
  // wiki-markup strings on Data Center (v2). Pass strings through untouched —
  // better raw wiki markup than nothing.
  function renderDoc(value, opts) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    return adfToMarkdown(value, opts);
  }

  function attachmentLine(a, baseUrl) {
    const href =
      a.content ||
      (baseUrl ? `${baseUrl}/secure/attachment/${a.id}/${encodeURIComponent(a.filename || '')}` : '');
    const size = a.size ? ` (${formatBytes(a.size)})` : '';
    return href ? `- [${a.filename}](${href})${size}` : `- ${a.filename}${size}`;
  }

  // Does this subtask carry more than the stub Jira embeds in the parent?
  // The parent payload's `subtasks` array only ever holds summary/status/
  // priority/issuetype — no `expand` widens it. Anything richer got merged in
  // by a follow-up request (see fetchSubtaskDetails in content.js), and only
  // then is a section per subtask worth the vertical space.
  function subtaskHasBody(s) {
    const f = (s && s.fields) || {};
    return !!(
      f.description ||
      (f.comment && (f.comment.comments || []).length) ||
      (f.attachment && f.attachment.length)
    );
  }

  // Returns the blocks for the "## Subtasks" section. Two shapes, picked from
  // the data rather than a flag: a flat list while all we have is stubs, a
  // section per subtask once bodies are available.
  function renderSubtasks(subtasks, ctx) {
    const out = ['## Subtasks'];

    if (!subtasks.some(subtaskHasBody)) {
      out.push(
        subtasks
          .map((s) => {
            const f = s.fields || {};
            const status = (f.status && f.status.name) || '';
            return `- ${s.key} — ${f.summary || ''}${status ? ` _(${status})_` : ''}`;
          })
          .join('\n')
      );
      return out;
    }

    // Subtask bodies sit under an h3, so their own headings start at h4 and
    // never collide with the host document's outline.
    const baseBodyOpts = { ...ctx.convOpts, headingOffset: 3 };

    for (const s of subtasks) {
      const f = s.fields || {};
      const label =
        ctx.baseUrl && s.key ? `[${s.key}](${ctx.baseUrl}/browse/${s.key})` : s.key || '';
      out.push(`### ${label}${f.summary ? ` — ${f.summary}` : ''}`.trim());

      const bits = [];
      const addBit = (name, val) => {
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          bits.push(`**${name}:** ${String(val).replace(/\n+/g, ' ')}`);
        }
      };
      addBit('Type', f.issuetype && f.issuetype.name);
      addBit('Status', f.status && f.status.name);
      addBit('Priority', f.priority && f.priority.name);
      addBit('Assignee', f.assignee ? person(f.assignee) : '');
      addBit('Resolution', f.resolution && f.resolution.name);
      addBit('Due', fmtDate(f.duedate));
      addBit('Labels', (f.labels || []).join(', '));
      if (bits.length) out.push(bits.join(' · '));

      // Inline images in a subtask description reference that subtask's own
      // attachments, not the parent's, so resolve against its list when we
      // have one.
      const atts = f.attachment || [];
      const bodyOpts = atts.length
        ? { ...baseBodyOpts, mediaResolver: buildMediaResolver(atts, ctx.baseUrl) }
        : baseBodyOpts;

      const body = renderDoc(f.description, bodyOpts);
      if (body) out.push(body);

      if (atts.length) {
        out.push('#### Attachments');
        out.push(atts.map((a) => attachmentLine(a, ctx.baseUrl)).join('\n'));
      }

      const comments = (ctx.includeComments && f.comment && f.comment.comments) || [];
      if (comments.length) {
        out.push('#### Comments');
        for (const c of comments) {
          out.push(`**${person(c.author)} — ${fmtDate(c.created)}**\n\n${renderDoc(c.body, bodyOpts)}`);
        }
      }
    }

    return out;
  }

  function jiraIssueToMarkdown(issue, options) {
    options = options || {};
    const includeComments = options.includeComments !== false;
    const includeCustomFields = options.includeCustomFields !== false;
    const includeSubtasks = options.includeSubtasks !== false;
    const fields = (issue && issue.fields) || {};
    const names = issue && issue.names ? issue.names : {}; // present when expand=names
    const baseUrl = options.baseUrl || '';

    const attachments = fields.attachment || [];
    const convOpts = {
      baseUrl,
      mediaResolver: buildMediaResolver(attachments, baseUrl),
      includeStrikethrough: options.includeStrikethrough !== false,
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

    // ---- Linked issues ----
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
      out.push(attachments.map((a) => attachmentLine(a, baseUrl)).join('\n'));
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

    // ---- Subtasks ----
    // Last on purpose. Every other section is a fact *about this issue* and
    // fits on a line or two; a subtask carries whole nested documents of its
    // own (description, comments, attachments). Placed mid-document it splits
    // the parent's own content in half, so the parent reads start to finish
    // first and the descent into children comes after.
    if (includeSubtasks && fields.subtasks && fields.subtasks.length) {
      for (const block of renderSubtasks(fields.subtasks, {
        baseUrl,
        convOpts,
        includeComments,
      })) {
        out.push(block);
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

  return { jiraIssueToMarkdown, renderFieldValue, buildMediaResolver, renderSubtasks };
});

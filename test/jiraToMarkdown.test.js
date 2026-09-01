/*
 * Unit tests for the full-issue assembler.
 * Run with: node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jiraIssueToMarkdown } = require('../src/jiraToMarkdown.js');

const sampleIssue = {
  key: 'EFK-549',
  names: { customfield_10011: 'Epic Name' },
  fields: {
    summary: 'Implement export button',
    issuetype: { name: 'Story' },
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    assignee: { displayName: 'Jane Doe' },
    reporter: { displayName: 'John Smith' },
    labels: ['frontend', 'ux'],
    created: '2026-01-02T10:00:00.000+0000',
    updated: '2026-01-03T12:30:00.000+0000',
    description: {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Add a button.' }] }],
    },
    customfield_10011: 'Onboarding',
    comment: {
      comments: [
        {
          author: { displayName: 'Jane Doe' },
          created: '2026-01-03T09:00:00.000+0000',
          body: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good.' }] }],
          },
        },
      ],
    },
    attachment: [
      { id: '1001', filename: 'diagram.png', content: 'https://acme.atlassian.net/att/1001', size: 20480 },
    ],
  },
};

test('title includes key and summary', () => {
  const md = jiraIssueToMarkdown(sampleIssue, { baseUrl: 'https://acme.atlassian.net' });
  assert.match(md, /^# EFK-549: Implement export button/);
});

test('metadata table contains status and assignee', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.match(md, /\| Status \| In Progress \|/);
  assert.match(md, /\| Assignee \| Jane Doe \|/);
  assert.match(md, /\| Labels \| frontend, ux \|/);
});

test('description section is rendered from ADF', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.match(md, /## Description\n\nAdd a button\./);
});

test('custom field uses its human name from names map', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.match(md, /## Other Fields/);
  assert.match(md, /\| Epic Name \| Onboarding \|/);
});

test('comments are included with author and body', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.match(md, /## Comments/);
  assert.match(md, /### Jane Doe — 2026-01-03/);
  assert.match(md, /Looks good\./);
});

test('attachments are listed with link', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.match(md, /## Attachments/);
  assert.match(md, /\[diagram\.png\]\(https:\/\/acme\.atlassian\.net\/att\/1001\)/);
});

test('includeComments:false omits comments', () => {
  const md = jiraIssueToMarkdown(sampleIssue, { includeComments: false });
  assert.doesNotMatch(md, /## Comments/);
});

test('includeCustomFields:false omits other fields', () => {
  const md = jiraIssueToMarkdown(sampleIssue, { includeCustomFields: false });
  assert.doesNotMatch(md, /## Other Fields/);
});

test('output ends with a single trailing newline', () => {
  const md = jiraIssueToMarkdown(sampleIssue);
  assert.ok(md.endsWith('\n'));
  assert.ok(!md.endsWith('\n\n'));
});

// The option has to reach every ADF field the assembler renders — description,
// comment bodies and custom fields all go through the same converter options.
const struckIssue = {
  key: 'EFK-550',
  names: { customfield_10020: 'Approach' },
  fields: {
    summary: 'Pick a strategy',
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Use B. ' },
            { type: 'text', text: 'Use A.', marks: [{ type: 'strike' }] },
          ],
        },
      ],
    },
    customfield_10020: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'chosen', marks: [{ type: 'strike' }] },
            { type: 'text', text: ' final' },
          ],
        },
      ],
    },
    comment: {
      comments: [
        {
          author: { displayName: 'Jane Doe' },
          created: '2026-01-03T09:00:00.000+0000',
          body: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'scrapped', marks: [{ type: 'strike' }] },
                  { type: 'text', text: ' agreed' },
                ],
              },
            ],
          },
        },
      ],
    },
  },
};

test('includeStrikethrough defaults to true', () => {
  const md = jiraIssueToMarkdown(struckIssue, {});
  assert.match(md, /Use B\. ~~Use A\.~~/);
  assert.match(md, /~~scrapped~~ agreed/);
});

test('includeStrikethrough:false strips struck text from every ADF field', () => {
  const md = jiraIssueToMarkdown(struckIssue, { includeStrikethrough: false });
  assert.doesNotMatch(md, /~~/);
  assert.doesNotMatch(md, /Use A/);
  assert.match(md, /Use B\./);
  assert.match(md, /\| Approach \| final \|/); // custom field
  assert.doesNotMatch(md, /scrapped/);
  assert.match(md, /agreed/);
});

// ---- subtasks ---------------------------------------------------------------
//
// The parent payload's `subtasks` array is a stub; content.js merges richer
// fields into it from a follow-up request. Both states must render sensibly.

const subtaskStub = (key, summary) => ({
  id: key,
  key,
  fields: {
    summary,
    status: { name: 'New', statusCategory: { key: 'new' } },
    priority: { name: 'None' },
    issuetype: { name: 'Sub-task', subtask: true },
  },
});

const parentWithSubtasks = (subtasks) => ({
  key: 'EFK-3621',
  fields: {
    summary: 'test van pim',
    issuetype: { name: 'Bug' },
    status: { name: 'New' },
    subtasks,
  },
});

const doc = (...blocks) => ({ type: 'doc', version: 1, content: blocks });
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] });

test('stub-only subtasks render as a flat list', () => {
  const md = jiraIssueToMarkdown(parentWithSubtasks([
    subtaskStub('EFK-3622', 'Task A'),
    subtaskStub('EFK-3623', 'Task B'),
  ]), { baseUrl: 'https://acme.atlassian.net' });

  assert.match(md, /## Subtasks/);
  assert.match(md, /- EFK-3622 — Task A _\(New\)_/);
  assert.match(md, /- EFK-3623 — Task B _\(New\)_/);
  assert.ok(!md.includes('### EFK-3622'), 'no per-subtask sections without bodies');
});

test('enriched subtasks render a linked section each, with meta line', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.assignee = { displayName: 'Pim Jansen' };
  enriched.fields.labels = ['backend'];
  enriched.fields.description = doc(para('Do the thing.'));

  const md = jiraIssueToMarkdown(
    parentWithSubtasks([enriched, subtaskStub('EFK-3623', 'Task B')]),
    { baseUrl: 'https://acme.atlassian.net' }
  );

  assert.match(md, /### \[EFK-3622\]\(https:\/\/acme\.atlassian\.net\/browse\/EFK-3622\) — Task A/);
  assert.match(md, /\*\*Type:\*\* Sub-task · \*\*Status:\*\* New · \*\*Priority:\*\* None · \*\*Assignee:\*\* Pim Jansen · \*\*Labels:\*\* backend/);
  assert.match(md, /Do the thing\./);
  // A stub alongside an enriched sibling still gets its own section.
  assert.match(md, /### \[EFK-3623\]\(.*\) — Task B/);
});

test('subtask description headings are demoted below the subtask heading', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.description = doc(
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Steps' }] },
    para('First.'),
    { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Deep' }] }
  );

  const md = jiraIssueToMarkdown(parentWithSubtasks([enriched]), { baseUrl: 'https://x.test' });

  assert.match(md, /^#### Steps$/m, 'h1 becomes h4');
  assert.match(md, /^###### Deep$/m, 'h4 clamps at h6');
  assert.ok(!/^# Steps$/m.test(md), 'never competes with the document title');
});

test('subtask comments and attachments are rendered; includeComments:false drops the comments', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.description = doc(para('Body.'));
  enriched.fields.attachment = [
    { id: '9', filename: 'log.txt', content: 'https://x.test/log.txt', size: 2048 },
  ];
  enriched.fields.comment = {
    total: 1,
    comments: [
      {
        author: { displayName: 'Pim Jansen' },
        created: '2026-08-31T16:20:00.000+0200',
        body: doc(para('Looks good.')),
      },
    ],
  };
  const issue = parentWithSubtasks([enriched]);

  const md = jiraIssueToMarkdown(issue, { baseUrl: 'https://x.test' });
  assert.match(md, /#### Attachments\n\n- \[log\.txt\]\(https:\/\/x\.test\/log\.txt\) \(2\.0 KB\)/);
  assert.match(md, /#### Comments/);
  assert.match(md, /\*\*Pim Jansen — 2026-08-31 \d\d:20\*\*\n\nLooks good\./);

  const without = jiraIssueToMarkdown(issue, {
    baseUrl: 'https://x.test',
    includeComments: false,
  });
  assert.ok(!without.includes('#### Comments'), 'subtask comments follow includeComments');
  assert.match(without, /#### Attachments/, 'attachments are unaffected');
});

test('a wiki-markup (v2) subtask description passes through as text', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.description = 'h2. Plain wiki text\n';

  const md = jiraIssueToMarkdown(parentWithSubtasks([enriched]), {});
  assert.match(md, /h2\. Plain wiki text/);
  assert.match(md, /### EFK-3622 — Task A/, 'no baseUrl → unlinked key');
});

test('a date-only field renders as a date, not a shifted timestamp', () => {
  const md = jiraIssueToMarkdown(
    { key: 'EFK-1', fields: { summary: 'x', duedate: '2026-09-04' } },
    {}
  );
  assert.match(md, /\| Due \| 2026-09-04 \|/);
  assert.ok(!md.includes('2026-09-04 0'), 'no invented time component');
});

test('includeSubtasks:false drops the Subtasks section entirely', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.description = doc(para('Do the thing.'));
  const issue = parentWithSubtasks([enriched, subtaskStub('EFK-3623', 'Task B')]);
  const opts = { baseUrl: 'https://x.test', includeSubtasks: false };

  const md = jiraIssueToMarkdown(issue, opts);
  assert.ok(!md.includes('## Subtasks'), 'no section heading');
  assert.ok(!md.includes('EFK-3622'), 'no subtask keys');
  assert.ok(!md.includes('Do the thing.'), 'no subtask bodies');
  assert.match(md, /# EFK-3621: test van pim/, 'the rest of the issue survives');

  // Default stays on.
  assert.match(jiraIssueToMarkdown(issue, { baseUrl: 'https://x.test' }), /## Subtasks/);
});

test('subtasks come last, after every section about the parent itself', () => {
  const enriched = subtaskStub('EFK-3622', 'Task A');
  enriched.fields.description = doc(para('Subtask body.'));
  const issue = parentWithSubtasks([enriched]);
  Object.assign(issue.fields, {
    description: doc(para('Parent body.')),
    attachment: [{ id: '1', filename: 'parent.png', content: 'https://x.test/p.png' }],
    comment: {
      comments: [
        { author: { displayName: 'Pim Jansen' }, created: '2026-08-31T16:20:00.000+0200', body: doc(para('Parent comment.')) },
      ],
    },
    issuelinks: [
      { type: { outward: 'blocks' }, outwardIssue: { key: 'EFK-9', fields: { summary: 'Other' } } },
    ],
    customfield_10111: { value: 'Low' },
  });

  const md = jiraIssueToMarkdown(issue, { baseUrl: 'https://x.test' });
  const at = (heading) => md.indexOf(heading);

  for (const heading of ['## Description', '## Linked Issues', '## Other Fields', '## Attachments', '## Comments', '## Subtasks']) {
    assert.ok(at(heading) !== -1, `${heading} is present`);
  }
  assert.ok(at('## Subtasks') > at('## Comments'), 'subtasks after the parent comments');
  assert.ok(at('## Subtasks') > at('## Attachments'), 'subtasks after the parent attachments');
  assert.ok(at('## Subtasks') > at('## Other Fields'), 'subtasks after the parent fields');
  assert.ok(at('## Subtasks') > at('## Linked Issues'), 'subtasks after the linked issues');
  // The parent's own comment must not be stranded below a subtask body.
  assert.ok(md.indexOf('Parent comment.') < md.indexOf('Subtask body.'));
});

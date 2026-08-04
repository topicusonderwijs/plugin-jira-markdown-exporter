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

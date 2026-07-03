/*
 * Unit tests for the standalone ADF -> Markdown converter.
 * Run with: node --test   (Node 18+, no dependencies)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adfToMarkdown } = require('../src/adfToMarkdown.js');

// Small helper to build ADF docs.
const doc = (...content) => ({ type: 'doc', version: 1, content });
const p = (...content) => ({ type: 'paragraph', content });
const t = (text, marks) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

test('plain paragraph', () => {
  assert.equal(adfToMarkdown(doc(p(t('Hello world')))), 'Hello world');
});

test('headings map to # levels', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
    { type: 'heading', attrs: { level: 3 }, content: [t('Sub')] }
  );
  assert.equal(adfToMarkdown(adf), '# Title\n\n### Sub');
});

test('bold, italic, strike marks', () => {
  const adf = doc(
    p(t('a', [{ type: 'strong' }])),
    p(t('b', [{ type: 'em' }])),
    p(t('c', [{ type: 'strike' }]))
  );
  assert.equal(adfToMarkdown(adf), '**a**\n\n*b*\n\n~~c~~');
});

test('links render with href', () => {
  const adf = doc(p(t('Google', [{ type: 'link', attrs: { href: 'https://google.com' } }])));
  assert.equal(adfToMarkdown(adf), '[Google](https://google.com)');
});

test('inline code mark wins over other marks', () => {
  const adf = doc(p(t('x = 1', [{ type: 'code' }, { type: 'strong' }])));
  assert.equal(adfToMarkdown(adf), '`x = 1`');
});

test('code span with embedded backticks widens the fence', () => {
  const adf = doc(p(t('a`b', [{ type: 'code' }])));
  assert.equal(adfToMarkdown(adf), '``a`b``');
});

test('bullet list', () => {
  const adf = doc({
    type: 'bulletList',
    content: [
      { type: 'listItem', content: [p(t('one'))] },
      { type: 'listItem', content: [p(t('two'))] },
    ],
  });
  assert.equal(adfToMarkdown(adf), '- one\n- two');
});

test('ordered list', () => {
  const adf = doc({
    type: 'orderedList',
    content: [
      { type: 'listItem', content: [p(t('first'))] },
      { type: 'listItem', content: [p(t('second'))] },
    ],
  });
  assert.equal(adfToMarkdown(adf), '1. first\n2. second');
});

test('nested list indents', () => {
  const adf = doc({
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          p(t('parent')),
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [p(t('child'))] }],
          },
        ],
      },
    ],
  });
  assert.equal(adfToMarkdown(adf), '- parent\n  - child');
});

test('code block with language', () => {
  const adf = doc({
    type: 'codeBlock',
    attrs: { language: 'js' },
    content: [t('const a = 1;')],
  });
  assert.equal(adfToMarkdown(adf), '```js\nconst a = 1;\n```');
});

test('blockquote', () => {
  const adf = doc({ type: 'blockquote', content: [p(t('quoted'))] });
  assert.equal(adfToMarkdown(adf), '> quoted');
});

test('rule becomes ---', () => {
  assert.equal(adfToMarkdown(doc({ type: 'rule' })), '---');
});

test('hardBreak becomes trailing-space newline', () => {
  const adf = doc(p(t('line1'), { type: 'hardBreak' }, t('line2')));
  assert.equal(adfToMarkdown(adf), 'line1  \nline2');
});

test('mention renders as @name', () => {
  const adf = doc(p({ type: 'mention', attrs: { text: '@Jane Doe' } }));
  assert.equal(adfToMarkdown(adf), '@Jane Doe');
});

test('emoji renders its text', () => {
  const adf = doc(p({ type: 'emoji', attrs: { shortName: ':smile:', text: '😄' } }));
  assert.equal(adfToMarkdown(adf), '😄');
});

test('table with header row', () => {
  const cell = (text, header) => ({
    type: header ? 'tableHeader' : 'tableCell',
    content: [p(t(text))],
  });
  const adf = doc({
    type: 'table',
    content: [
      { type: 'tableRow', content: [cell('A', true), cell('B', true)] },
      { type: 'tableRow', content: [cell('1'), cell('2')] },
    ],
  });
  assert.equal(adfToMarkdown(adf), '| A | B |\n| --- | --- |\n| 1 | 2 |');
});

test('task list with checkboxes', () => {
  const adf = doc({
    type: 'taskList',
    content: [
      { type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] },
      { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] },
    ],
  });
  assert.equal(adfToMarkdown(adf), '- [x] done\n- [ ] todo');
});

test('panel prefixes with emoji and quote', () => {
  const adf = doc({
    type: 'panel',
    attrs: { panelType: 'warning' },
    content: [p(t('be careful'))],
  });
  assert.equal(adfToMarkdown(adf), '> ⚠️ be careful');
});

test('media resolves via mediaResolver', () => {
  const adf = doc({
    type: 'mediaSingle',
    content: [{ type: 'media', attrs: { id: '42', alt: 'shot.png' } }],
  });
  const md = adfToMarkdown(adf, {
    mediaResolver: (attrs) => ({ url: 'https://x/att/42', alt: attrs.alt }),
  });
  assert.equal(md, '![shot.png](https://x/att/42)');
});

test('unresolved media falls back to stable marker', () => {
  const adf = doc({ type: 'media', attrs: { id: '99', alt: 'pic' } });
  assert.equal(adfToMarkdown(adf), '![pic](attachment:99)');
});

test('special characters are escaped', () => {
  const adf = doc(p(t('a*b_c')));
  assert.equal(adfToMarkdown(adf), 'a\\*b\\_c');
});

test('empty / null input yields empty string', () => {
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown(doc()), '');
});

test('unknown block still recurses into content', () => {
  const adf = doc({ type: 'someFutureBlock', content: [p(t('kept'))] });
  assert.equal(adfToMarkdown(adf), 'kept');
});

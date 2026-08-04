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

// ---- includeStrikethrough: false ------------------------------------------
// Struck text means "we decided against this", so stripping it has to remove
// the *content*, not just the ~~ markers.

const STRIP = { includeStrikethrough: false };

test('strip: struck text is removed entirely, not just its markers', () => {
  const adf = doc(p(t('keep'), t('drop', [{ type: 'strike' }])));
  assert.equal(adfToMarkdown(adf, STRIP), 'keep');
});

test('strip: default keeps strikethrough (opt-in behaviour)', () => {
  const adf = doc(p(t('drop', [{ type: 'strike' }])));
  assert.equal(adfToMarkdown(adf), '~~drop~~');
  assert.equal(adfToMarkdown(adf, { includeStrikethrough: true }), '~~drop~~');
});

test('strip: a struck inline code span does not survive the code short-circuit', () => {
  const adf = doc(p(t('x'), t('rm -rf', [{ type: 'code' }, { type: 'strike' }])));
  assert.equal(adfToMarkdown(adf, STRIP), 'x');
});

test('strip: a struck link takes its href with it', () => {
  const marks = [{ type: 'link', attrs: { href: 'https://old' } }, { type: 'strike' }];
  const adf = doc(p(t('old plan', marks)));
  assert.equal(adfToMarkdown(adf, STRIP), '');
});

test('strip: mid-sentence removal does not leave a double space', () => {
  const adf = doc(p(t('use a '), t('or b', [{ type: 'strike' }]), t(' today')));
  assert.equal(adfToMarkdown(adf, STRIP), 'use a today');
});

test('strip: surrounding whitespace is trimmed off the run', () => {
  const adf = doc(p(t('drop', [{ type: 'strike' }]), t(' kept ')));
  assert.equal(adfToMarkdown(adf, STRIP), 'kept');
});

test('strip: a wholly struck paragraph disappears', () => {
  const adf = doc(p(t('gone', [{ type: 'strike' }])), p(t('here')));
  assert.equal(adfToMarkdown(adf, STRIP), 'here');
});

test('strip: a wholly struck heading leaves no bare hashes', () => {
  const adf = doc(
    { type: 'heading', attrs: { level: 2 }, content: [t('gone', [{ type: 'strike' }])] },
    p(t('body'))
  );
  assert.equal(adfToMarkdown(adf, STRIP), 'body');
});

test('strip: struck bullets vanish without leaving empty markers', () => {
  const li = (text, marks) => ({ type: 'listItem', content: [p(t(text, marks))] });
  const adf = doc({
    type: 'bulletList',
    content: [li('keep'), li('drop', [{ type: 'strike' }]), li('also keep')],
  });
  assert.equal(adfToMarkdown(adf, STRIP), '- keep\n- also keep');
});

test('strip: ordered list renumbers around a removed item', () => {
  const li = (text, marks) => ({ type: 'listItem', content: [p(t(text, marks))] });
  const adf = doc({
    type: 'orderedList',
    content: [li('first'), li('rejected', [{ type: 'strike' }]), li('second')],
  });
  assert.equal(adfToMarkdown(adf, STRIP), '1. first\n2. second');
});

test('strip: a struck task item is dropped, checkbox and all', () => {
  const item = (text, marks) => ({
    type: 'taskItem',
    attrs: { state: 'TODO' },
    content: [t(text, marks)],
  });
  const adf = doc({ type: 'taskList', content: [item('do it'), item('nope', [{ type: 'strike' }])] });
  assert.equal(adfToMarkdown(adf, STRIP), '- [ ] do it');
});

test('strip: an emptied blockquote does not leave a bare ">"', () => {
  const adf = doc({ type: 'blockquote', content: [p(t('gone', [{ type: 'strike' }]))] });
  assert.equal(adfToMarkdown(adf, STRIP), '');
});

test('strip: an emptied panel does not leave a floating emoji', () => {
  const adf = doc({
    type: 'panel',
    attrs: { panelType: 'warning' },
    content: [p(t('gone', [{ type: 'strike' }]))],
  });
  assert.equal(adfToMarkdown(adf, STRIP), '');
});

test('strip: a literal ~~ in prose is never touched', () => {
  const adf = doc(p(t('the ~~ operator')), p(t('x', [{ type: 'strike' }])));
  assert.equal(adfToMarkdown(adf, STRIP), 'the ~~ operator');
});

test('strip: ~~ inside a code block is never touched', () => {
  const adf = doc({
    type: 'codeBlock',
    attrs: { language: 'md' },
    content: [t('~~struck~~ in a fence')],
  });
  assert.equal(adfToMarkdown(adf, STRIP), '```md\n~~struck~~ in a fence\n```');
});

test('strip: a trailing hard break keeps its two significant spaces', () => {
  const adf = doc(p(t('a'), { type: 'hardBreak' }, t('b'), t('c', [{ type: 'strike' }])));
  assert.equal(adfToMarkdown(adf, STRIP), 'a  \nb');
});

/*
 * Unit tests for the DOM-scrape fallback's HTML -> Markdown conversion.
 * Run with: node --test
 *
 * domScraper.js is a browser content-script global, so there is no DOM here.
 * Rather than pull in a dependency, we hand it the small slice of the DOM API
 * htmlToMarkdown actually touches: nodeType, tagName, childNodes, children,
 * textContent and getAttribute.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// Attaches to module.exports: the UMD wrapper falls back to `this`, which is
// module.exports under CommonJS.
const { htmlToMarkdown } = require('../src/domScraper.js').JiraDomScraper;

const text = (s) => ({ nodeType: 3, textContent: s });

function elem(tag, children, attrs) {
  const kids = (children || []).map((c) => (typeof c === 'string' ? text(c) : c));
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    childNodes: kids,
    getAttribute: (name) => (attrs && attrs[name] != null ? attrs[name] : null),
  };
  Object.defineProperty(node, 'children', { get: () => kids.filter((k) => k.nodeType === 1) });
  Object.defineProperty(node, 'textContent', {
    get: () => kids.map((k) => k.textContent).join(''),
  });
  return node;
}

const STRIP = { includeStrikethrough: false };

test('dom: strikethrough tags become ~~ by default', () => {
  const root = elem('div', ['keep ', elem('s', ['drop'])]);
  assert.equal(htmlToMarkdown(root), 'keep ~~drop~~');
});

test('dom: <del>, <s> and <strike> are all recognised', () => {
  for (const tag of ['del', 's', 'strike']) {
    const root = elem('div', [elem(tag, ['x'])]);
    assert.equal(htmlToMarkdown(root), '~~x~~', tag);
    assert.equal(htmlToMarkdown(root, STRIP), '', tag);
  }
});

test('dom: stripping removes the struck subtree, nested formatting included', () => {
  const root = elem('div', ['keep ', elem('s', [elem('strong', ['bold gone'])])]);
  assert.equal(htmlToMarkdown(root, STRIP), 'keep');
});

test('dom: mid-sentence removal does not leave a double space', () => {
  const root = elem('div', [elem('p', ['use a ', elem('del', ['or b']), ' today'])]);
  assert.equal(htmlToMarkdown(root, STRIP), 'use a today');
});

test('dom: a <br> keeps its two significant trailing spaces', () => {
  const root = elem('div', ['a', elem('br'), 'b ', elem('s', ['c'])]);
  assert.equal(htmlToMarkdown(root, STRIP), 'a  \nb');
});

test('dom: struck list items are dropped, not left as bare bullets', () => {
  const li = (child) => elem('li', [child]);
  const root = elem('div', [
    elem('ul', [li('keep'), li(elem('s', ['drop'])), li('also keep')]),
  ]);
  assert.equal(htmlToMarkdown(root, STRIP), '- keep\n- also keep');
});

test('dom: ordered list renumbers around a removed item', () => {
  const li = (child) => elem('li', [child]);
  const root = elem('div', [
    elem('ol', [li('first'), li(elem('del', ['rejected'])), li('second')]),
  ]);
  assert.equal(htmlToMarkdown(root, STRIP), '1. first\n2. second');
});

test('dom: an emptied list disappears entirely', () => {
  const root = elem('div', [elem('ul', [elem('li', [elem('s', ['gone'])])])]);
  assert.equal(htmlToMarkdown(root, STRIP), '');
});

test('dom: unaffected markup is untouched by the strip option', () => {
  const root = elem('div', [
    elem('h2', ['Title']),
    elem('p', ['See ', elem('a', ['docs'], { href: 'https://x' }), '.']),
  ]);
  assert.equal(htmlToMarkdown(root, STRIP), htmlToMarkdown(root));
  assert.equal(htmlToMarkdown(root, STRIP), '## Title\n\nSee [docs](https://x).');
});

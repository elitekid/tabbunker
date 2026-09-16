import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOneTabLine,
  parseOneTabText,
  parseSessionBuddyJson,
  parseTabBunkerJson,
} from '../src/shared/importers.js';

describe('parseOneTabLine', () => {
  it('url | title 형식', () => {
    const tab = parseOneTabLine('https://example.com | Example Title');
    assert.ok(tab);
    assert.equal(tab.url, 'https://example.com');
    assert.equal(tab.title, 'Example Title');
  });

  it('제목 없는 줄 (url만)', () => {
    const tab = parseOneTabLine('https://example.com');
    assert.ok(tab);
    assert.equal(tab.url, 'https://example.com');
    assert.equal(tab.title, '');
  });

  it('잘못된 줄은 null', () => {
    assert.equal(parseOneTabLine('not a valid url'), null);
    assert.equal(parseOneTabLine(''), null);
  });
});

describe('parseOneTabText', () => {
  it('빈 줄로 그룹 구분', () => {
    const text = [
      'https://a.com | A',
      'https://b.com',
      '',
      'https://c.com | C',
    ].join('\n');
    const groups = parseOneTabText(text);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].tabs.length, 2);
    assert.equal(groups[1].tabs.length, 1);
  });

  it('잘못된 줄 건너뛰기', () => {
    const text = 'https://ok.com\ninvalid line\nhttps://also.com';
    const groups = parseOneTabText(text);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs.length, 2);
  });
});

describe('parseSessionBuddyJson', () => {
  it('배열 형식 세션', () => {
    const json = JSON.stringify([
      {
        name: 'Morning',
        created: 1609459200000,
        windows: [
          {
            tabs: [
              { url: 'https://a.com', title: 'A' },
              { url: 'https://b.com', title: 'B' },
            ],
          },
        ],
      },
    ]);
    const groups = parseSessionBuddyJson(json);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, 'Morning');
    assert.equal(groups[0].tabs.length, 2);
  });

  it('sessions 래핑 형식', () => {
    const json = JSON.stringify({
      sessions: [
        {
          title: 'Wrapped',
          tabs: [{ url: 'https://x.com', title: 'X' }],
        },
      ],
    });
    const groups = parseSessionBuddyJson(json);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].tabs[0].url, 'https://x.com');
  });

  it('잘못된 JSON은 빈 배열', () => {
    assert.deepEqual(parseSessionBuddyJson('not json'), []);
  });
});

describe('parseTabBunkerJson', () => {
  it('TabBunker 스냅샷 파싱', () => {
    const json = JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'g1',
          title: 'Test',
          createdAt: 1000,
          locked: false,
          trashedAt: null,
          tabs: [{ url: 'https://t.com', title: 'T', favIconUrl: '', pinned: false }],
        },
      ],
    });
    const groups = parseTabBunkerJson(json);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, 'Test');
  });
});

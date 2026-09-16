import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportTabBunkerJson,
  exportOneTabText,
  exportHtmlBookmarks,
} from '../src/shared/exporters.js';
import { parseOneTabText, parseTabBunkerJson } from '../src/shared/importers.js';
import { createGroup, createTab, groupsFromSnapshot } from '../src/shared/model.js';

const sampleGroups = [
  createGroup({
    title: 'Group One',
    tabs: [
      createTab({ url: 'https://alpha.com', title: 'Alpha' }),
      createTab({ url: 'https://beta.com', title: '' }),
    ],
  }),
  createGroup({
    title: 'Group Two',
    tabs: [createTab({ url: 'https://gamma.com', title: 'Gamma' })],
  }),
];

describe('exportTabBunkerJson roundtrip', () => {
  it('json -> import -> json 동일 구조', () => {
    const json1 = exportTabBunkerJson(sampleGroups, { dedupeUrls: false });
    const groups = parseTabBunkerJson(json1);
    const json2 = exportTabBunkerJson(groups, { dedupeUrls: false });
    const snap1 = JSON.parse(json1);
    const snap2 = JSON.parse(json2);
    assert.equal(snap1.groups.length, snap2.groups.length);
    assert.equal(snap1.groups[0].title, snap2.groups[0].title);
    assert.equal(snap1.groups[0].tabs.length, snap2.groups[0].tabs.length);
    assert.equal(snap1.groups[0].tabs[0].url, snap2.groups[0].tabs[0].url);
  });
});

describe('exportOneTabText roundtrip', () => {
  it('onetab -> import -> onetab 동일', () => {
    const text1 = exportOneTabText(sampleGroups);
    const groups = parseOneTabText(text1);
    // import 시 제목이 자동 생성되므로 탭 URL만 비교
    const urls1 = sampleGroups.flatMap((g) => g.tabs.map((t) => t.url)).sort();
    const urls2 = groups.flatMap((g) => g.tabs.map((t) => t.url)).sort();
    assert.deepEqual(urls1, urls2);
  });
});

describe('exportHtmlBookmarks', () => {
  it('HTML에 URL 포함', () => {
    const html = exportHtmlBookmarks(sampleGroups);
    assert.ok(html.includes('https://alpha.com'));
    assert.ok(html.includes('Group One'));
    assert.ok(html.includes('<!DOCTYPE NETSCAPE-Bookmark-file-1>'));
  });

  it('html 파싱 후 json 왕복 (groupsFromSnapshot)', () => {
    const json = exportTabBunkerJson(sampleGroups);
    const groups = groupsFromSnapshot(JSON.parse(json));
    const json2 = exportTabBunkerJson(groups);
    assert.equal(
      JSON.parse(json).groups.length,
      JSON.parse(json2).groups.length
    );
  });
});

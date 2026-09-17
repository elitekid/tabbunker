import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMergePreview,
  createGroup,
  createTab,
  dedupeTabsInGroup,
  findDuplicateUrls,
  mergeGroups,
  normalizeUrl,
  purgeExpiredTrash,
  filterGroups,
} from '../src/shared/model.js';
import {
  REVIEW_PROMPT_MIN_AGE_MS,
  REVIEW_PROMPT_MIN_COLLAPSES,
  shouldShowReviewPrompt,
} from '../src/shared/review-prompt.js';

describe('normalizeUrl', () => {
  it('소문자로 정규화', () => {
    assert.equal(normalizeUrl('https://Example.com/'), 'https://example.com');
  });

  it('잘못된 URL은 trim만', () => {
    assert.equal(normalizeUrl('  not-a-url  '), 'not-a-url');
  });
});

describe('findDuplicateUrls', () => {
  it('중복 URL 감지', () => {
    const groups = [
      createGroup({
        title: 'A',
        tabs: [
          createTab({ url: 'https://a.com' }),
          createTab({ url: 'https://b.com' }),
        ],
      }),
      createGroup({
        title: 'B',
        tabs: [createTab({ url: 'https://a.com' })],
      }),
    ];
    const dupes = findDuplicateUrls(groups);
    assert.equal(dupes.size, 1);
    assert.ok(dupes.has('https://a.com'));
  });
});

describe('computeMergePreview', () => {
  it('겹치는 그룹·새 탭 수 계산', () => {
    const existing = [
      createGroup({
        title: 'Work',
        tabs: [createTab({ url: 'https://existing.com' })],
      }),
    ];
    const incoming = [
      createGroup({
        title: 'Work',
        tabs: [
          createTab({ url: 'https://existing.com' }),
          createTab({ url: 'https://new.com' }),
        ],
      }),
      createGroup({
        title: 'Personal',
        tabs: [createTab({ url: 'https://other.com' })],
      }),
    ];
    const preview = computeMergePreview(existing, incoming);
    assert.equal(preview.groupCount, 2);
    assert.equal(preview.tabCount, 3);
    assert.equal(preview.overlappingGroupCount, 1);
    assert.equal(preview.newTabCount, 2);
  });
});

describe('mergeGroups', () => {
  it('merge 모드: 같은 제목 그룹에 탭 추가', () => {
    const existing = [
      createGroup({ title: 'A', tabs: [createTab({ url: 'https://a.com' })] }),
    ];
    const incoming = [
      createGroup({ title: 'A', tabs: [createTab({ url: 'https://b.com' })] }),
      createGroup({ title: 'B', tabs: [createTab({ url: 'https://c.com' })] }),
    ];
    const result = mergeGroups(existing, incoming, 'merge');
    assert.equal(result.length, 2);
    const a = result.find((g) => g.title === 'A');
    assert.equal(a.tabs.length, 2);
  });

  it('replace 모드: 잠기지 않은 활성 그룹은 휴지통으로', () => {
    const existing = [
      createGroup({ title: 'Old', tabs: [createTab({ url: 'https://old.com' })] }),
    ];
    const incoming = [
      createGroup({ title: 'New', tabs: [createTab({ url: 'https://new.com' })] }),
    ];
    const result = mergeGroups(existing, incoming, 'replace');
    assert.equal(result.length, 2);
    const old = result.find((g) => g.title === 'Old');
    const neu = result.find((g) => g.title === 'New');
    assert.ok(old.trashedAt);
    assert.equal(neu.title, 'New');
    assert.ok(!neu.trashedAt);
  });
});

describe('dedupeTabsInGroup', () => {
  it('그룹 내 중복 URL 제거', () => {
    const tabs = [
      createTab({ url: 'https://a.com', title: 'First' }),
      createTab({ url: 'https://A.COM/', title: 'Dup' }),
      createTab({ url: 'https://b.com' }),
    ];
    const result = dedupeTabsInGroup(tabs);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'First');
  });
});

describe('purgeExpiredTrash', () => {
  it('30일 지난 휴지통 그룹 삭제', () => {
    const now = Date.now();
    const groups = [
      createGroup({ title: 'Active' }),
      createGroup({ title: 'Trashed', trashedAt: now - 31 * 24 * 60 * 60 * 1000 }),
      createGroup({ title: 'Recent Trash', trashedAt: now - 1 * 24 * 60 * 60 * 1000 }),
    ];
    const result = purgeExpiredTrash(groups, now);
    assert.equal(result.length, 2);
    assert.ok(result.some((g) => g.title === 'Active'));
    assert.ok(result.some((g) => g.title === 'Recent Trash'));
  });
});

describe('filterGroups', () => {
  it('제목·URL 검색', () => {
    const groups = [
      createGroup({
        title: 'Docs',
        tabs: [createTab({ url: 'https://example.com', title: 'Example' })],
      }),
    ];
    const byTitle = filterGroups(groups, 'docs');
    assert.equal(byTitle.length, 1);
    const byUrl = filterGroups(groups, 'example.com');
    assert.equal(byUrl.length, 1);
    assert.equal(byUrl[0].tabs.length, 1);
  });
});

describe('shouldShowReviewPrompt', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const baseSettings = {
    firstRunComplete: true,
    collapseCount: REVIEW_PROMPT_MIN_COLLAPSES,
    installedAt: now - REVIEW_PROMPT_MIN_AGE_MS,
  };
  const baseState = { lastFileOkAt: now - 1000 };

  it('모든 조건 충족 시 true', () => {
    assert.equal(
      shouldShowReviewPrompt({ settings: baseSettings, backupState: baseState, now }),
      true
    );
  });

  it('collapseCount 부족 시 false', () => {
    assert.equal(
      shouldShowReviewPrompt({
        settings: { ...baseSettings, collapseCount: REVIEW_PROMPT_MIN_COLLAPSES - 1 },
        backupState: baseState,
        now,
      }),
      false
    );
  });

  it('reviewPrompt dismissed 시 false', () => {
    assert.equal(
      shouldShowReviewPrompt({
        settings: { ...baseSettings, reviewPrompt: 'dismissed' },
        backupState: baseState,
        now,
      }),
      false
    );
  });
});

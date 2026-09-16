# TabBunker 설계서 (작업명, 2026-09-14)

## 한 줄
탭을 한 번에 접어 목록으로 저장하는 확장. 차별점은 단 하나, "절대 잃어버리지 않는다": 저장할 때마다 자동 파일 백업, 복원 전 미리보기, OneTab·Session Buddy 데이터 가져오기, 확장을 지웠다 깔아도 백업에서 복구.

## 근거(GAPS.md)
OneTab 200만 사용자, 최근 리뷰 "업데이트하니 탭 전부 사라짐"(2026-08). Session Buddy 100만, "2년치 잃음". 둘 다 브라우저 내부 저장소에만 의존. 대체품(TSM, Tabme)도 소실 사례 있음.

## 원칙
- 서버 없음, 계정 없음, 네트워크 요청 0. 모든 데이터는 브라우저 로컬(chrome.storage.local + IndexedDB)과 사용자 파일.
- 권한 최소: tabs, storage, downloads(자동 백업용), unlimitedStorage, alarms, contextMenus, 크롬만 favicon. host_permissions 없음.
- Manifest V3. 크롬·엣지·파이어폭스 한 코드베이스(browser 네임스페이스 shim). 사파리는 이후.
- 이모지 금지. UI 언어: 영어 기본, 한국어 로케일(_locales/en, ko).

## 기능(v1)
1. 접기(Collapse): 툴바 아이콘 클릭 또는 단축키(Alt+Shift+S) → 현재 창의 탭(고정 탭 제외 옵션)을 하나의 그룹으로 저장하고 탭을 닫는다. 그룹은 제목(기본: 날짜시간 + 첫 탭 제목), 생성 시각, 탭 목록(url, title, favIconUrl, pinned).
2. 목록 페이지(Vault): 확장 페이지(vault.html)에서 그룹을 최신순으로 표시. 그룹별 전체 복원/개별 복원(기본: 복원 후 목록에서 제거, 옵션으로 유지), 그룹 이름 변경, 삭제(휴지통 → 30일 뒤 영구 삭제), 잠금(실수 삭제 방지), 검색(제목·URL, 즉시 필터), 드래그로 탭을 다른 그룹으로 이동, 중복 URL 표시.
3. 자동 백업: 데이터 변경 시 첫 미반영 변경으로부터 30초(설정 5분·30분) 뒤 JSON 스냅샷을 (a) chrome.storage.local의 최근 스냅샷 링(최근 20개, 용량 상한 50MB) (b) 옵션 켜면 Downloads/TabBunker/tabbunker-latest.json 에 chrome.downloads 로 덮어쓰기(conflictAction: overwrite, saveAs: false) 및 직전 날짜 파일 후 60분 이상 지났으면 tabbunker-YYYYMMDD-HHMM.json 을 추가(최근 30개 유지, 초과분 removeFile+erase). 다운로드 완료 이벤트로만 성공을 기록하고 상태를 보관함 상단에 표시. 상세 설계는 docs/design/DESIGN.md.
4. 복원 미리보기: 백업 파일을 열면(파일 선택) 병합 전에 "그룹 N개, 탭 M개, 기존과 겹치는 그룹 K개, 새로 추가될 탭 J개"와 그룹 목록을 보여 주고 "병합" 또는 "교체"를 선택. 되돌리기(직전 상태 스냅샷) 1회.
5. 가져오기: OneTab 내보내기 텍스트(줄마다 "url | title", 빈 줄로 그룹 구분), Session Buddy JSON 내보내기, TabBunker 자체 JSON. 가져오기 전 미리보기 동일.
6. 내보내기: TabBunker JSON, OneTab 호환 텍스트, HTML 북마크 파일.
7. 설정: 고정 탭 포함 여부, 복원 후 제거 여부, 자동 파일 백업 on/off, 백업 폴더 하위 이름, 중복 URL 자동 제거, 단축키 안내, 데이터 전체 삭제.
8. 첫 실행 온보딩: "OneTab 쓰던 데이터 가져오기" 버튼이 첫 화면 중앙에. 설치 직후 백업 폴더 안내.

## 비기능
- 탭 10,000개 목록에서 검색·렌더링이 100ms 내(가상 스크롤 또는 페이지네이션).
- 서비스워커 종료에 안전: 상태는 항상 storage에, 메모리 캐시 없음. 알람 API로 휴지통 정리.
- 파이어폭스: background를 이벤트 페이지(scripts)로, downloads API 동일. manifest는 빌드 시 분기.
- 접근성: 키보드만으로 복원·삭제 가능, 포커스 링, aria 레이블.

## 구조
```
tab-bunker/
  src/
    shared/browser.js       # globalThis.browser ?? chrome 래핑(프로미스)
    shared/model.js         # 그룹·탭 스키마, 검증, 병합·중복 계산 (순수 함수)
    shared/importers.js     # onetab/sessionbuddy/tabbunker 파서 (순수 함수)
    shared/exporters.js     # json/onetab/html (순수 함수)
    shared/storage.js       # storage.local + IndexedDB 접근, 스냅샷 링
    background.js           # 액션 클릭·단축키·알람·자동 백업 스케줄
    vault/vault.html, vault.js, vault.css
    options/options.html, options.js
    _locales/en/messages.json, ko/messages.json
    icons/16,32,48,128.png (단색 심플, 생성)
  manifest.chrome.json, manifest.firefox.json
  scripts/build.mjs         # dist/chrome, dist/firefox 생성(zip 포함)
  test/*.test.mjs           # node --test: model, importers, exporters, merge preview
  README.md, PRIVACY.md(수집 없음 명시), CHANGELOG.md
```

## 완료 조건(v1)
- `node --test test/` 통과(순수 로직 전부).
- `node scripts/build.mjs` 가 dist/chrome, dist/firefox 를 만들고 manifest가 유효.
- 크롬(헤드리스 --load-extension)에서 서비스워커가 등록되고 콘솔 오류 0.
- 실제 시나리오 스모크(Fable가 수행): 탭 3개 접기 → vault에 그룹 1개 → 복원 → 백업 파일 생성 확인 → OneTab 텍스트 가져오기 미리보기.

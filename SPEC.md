# TabBunker 설계서 (작업명, 2026-09-14)

## 한 줄
탭을 한 번에 접어 목록으로 저장하는 확장. 차별점은 단 하나, "절대 잃어버리지 않는다": 저장할 때마다 자동 파일 백업, 복원 전 미리보기, OneTab·Session Buddy 데이터 가져오기, 확장을 지웠다 깔아도 백업에서 복구.

## 근거(GAPS.md)
OneTab 200만 사용자, 최근 리뷰 "업데이트하니 탭 전부 사라짐"(2026-08). Session Buddy 100만, "2년치 잃음". 둘 다 브라우저 내부 저장소에만 의존. 대체품(TSM, Tabme)도 소실 사례 있음.

## 원칙
- 서버 없음, 계정 없음, 네트워크 요청 0. 모든 데이터는 브라우저 로컬(chrome.storage.local + IndexedDB)과 사용자 파일.
- 권한 최소: tabs, storage, downloads(자동 백업용), unlimitedStorage, alarms, contextMenus, 크롬만 favicon·downloads.ui(백업 중 다운로드 표시 숨김). host_permissions 없음.
- Manifest V3. 크롬·엣지·파이어폭스 한 코드베이스(browser 네임스페이스 shim). 사파리는 이후.
- 이모지 금지. UI 언어: 영어 기본, 한국어 로케일(_locales/en, ko).

## 기능(v1)
1. 툴바 드롭다운과 접기(Collapse) — 1.1.0 재설계(2026-09-17, 사용자 결정). 이유: 스토어판 1.0.0을 진짜 크롬에서 써 보니 아이콘을 누르자마자 창의 탭이 확인 없이 전부 닫히고, 보관·설치 때마다 보관함 새 탭이 강제로 열렸다.
   - 툴바 아이콘은 드롭다운(action default_popup, 폭 380, 높이 최대 580)을 연다. 아이콘 클릭만으로는 어떤 탭도 닫히지 않는다.
   - 드롭다운 머리: 이름 + 파일 백업 상태 한 줄.
   - 저장 칸: "이 창의 탭 N개"와 제외 안내(고정 탭 설정, 브라우저·확장 페이지, 시크릿 창은 보관 불가). 버튼 [보관하고 닫기](주) [닫지 않고 보관]. "탭 고르기"를 펼치면 체크 목록(기본 전부 선택)이 나오고 버튼이 "M개 보관하고 닫기"로 바뀐다. 선택 0개면 버튼 비활성.
   - 보관 뒤 보관함 탭을 열지 않는다. 드롭다운에 "탭 N개를 보관했어요 · 되돌리기"를 보인다. 드롭다운이 닫혀 버렸으면 다음에 열 때 되돌리기 가능한 최근 보관을 목록 맨 위에 같은 알림으로 보인다.
   - 창의 탭을 전부 닫게 되면 창이 사라지지 않게 빈 새 탭 하나를 먼저 연다.
   - 보관 목록: 검색(제목·URL), 그룹 최신순(제목·탭 수·시간). 그룹을 펼치면 탭 목록, 탭을 누르면 그 탭 하나를 현재 창에 연다. 그룹 동작: 모두 열기(30개 이상은 드롭다운 안에서 확인), 이름 바꾸기, 잠금, 삭제(휴지통, 잠긴 그룹은 불가). 휴지통 그룹은 드롭다운에 보이지 않는다.
   - 바닥: "전체 화면으로 관리"(보관함 탭 열기·기존 탭이 있으면 그 탭으로 이동), "설정".
   - 단축키(Alt+Shift+S)와 우클릭 "이 창의 탭 모두 보내기"·"이 탭 보내기"는 명시 동작이라 드롭다운 없이 바로 보관하고, 보관함을 열지 않고 배지로 개수를 알린다.
   - 설치 직후 어떤 페이지도 자동으로 열지 않는다.
   - "닫지 않고 보관"은 탭을 닫지 않고 그룹만 만든다. 되돌리기는 그 그룹을 지운다.
   - 보관하면 그룹은 제목(기본: 날짜시간 + 첫 탭 제목), 생성 시각, 탭 목록(url, title, favIconUrl, pinned)을 가진다.
   - 보관함(vault.html)은 사용자가 열 때만 열리는 전체 관리 화면이다(가져오기·내보내기·드래그·휴지통·백업 파일 복구). 보관함의 보관 배너는 되돌리기 뒤 사라진다. 보관함 첫 실행 카드는 보관 버튼 없이 안내만 한다: 보관·다시 열기는 툴바 아이콘 드롭다운에서, 아이콘이 안 보이면 확장 메뉴에서 고정, 단축키는 고르지 않고 바로 보관, 이 화면은 가져오기·내보내기·드래그·휴지통·백업 파일 복구용, 그리고 기존 탭 관리자에서 가져오기 버튼.
2. 목록 페이지(Vault): 확장 페이지(vault.html)에서 그룹을 최신순으로 표시. 그룹별 전체 복원/개별 복원(기본: 복원 후 목록에서 제거, 옵션으로 유지), 그룹 이름 변경, 삭제(휴지통 → 30일 뒤 영구 삭제), 잠금(실수 삭제 방지), 검색(제목·URL, 즉시 필터), 드래그로 탭을 다른 그룹으로 이동, 중복 URL 표시.
3. 자동 백업: 데이터 변경 시 첫 미반영 변경으로부터 30초(설정 5분·30분) 뒤 JSON 스냅샷을 (a) chrome.storage.local의 최근 스냅샷 링(최근 20개, 용량 상한 50MB) (b) 옵션 켜면 Downloads/TabBunker/tabbunker-latest.json 에 chrome.downloads 로 덮어쓰기(conflictAction: overwrite, saveAs: false) 및 직전 날짜 파일 후 60분 이상 지났으면 tabbunker-YYYYMMDD-HHMM.json 을 추가(최근 30개 유지, 초과분 removeFile+erase). 다운로드 완료 이벤트로만 성공을 기록하고 상태를 보관함 상단에 표시. 자동 백업 다운로드가 진행되는 동안에는 브라우저 다운로드 표시(크롬·엣지 다운로드 버블)를 downloads.setUiOptions({enabled:false})로 숨기고, 진행 중인 백업 다운로드가 없어지면 즉시 다시 켠다(서비스워커 시작 시에도 켬). 권한 downloads.ui 는 기존 downloads 와 같은 경고라 업데이트 때 확장이 꺼지지 않는다. 파이어폭스는 API가 없어 그대로 둔다(1.1.0, 2026-09-17: 변경마다 30초 뒤 다운로드 버블이 자동으로 튀어나와 "JSON이 계속 다운로드된다"로 보인 실사용 문제). 상세 설계는 docs/design/DESIGN.md.
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

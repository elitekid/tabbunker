// 리뷰 요청 배너 표시 조건 (순수 함수)

export const REVIEW_PROMPT_MIN_AGE_MS = 48 * 60 * 60 * 1000;
export const REVIEW_PROMPT_MIN_COLLAPSES = 3;

/**
 * 저장소 상태만으로 리뷰 배너를 보여줄지 판정한다.
 * UI에서 온보딩·가져오기 미리보기가 열려 있으면 호출측에서 추가로 막는다.
 */
export function shouldShowReviewPrompt({ settings, backupState, now = Date.now() }) {
  if (!settings?.firstRunComplete) return false;

  const prompt = settings.reviewPrompt;
  if (prompt === 'rated' || prompt === 'dismissed') return false;
  if (prompt != null) return false;

  const collapseCount = settings.collapseCount ?? 0;
  if (collapseCount < REVIEW_PROMPT_MIN_COLLAPSES) return false;

  const installedAt = settings.installedAt;
  if (!installedAt || now - installedAt < REVIEW_PROMPT_MIN_AGE_MS) return false;

  if (!backupState?.lastFileOkAt) return false;

  return true;
}

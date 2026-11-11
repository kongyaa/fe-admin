// 접수 상태(접수 전, 접수 중, 마감). 날짜는 모두 KST의 YYYY-MM-DD 문자열이다.
export const RECEPTION = { BEFORE: '접수 전', OPEN: '접수 중', CLOSED: '마감' };

// 오늘(KST)과 공고 전체 접수 기간(가장 이른 시작일 ~ 가장 늦은 종료일)을 비교한다.
// 시작일이 없으면 알 수 없어 null이다. 종료일이 없으면 시작 전일 때만 `접수 전`이고, 그 밖에는 마감 여부를 몰라 null이다.
// 모르는 값을 틀린 상태로 적지 않으려는 것이다.
export function receptionStatus(start, end, today) {
  if (!start || !today) return null;
  if (today < start) return RECEPTION.BEFORE;
  if (!end) return null;
  return today > end ? RECEPTION.CLOSED : RECEPTION.OPEN;
}

// 이번 실행에서 다시 판정하지 않은 저장된 행 중 접수 상태를 고쳐야 할 행. 저장된 시작일·종료일로 계산한다.
// 계산할 수 없거나(null) 이미 같은 값이면 뺀다. 다른 열은 보지 않는다.
export function selectStatusUpdates(rows, today) {
  const updates = [];
  for (const row of rows) {
    const status = receptionStatus(row.start, row.end, today);
    if (status && status !== row.receptionStatus) updates.push({ row, status });
  }
  return updates;
}

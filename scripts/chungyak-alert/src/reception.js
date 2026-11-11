// 접수 상태(접수 전, 접수 중, 마감). 날짜는 모두 KST의 YYYY-MM-DD 문자열이다.
export const RECEPTION = { BEFORE: '접수 전', OPEN: '접수 중', CLOSED: '마감' };

// 오늘(KST)과 공고 전체 접수 기간(가장 이른 시작일 ~ 가장 늦은 종료일)을 비교한다.
// 시작일이 없으면 알 수 없어 null이다. 종료일이 없으면 시작 전일 때만 `접수 전`이고, 그 밖에는 마감 여부를 몰라 null이다.
// 모르는 값을 틀린 상태로 적지 않으려는 것이다.
// 날짜를 믿을 수 없을 때는 옵션으로 알린다.
// - startReliable=false(LH 목록의 공고일~마감일 대체): 시작일은 공고일일 뿐이라 쓰지 않는다. 종료일이 지났을 때만 `마감`, 그 전은 null.
// - endReliable=false(종료일이 단계 시작일로 채운 값): 시작 전에는 `접수 전`이고, 그 뒤에는 `마감`을 단정하지 않고 null이다.
export function receptionStatus(start, end, today, { startReliable = true, endReliable = true } = {}) {
  if (!today) return null;
  if (!startReliable) return end && endReliable && today > end ? RECEPTION.CLOSED : null;
  if (!start) return null;
  if (today < start) return RECEPTION.BEFORE;
  if (!end || !endReliable) return null;
  return today > end ? RECEPTION.CLOSED : RECEPTION.OPEN;
}

// 저장된 행만 있을 때의 시작일 신뢰. 저장된 행에는 대체 표시가 없어 LH 행은 단계 날짜 열(특별공급, 1순위, 2순위 접수일)이
// 하나도 없으면 목록의 공고일~마감일 대체로 본다. 모르면 시작일을 믿지 않는 쪽이다(마감만 적는다).
const storedStartReliable = (row) => row.source !== 'LH' || Boolean(row.special || row.rank1 || row.rank2);

// 이번 실행에 수집한 공고가 날짜를 갖고 있으면 그 날짜(가장 최신)로, 아니면 저장된 행의 날짜로 계산한다.
// 정정으로 일정이 바뀐 공고가 옛 저장 날짜 때문에 `마감`이 되지 않게 한다.
export function statusFor(notice, row, today) {
  if (notice?.overallStart || notice?.overallEnd) {
    return receptionStatus(notice.overallStart ?? null, notice.overallEnd ?? null, today, {
      startReliable: !notice.windowFromList,
      endReliable: !notice.endInferred,
    });
  }
  if (!row) return null;
  return receptionStatus(row.start, row.end, today, { startReliable: storedStartReliable(row) });
}

// 이번 실행에서 다시 판정하지 않은 저장된 행 중 접수 상태를 고쳐야 할 행. noticeOf(key)는 이번 실행에 수집한 공고(없으면 null)다.
// 계산할 수 없거나(null) 이미 같은 값이면 뺀다. 다른 열은 보지 않는다. `마감`을 먼저 둔다(표에서 가장 눈에 띄는 차이).
export function selectStatusUpdates(rows, today, noticeOf = () => null) {
  const updates = [];
  for (const row of rows) {
    const status = statusFor(noticeOf(row.key), row, today);
    if (status && status !== row.receptionStatus) updates.push({ row, status });
  }
  return updates.sort((a, b) => Number(b.status === RECEPTION.CLOSED) - Number(a.status === RECEPTION.CLOSED));
}

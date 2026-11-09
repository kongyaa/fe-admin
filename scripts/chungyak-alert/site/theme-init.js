// 화면 테마 미리 적용 — <head> 에서 동기로 읽는 일반(모듈 아님) 스크립트.
// 처음 그리기 전에 저장된 테마를 붙여서 잘못된 색이 잠깐 보이지 않게 한다.
// 키와 값은 app.js 의 THEME_KEY·normalizeTheme 과 같게 둔다. 저장값이 없으면 시스템(기기 설정)을 따른다.
(function () {
  try {
    var theme = window.localStorage.getItem('bunyang-map-theme');
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.setAttribute('content', theme);
  } catch (e) {
    // 저장소가 막혀 있으면(사생활 보호 모드 등) 시스템 설정을 따른다
  }
})();

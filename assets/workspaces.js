/* 노무법인 태(泰) 통합 업무시스템 — 업무 목록(메인 화면 카드)과 업무별 화면 연결.
 * 원래 Python 프로그램의 app/workspaces/__init__.py 와 같은 구조입니다.
 *
 * 업무를 추가하는 방법
 *  1) 아래 WORKSPACES 에 한 줄 추가(route·제목·설명·아이콘·ready)
 *  2) ready: false 면 '준비 중인 서비스입니다' 화면이 자동으로 나옴
 *  3) 기능을 만들 때는 index.html 에 <section data-view="업무route"> 를 만들고 ready: true 로 바꿈
 *     (4대보험 청구시스템처럼 기존 화면을 쓰면 view 에 그 화면 이름을 적음)
 * 주소는 https://…/cplatae/#업무route — 새로 고침하거나 주소로 바로 들어와도 같은 화면이 열림.
 */
(function(){
  'use strict';
  var WORKSPACES = [
    { route: 'insurance', view: 'write', title: '4대보험 청구시스템', nav: '4대보험 청구', icon: 'shield', ready: true,
      desc: '위임자·수임자 정보로 국민연금·세무서·근로복지공단 서류를 자동 작성하고 미리보기·다운로드' },
    { route: 'average-wage', title: '평균임금', icon: 'calculator', ready: false, desc: '평균임금 산정 업무' },
    { route: 'hearing-loss', title: '난청', icon: 'ear', ready: false, desc: '소음성 난청 산재 업무' },
    { route: 'musculoskeletal', title: '근골격계', icon: 'bone', ready: false, desc: '근골격계 질환 산재 업무' },
    { route: 'pneumoconiosis', title: '진폐', icon: 'lungs', ready: false, desc: '진폐 산재 업무' }
  ];

  // 업무 카드 아이콘(선 그림 SVG — 원래 프로그램의 templates/workspaces/_icons.html 과 같음)
  var ICONS = {
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    calculator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01M16 17h.01"/>',
    ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-2 3.5-3 5.5S13 19 11 19a2.5 2.5 0 0 1-2.5-2.5"/><path d="M10 9.5a2 2 0 0 1 4 0c0 1-1 1.5-1.5 2"/>',
    bone: '<circle cx="12" cy="4.5" r="1.8"/><path d="M12 7v5"/><path d="M8 9.5l4-1 4 1"/><path d="M12 12l-3 8"/><path d="M12 12l3 8"/><path d="M10.5 15h3"/>',
    lungs: '<path d="M12 4v8"/><path d="M12 10c-1 1-2 1.5-3 1.5"/><path d="M12 10c1 1 2 1.5 3 1.5"/><path d="M9 7c-2.5 1-4 4-4 8 0 2.5 1 4 2.5 4S10 18 10 15v-4"/><path d="M15 7c2.5 1 4 4 4 8 0 2.5-1 4-2.5 4S14 18 14 15v-4"/>'
  };
  function icon(name, size){
    return '<svg class="ws-icon" viewBox="0 0 24 24" width="' + (size || 36) + '" height="' + (size || 36) + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || '<rect x="4" y="4" width="16" height="16" rx="3"/>') + '</svg>';
  }
  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  /** 메인 화면 카드 그리기. busy(route) 가 true 면 '작성 중' 표시 */
  function renderHome(el, busy){
    el.innerHTML = WORKSPACES.map(function(w){
      var badge = w.ready ? '<span class="ws-badge ok">사용 가능</span>' : '<span class="ws-badge warn">준비 중</span>';
      var doing = busy && busy(w.route) ? '<span class="ws-badge doing">작성 중인 서류 있음</span>' : '';
      return '<li><a class="ws-card' + (w.ready ? '' : ' is-preparing') + '" href="#' + w.route + '">' +
        '<span class="ws-icon-wrap">' + icon(w.icon) + '</span>' +
        '<span class="ws-text"><span class="ws-title">' + esc(w.title) + '</span><span class="ws-desc">' + esc(w.desc) + '</span></span>' +
        '<span class="ws-badges">' + badge + doing + '</span></a></li>';
    }).join('');
  }
  function renderPreparing(el, w){
    el.innerHTML = '<span class="ws-icon-wrap big">' + icon(w.icon, 44) + '</span><h1>' + esc(w.title) + '</h1>' +
      '<p class="preparing-msg">준비 중인 서비스입니다.</p>' +
      '<p class="muted">이 업무는 현재 개발 중입니다. 완료되면 이 메뉴에서 바로 이용할 수 있습니다.</p>' +
      '<p><a class="btn sm" href="#home">메인 화면으로 돌아가기</a></p>';
  }
  function find(route){ return WORKSPACES.filter(function(w){ return w.route === route; })[0] || null; }

  window.TaeWorkspaces = { list: WORKSPACES, find: find, renderHome: renderHome, renderPreparing: renderPreparing, icon: icon };
})();

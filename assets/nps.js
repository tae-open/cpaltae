/* 위임자 주소 → 관할 국민연금공단 지사·가입지원부 팩스번호.
 * 원래 프로그램의 app/nps_directory.py lookup() 과 같은 규칙입니다(자료: assets/nps/directory.json).
 *  - 주소 첫 낱말에서 시도, 둘째(·셋째) 낱말에서 시군구를 읽음. 괄호 안 '(역삼동)' 같은 참고항목의 동 이름도 읽음
 *  - 읍면동이 빈칸인 관할 = 시군구 전체. 동마다 관할이 다른 지역은 주소에 동 이름이 있어야 정함
 *  - 팩스번호가 여러 개면 가입지원부 번호 중 첫 번째. 확인일이 180일보다 오래됐거나 못 찾으면 이유를 알려 줌(추측하지 않음)
 *  - 주소는 이 브라우저 안에서만 쓰고 어디로도 보내지 않음
 */
(function(){
  'use strict';
  var SIDO = {
    '서울':'서울특별시','서울시':'서울특별시','서울특별시':'서울특별시','부산':'부산광역시','부산시':'부산광역시','부산광역시':'부산광역시',
    '대구':'대구광역시','대구시':'대구광역시','대구광역시':'대구광역시','인천':'인천광역시','인천시':'인천광역시','인천광역시':'인천광역시',
    '광주':'전남광주통합특별시','광주광역시':'전남광주통합특별시','대전':'대전광역시','대전시':'대전광역시','대전광역시':'대전광역시',
    '울산':'울산광역시','울산시':'울산광역시','울산광역시':'울산광역시','세종':'세종특별자치시','세종시':'세종특별자치시','세종특별자치시':'세종특별자치시',
    '경기':'경기도','경기도':'경기도','강원':'강원특별자치도','강원도':'강원특별자치도','강원특별자치도':'강원특별자치도',
    '충북':'충청북도','충청북도':'충청북도','충남':'충청남도','충청남도':'충청남도',
    '전북':'전북특별자치도','전라북도':'전북특별자치도','전북특별자치도':'전북특별자치도',
    '전남':'전남광주통합특별시','전라남도':'전남광주통합특별시','전남광주통합특별시':'전남광주통합특별시',
    '경북':'경상북도','경상북도':'경상북도','경남':'경상남도','경상남도':'경상남도',
    '제주':'제주특별자치도','제주도':'제주특별자치도','제주특별자치도':'제주특별자치도'
  };
  var data = null, rows = null;

  async function load(base){
    if (data) return data;
    var v = (document.querySelector('meta[name="app-version"]') || {}).content || '';
    var r = await fetch((base || 'assets/') + 'nps/directory.json' + (v ? '?v=' + v : ''), { cache: 'no-cache' });
    if (!r.ok) throw new Error('관할지사 자료를 불러오지 못했어요.');
    data = await r.json();
    rows = [];
    data.branches.forEach(function(b, bi){ b.areas.forEach(function(a){ rows.push({ sido: a[0], sigungu: a[1], dong: a[2], verified: a[3], bi: bi, name: b.name }); }); });
    return data;
  }

  function addressParts(address){
    var words = (address || '').split(/[\s,()\[\]]+/).filter(Boolean);
    if (!words.length || !SIDO[words[0]]) return null;
    var sigungu = {};
    if (words.length > 1) {
      sigungu[words[1]] = true;
      if (words.length > 2 && /시$/.test(words[1]) && /구$/.test(words[2])) sigungu[words[1] + ' ' + words[2]] = true;   // 수원시 영통구
    }
    return { sido: SIDO[words[0]], sigungu: sigungu, words: words.slice(1) };
  }
  function dongIn(dong, words){   // '역삼동' 그대로, 또는 '역삼동123-4'처럼 지번만 붙은 경우
    return words.some(function(w){ return w === dong || (w.indexOf(dong) === 0 && /^[\d\-]+(번지)?$/.test(w.slice(dong.length))); });
  }
  function kstToday(){ return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
  function stale(d, today){ return (Date.parse(today) - Date.parse(d)) / 86400000 > data.stale_days; }
  function isCert(f){ return f.purpose === '가입증명' || f.department.trim() === '가입지원부'; }

  /** 결과: {status, message, branch, department, fax, verified_on, link, options[]} — status 는 원래 프로그램과 같음 */
  function lookup(address, today){
    today = today || kstToday();
    var page = data.official_page;
    var R = function(status, message, extra){ return Object.assign({ status: status, message: message, branch: '', department: '', fax: '', verified_on: '', link: page, options: [] }, extra || {}); };
    if (!rows.length) return R('no_data', '실패 원인: 관할구역 자료가 하나도 등록되지 않았습니다. 팩스번호를 확인해 직접 입력해 주세요.');
    var p = addressParts(address);
    if (!p) return R('no_address', "실패 원인: 주소 첫 낱말에서 시·도를 알 수 없습니다(예: '서울특별시 종로구 …'처럼 시·도부터 입력). 팩스번호를 직접 입력해 주세요.");
    var sg = Object.keys(p.sigungu);
    var area = (p.sido + ' ' + (sg.length ? sg.reduce(function(a, b){ return b.length > a.length ? b : a; }) : '')).trim();
    var matches = rows.filter(function(r){ return r.sido === p.sido && (!r.sigungu || p.sigungu[r.sigungu]) && (!r.dong || dongIn(r.dong, p.words)); });
    var splitHere = rows.filter(function(r){ return r.sido === p.sido && p.sigungu[r.sigungu] && r.dong; });
    if (!matches.length) {
      if (splitHere.length) return R('ambiguous', "실패 원인: '" + area + "'은(는) 읍·면·동에 따라 관할지사가 다른데, 주소에서 등록된 읍·면·동을 찾지 못했습니다(도로명 주소면 끝에 '(역삼동)'처럼 동 이름을 함께 입력). 관할지사를 확인해 팩스번호를 직접 입력해 주세요.");
      return R('not_found', "실패 원인: '" + area + "' 관할구역이 등록되어 있지 않습니다(관리자: 관할 자료에 그 지역 추가). 팩스번호를 직접 입력해 주세요.");
    }
    var score = function(r){ return [r.sigungu ? 1 : 0, r.sigungu ? r.sigungu.split(' ').length : 0, r.dong ? 1 : 0]; };
    var cmp = function(a, b){ for (var i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
    var best = matches.map(score).reduce(function(a, b){ return cmp(a, b) >= 0 ? a : b; });
    var topRows = matches.filter(function(r){ return cmp(score(r), best) === 0; });
    var ids = {}; topRows.forEach(function(r){ ids[r.bi] = r; });
    var keys = Object.keys(ids);
    if (keys.length !== 1) return R('ambiguous', "실패 원인: '" + area + "'이(가) 두 지사 이상의 관할로 등록되어 있어 정할 수 없습니다(" + keys.map(function(k){ return ids[k].name; }).sort().join(', ') + '). 팩스번호를 직접 입력해 주세요.');
    var hit = topRows[0], b = data.branches[hit.bi];
    if (!hit.dong && splitHere.some(function(r){ return r.sigungu === hit.sigungu; }))
      return R('ambiguous', "실패 원인: '" + area + "'은(는) 읍·면·동에 따라 관할지사가 다른데, 주소에서 읍·면·동을 확인하지 못했습니다(도로명 주소면 괄호 안 동 이름을 함께 입력). 팩스번호를 직접 입력해 주세요.");
    var faxes = b.faxes.map(function(f, i){ return Object.assign({ i: i }, f); });
    faxes.sort(function(x, y){ return (isCert(x) ? 0 : 1) - (isCert(y) ? 0 : 1) || (x.purpose === '가입증명' ? 0 : 1) - (y.purpose === '가입증명' ? 0 : 1) || x.i - y.i; });
    var info = { branch: b.name, link: b.link || page, options: faxes.map(function(f){ return { department: f.department, purpose: f.purpose, fax: f.fax, verified_on: f.verified_on }; }) };
    var cert = faxes.filter(isCert);
    if (stale(hit.verified, today)) return R('stale', '실패 원인: 관할구역 자료의 확인일(' + hit.verified + ')이 ' + data.stale_days + '일보다 오래되어 자동 입력하지 않았습니다. 최신 관할을 확인해 직접 입력해 주세요.', Object.assign({ verified_on: hit.verified }, info));
    if (cert.length) {
      var f = cert[0];
      if (stale(f.verified_on, today)) return R('stale', '실패 원인: ' + b.name + ' 가입지원부 팩스번호의 확인일(' + f.verified_on + ')이 ' + data.stale_days + '일보다 오래되어 자동 입력하지 않았습니다. 최신 번호를 확인해 직접 입력해 주세요.', Object.assign({ department: f.department, verified_on: f.verified_on }, info));
      var more = cert.length > 1 ? ' 다른 번호 ' + (cert.length - 1) + '개는 아래 목록에 있습니다.' : '';
      return R('found', '관할지사의 가입지원부 팩스번호를 자동으로 넣었습니다.' + more + ' 보내기 전에 확인해 주세요.', Object.assign({ department: f.department, fax: f.fax, verified_on: f.verified_on, source: f.source }, info));
    }
    return R('branch_only', "실패 원인: 관할지사 '" + b.name + "'은(는) 찾았지만 가입지원부 팩스번호가 등록되어 있지 않습니다" + (faxes.length ? '(대표 팩스만 있음 — 업무 미확인)' : '') + '. 공식 정보에서 확인해 고르거나 직접 입력해 주세요.', Object.assign({ verified_on: hit.verified }, info));
  }

  window.TaeNps = { load: load, lookup: lookup, comwel: function(){ return data && data.comwel; } };
})();

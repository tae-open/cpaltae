// 발급 기록 — 다운로드·팩스 기록을 기간·업무·방식·계정·검색어로 찾고, 달별로 묶어 보여 줌.
// 기록은 구글 시트에 모두 쌓이고(개수 제한 없음), 화면에는 50건씩 불러옴. 엑셀(CSV)로 받기는 조건에 맞는 최대 5,000건.
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var esc = TAEUI.esc, when = TAEUI.fmtDateTime;
  var PAGE = 50;
  var me = null, rows = [], next = null, lastQuery = null, wsFilled = false;

  function kst(d){ return new Date(d.getTime() + 9 * 3600 * 1000); }
  function ymd(d){ return d.toISOString().slice(0, 10); }
  function range(kind){
    var now = kst(new Date()), y = now.getUTCFullYear(), m = now.getUTCMonth();
    var first = function(yy, mm){ return ymd(new Date(Date.UTC(yy, mm, 1))); };
    var last = function(yy, mm){ return ymd(new Date(Date.UTC(yy, mm + 1, 0))); };
    if (kind === 'month') return [first(y, m), last(y, m)];
    if (kind === 'last-month') return [first(y, m - 1), last(y, m - 1)];
    if (kind === '3m') return [first(y, m - 2), last(y, m)];
    if (kind === 'year') return [y + '-01-01', y + '-12-31'];
    if (kind === 'custom') return [$('recFrom').value, $('recTo').value];
    return ['', ''];
  }
  function query(){
    var r = range($('recPeriod').value);
    return { from: r[0], to: r[1], workspace: $('recWs').value, method: $('recMethod').value,
             account: $('recAccount').value, q: $('recQ').value.trim() };
  }

  function methodCell(it){
    if (it.method !== '팩스') return '<span class="pill off">다운로드</span>';
    var st = it.faxStatus || '확인 중', cls = st === '성공' ? 'on' : st === '실패' ? 'bad' : st === '테스트 완료' ? 'test' : 'wait';
    return '<span class="pill ' + cls + '">팩스 · ' + esc(st) + '</span>' + (it.to ? '<span class="rec-to">' + esc(it.to) + '</span>' : '') +
      (it.faxResult && st !== '성공' ? '<span class="rec-to">' + esc(it.faxResult) + '</span>' : '');
  }
  function draw(){
    var body = $('recBody');
    if (!rows.length) { body.innerHTML = '<tr><td class="none" colspan="7">조건에 맞는 발급 기록이 없어요. 기간을 넓히거나 검색어를 바꿔 보세요.</td></tr>'; return; }
    var html = '', month = '', perMonth = {};
    rows.forEach(function(it){ var k = when(it.at).slice(0, 7); perMonth[k] = (perMonth[k] || 0) + 1; });
    var blank = '<span class="muted">—</span>';
    rows.forEach(function(it){
      var k = when(it.at).slice(0, 7);
      if (k !== month) {
        month = k;
        html += '<tr class="rec-month"><th colspan="7">' + k.slice(0, 4) + '년 ' + Number(k.slice(5)) + '월 <span>' + perMonth[k] + '건' + (next !== null && k === when(rows[rows.length - 1].at).slice(0, 7) ? ' 이상' : '') + '</span></th></tr>';
      }
      html += '<tr><td>' + esc(when(it.at).slice(5)) + '</td><td>' + esc(it.workspace) + '</td><td class="wrapcell" title="파일 지문 ' + esc(it.sha256) + '">' + esc(it.doc) +
        '</td><td>' + (it.delegator ? esc(it.delegator) : blank) + '</td><td>' + (it.delegatee ? esc(it.delegatee) : blank) +
        '</td><td class="wrapcell">' + methodCell(it) + '</td><td>' + esc(it.writer) + ' <span class="muted">' + esc(it.id) + '</span></td></tr>';
    });
    body.innerHTML = html;
  }
  function summary(r){
    var parts = Object.keys(r.byWorkspace || {}).map(function(k){ return k + ' ' + r.byWorkspace[k]; });
    $('recSummary').textContent = '총 ' + r.total + '건 · 다운로드 ' + r.counts.download + ' · 팩스 ' + r.counts.fax +
      (parts.length > 1 ? ' (' + parts.join(', ') + ')' : '') + (r.total > rows.length ? ' · ' + rows.length + '건 표시 중' : '');
  }
  async function load(more){
    var q = more ? lastQuery : query();
    if (q.from && q.to && q.from > q.to) { $('recSummary').textContent = '시작일이 종료일보다 늦어요. 기간을 확인해 주세요.'; return; }
    lastQuery = q;
    if (!more) { rows = []; $('recBody').innerHTML = '<tr><td class="none" colspan="7">불러오는 중…</td></tr>'; }
    $('recMore').disabled = true;
    try {
      var r = await TAEUI.api('records.search', Object.assign({ offset: more ? rows.length : 0, limit: PAGE }, q));
      rows = rows.concat(r.rows); next = r.nextOffset;
      if (r.accounts && $('recAccount').options.length === 1) {
        r.accounts.forEach(function(a){ var o = document.createElement('option'); o.value = a.id; o.textContent = a.name + ' (' + a.id + ')'; $('recAccount').appendChild(o); });
      }
      draw(); summary(r);
      $('recMore').hidden = next === null;
      $('recMore').textContent = '더 보기 (남은 ' + (r.total - rows.length) + '건)';
    } catch(err) {
      $('recBody').innerHTML = '<tr><td class="none" colspan="7">' + esc(err.message) + '</td></tr>';
    } finally { $('recMore').disabled = false; }
  }

  async function exportCsv(){
    var btn = $('recExport'); btn.disabled = true; btn.textContent = '만드는 중…';
    try {
      var r = await TAEUI.api('records.search', Object.assign({ export: true }, lastQuery || query()));
      var cell = function(v){ v = String(v == null ? '' : v); if (/^[=+\-@]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };
      var lines = [['발급 일시', '업무', '서류', '위임자', '수임자', '방식', '팩스 상태', '받는 곳', '발급 계정', '아이디', '파일 지문']]
        .concat(r.rows.map(function(it){ return [when(it.at), it.workspace, it.doc, it.delegator, it.delegatee, it.method, it.faxStatus || '', it.to, it.writer, it.id, it.sha256]; }));
      var csv = '﻿' + lines.map(function(l){ return l.map(cell).join(','); }).join('\r\n');
      var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      var a = document.createElement('a'); a.href = url; a.download = '발급기록_' + when(new Date().toISOString()).slice(0, 10).replace(/\./g, '') + '.csv';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
      $('recSummary').textContent = r.rows.length + '건을 엑셀(CSV) 파일로 받았어요' + (r.total > r.rows.length ? ' (최대 5,000건 — 기간을 나눠 받아 주세요)' : '') + '.';
    } catch(err) { $('recSummary').textContent = err.message; }
    finally { btn.disabled = false; btn.textContent = '엑셀(CSV)로 받기'; }
  }

  $('recPeriod').addEventListener('change', function(){ $('recDates').hidden = this.value !== 'custom'; if (this.value !== 'custom') load(false); });
  ['recWs', 'recMethod', 'recAccount'].forEach(function(id){ $(id).addEventListener('change', function(){ load(false); }); });
  $('recForm').addEventListener('submit', function(e){ e.preventDefault(); load(false); });
  $('recMore').addEventListener('click', function(){ load(true); });
  $('recExport').addEventListener('click', exportCsv);

  window.TaeRecords = {
    open: function(user){
      me = user;
      if (!wsFilled) {
        TaeWorkspaces.list.forEach(function(w){ var o = document.createElement('option'); o.value = w.nav || w.title; o.textContent = w.title; $('recWs').appendChild(o); });
        wsFilled = true;
      }
      $('recDesc').textContent = (user && user.role === '관리자' ? '모든 직원의' : '내 계정의') +
        ' PDF 다운로드와 팩스 보내기 기록이에요. 시트에 쌓인 모든 기록에서 찾아요(최근 것이 맨 위, 한국 시간). 주민등록번호는 기록하지 않아요.';
      load(false);
    }
  };
})();

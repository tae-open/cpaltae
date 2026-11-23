// 4대보험 청구: 1페이지(기본정보 입력) → 2페이지(기관별 미리보기·다운로드)
// 입력값·신분증·만든 PDF 는 이 페이지의 메모리에만 있고, 30분이 지나거나 로그아웃·새 서류 작성 때 지웁니다.
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var esc = TAEUI.esc;
  var TTL_MS = 30 * 60 * 1000;
  var ROLES = { delegator: '위임자 신분증', delegatee: '수임자 신분증' };
  var state = { images: {}, bornAt: 0, result: null, input: null, tab: 'nps', view: null };

  // ===== 입력 도우미 =====
  function today(){
    var d = new Date(Date.now() + 9 * 3600 * 1000);   // 한국 시간
    return d.toISOString().slice(0, 10);
  }
  $('issueDate').value = today();
  ['dgRrn','deRrn'].forEach(function(id){
    $(id).addEventListener('input', function(e){
      var d = e.target.value.replace(/\D/g,'').slice(0,13);
      e.target.value = d.length > 6 ? d.slice(0,6) + '-' + d.slice(6) : d;
    });
  });
  ['dgPhone','dePhone'].forEach(function(id){
    $(id).addEventListener('input', function(e){
      var d = e.target.value.replace(/\D/g,'').slice(0,11), out = d;
      if (d.length > 7) out = d.slice(0,3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
      else if (d.length > 3) out = d.slice(0,3) + '-' + d.slice(3);
      e.target.value = out;
    });
  });
  document.querySelectorAll('[data-toggle]').forEach(function(b){
    b.addEventListener('click', function(){
      var f = $(b.dataset.toggle), hidden = f.type === 'password';
      f.type = hidden ? 'text' : 'password'; b.textContent = hidden ? '숨기기' : '보기';
    });
  });
  $('issueForm').addEventListener('input', function(){ $('issueMsg').hidden = true; });
  function msg(id, text, good){ var el = $(id); el.textContent = text || ''; el.hidden = !text; el.className = 'status' + (good ? '' : ' bad'); }

  // ===== 신분증 올리기 =====
  function touch(){ if (!state.bornAt) state.bornAt = Date.now(); }
  function drawZone(role){
    var z = document.querySelector('.dropzone[data-role="' + role + '"]'), img = state.images[role];
    z.classList.toggle('has-image', !!img);
    z.innerHTML = img
      ? '<strong>' + ROLES[role] + '</strong><img class="dz-thumb" alt="' + ROLES[role] + ' 미리보기" src="' + img.url + '">' +
        '<div class="dz-actions"><button type="button" class="ghost" data-act="pick">교체</button><button type="button" class="ghost danger" data-act="del">삭제</button></div>'
      : '<strong>' + ROLES[role] + '</strong><span>이미지를 여기로 끌어다 놓거나</span>' +
        '<button type="button" class="ghost" data-act="pick">파일 선택</button><span class="muted">JPG·JPEG·PNG, 10MB 이하, 1장</span>';
    z.insertAdjacentHTML('beforeend', '<input type="file" accept=".jpg,.jpeg,.png,image/jpeg,image/png" hidden><p class="dz-status" aria-live="polite"></p>');
  }
  async function setImage(role, file){
    var z = document.querySelector('.dropzone[data-role="' + role + '"]');
    var st = z.querySelector('.dz-status'); st.textContent = '확인 중…'; st.classList.remove('bad');
    try {
      var img = await TaeForms.cleanImage(file);
      if (state.images[role]) URL.revokeObjectURL(state.images[role].url);
      state.images[role] = img; touch(); drawZone(role);
    } catch(e) { st.textContent = e.message; st.classList.add('bad'); }
  }
  document.querySelectorAll('.dropzone').forEach(function(z){
    var role = z.dataset.role;
    drawZone(role);
    z.addEventListener('click', function(e){
      var act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'del') {
        URL.revokeObjectURL(state.images[role].url); delete state.images[role]; drawZone(role); return;
      }
      if (act || e.target === z) z.querySelector('input[type=file]').click();
    });
    z.addEventListener('keydown', function(e){ if ((e.key === 'Enter' || e.key === ' ') && e.target === z) { e.preventDefault(); z.querySelector('input[type=file]').click(); } });
    z.addEventListener('change', function(e){ if (e.target.files && e.target.files[0]) setImage(role, e.target.files[0]); e.target.value = ''; });
    ['dragenter','dragover'].forEach(function(n){ z.addEventListener(n, function(e){ e.preventDefault(); z.classList.add('drag'); }); });
    ['dragleave','drop'].forEach(function(n){ z.addEventListener(n, function(e){ e.preventDefault(); z.classList.remove('drag'); }); });
    z.addEventListener('drop', function(e){ var f = e.dataTransfer.files[0]; if (f) setImage(role, f); });
  });

  // ===== 입력값 검사 (원래 프로그램의 clean_issue_form 과 같은 기준) =====
  function cleanForm(){
    var date = $('issueDate').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date))) throw new Error('발급 날짜를 확인해 주세요.');
    var people = {};
    [['dg','delegator','위임자'],['de','delegatee','수임자']].forEach(function(p){
      var name = $(p[0] + 'Name').value.trim();
      if (!name || name.length > 20) throw new Error(p[2] + ' 성명을 20자 이내로 입력해 주세요.');
      var rrn = $(p[0] + 'Rrn').value.replace(/[\s-]/g, '');
      if (rrn && !/^\d{13}$/.test(rrn)) throw new Error(p[2] + ' 주민등록번호는 숫자 13자리로 입력해 주세요.');
      var phone = $(p[0] + 'Phone').value.trim().slice(0, 20);
      if (phone && !/^[\d\- ]+$/.test(phone)) throw new Error(p[2] + " 휴대폰 번호는 숫자와 '-' 로 입력해 주세요.");
      people[p[1]] = { name: name, rrn: rrn ? rrn.slice(0,6) + '-' + rrn.slice(6) : '', phone: phone };
    });
    var address = $('dgAddr').value.trim();
    if (address.length > 120) throw new Error('위임자 주소를 120자 이내로 입력해 주세요.');
    people.delegator.address = address;
    return { date: date, delegator: people.delegator, delegatee: people.delegatee };
  }

  // ===== 다음: 서류 만들기 =====
  $('issueForm').addEventListener('submit', async function(e){
    e.preventDefault(); msg('issueMsg', '');
    var input;
    try { input = cleanForm(); } catch(err) { msg('issueMsg', err.message); window.scrollTo(0, 0); return; }
    var btn = $('nextBtn'); btn.disabled = true; btn.textContent = '서류 만드는 중… (10초 정도 걸려요)';
    try {
      var result = await TaeForms.buildAll({ date: input.date, delegator: input.delegator, delegatee: input.delegatee, images: state.images });
      touch();
      state.result = result; state.input = input; state.tab = 'nps'; state.view = null;
      showCase();
    } catch(err) {
      msg('issueMsg', err.name === 'GenerationError' ? err.message : '서류를 만들지 못했어요. 페이지를 새로 고친 뒤 다시 시도해 주세요. (' + err.message + ')');
      window.scrollTo(0, 0);
    } finally { btn.disabled = false; btn.textContent = '다음'; }
  });

  // ===== 2페이지 =====
  var specs = function(){ return TaeForms._specs(); };
  function showCase(){
    $('issueForm').hidden = true; $('caseView').hidden = false; msg('caseMsg', '');
    drawCase(); window.scrollTo(0, 0);
  }
  function showIssue(){ $('caseView').hidden = true; $('issueForm').hidden = false; window.scrollTo(0, 0); }
  $('editCase').addEventListener('click', showIssue);

  var newArmed = false;
  $('newCase').addEventListener('click', function(){
    if (!newArmed) { newArmed = true; this.textContent = '한 번 더 누르면 모두 지워요'; var b = this;
      setTimeout(function(){ newArmed = false; b.textContent = '새 서류 작성'; }, 3000); return; }
    newArmed = false; this.textContent = '새 서류 작성';
    clearAll(); showIssue();
  });

  function drawCase(){
    var sp = specs(), tabs = sp.tabs, tab = tabs[state.tab];
    if (!state.view || tab.bundles.indexOf(state.view) < 0) state.view = tab.preview;
    $('agencyTabs').innerHTML = Object.keys(tabs).map(function(k){
      return '<button type="button" data-agency="' + k + '" aria-pressed="' + (k === state.tab) + '">' + esc(tabs[k].label) + '</button>';
    }).join('');
    $('viewSwitch').innerHTML = tab.bundles.length > 1 ? '<span>미리보기</span>' + tab.bundles.map(function(b){
      return '<button type="button" data-view-bundle="' + b + '" aria-pressed="' + (b === state.view) + '">' + esc(sp.bundles[b].name.replace(' 발급 신청서 및 위임장','').replace('세무서 제출서류 일괄(소득금액증명원·일용근로소득증명원)','일괄')) + '</button>';
    }).join('') : '';
    var bundle = sp.bundles[state.view], res = state.result;
    var docs = bundle.forms.map(function(k){
      var f = sp.forms[k], r = res.forms[k];
      var dg = r.seals.filter(function(s){ return s.signer === 'client'; }).length, de = r.seals.length - dg;
      return '<li><b>' + esc(f.num) + '. ' + esc(f.title) + '</b><span>' + r.pages + '쪽 · 위임자 도장 ' + dg + '개' + (de ? ' · 수임자 도장 ' + de + '개' : '') + '</span></li>';
    }).join('');
    var imgs = bundle.images.map(function(role){
      var ok = !!state.images[role];
      return '<li class="' + (ok ? 'ok' : 'miss') + '"><b>' + esc(sp.images[role]) + '</b><span>' + (ok ? '첨부됨' : '없음 — 이 서류는 내려받을 수 없어요') + '</span></li>';
    }).join('');
    var buttons = tab.bundles.map(function(b){
      var miss = res.bundles[b].missing;
      return '<button type="button" class="btn sm dl" data-download="' + b + '"' + (miss.length ? ' disabled' : '') + '>' + esc(sp.bundles[b].label) + '</button>' +
        (miss.length ? '<p class="miss-note">' + esc(miss.join(', ')) + '이(가) 없어 내려받을 수 없어요. 정보수정에서 올려 주세요.</p>' : '');
    }).join('');
    var fax = tab.fax_label ? '<button type="button" class="btn sm ghost-btn" disabled title="팩스 연동은 하나팩스 규격을 받은 뒤 연결해요">' + esc(tab.fax_label) + ' (준비 중)</button>' : '';
    $('caseSide').innerHTML =
      (tab.submit ? '<p class="submit-to">제출처 <b>' + esc(tab.submit) + '</b></p>' : '') +
      '<h3>들어가는 서류</h3><ul class="doc-list">' + docs + '</ul>' +
      '<h3>신분증</h3><ul class="doc-list">' + imgs + '</ul>' +
      '<div class="dl-buttons">' + buttons + fax + '</div>';
    drawPreview(res.bundles[state.view]);
  }
  $('agencyTabs').addEventListener('click', function(e){ var b = e.target.closest('[data-agency]'); if (b) { state.tab = b.dataset.agency; state.view = null; drawCase(); } });
  $('viewSwitch').addEventListener('click', function(e){ var b = e.target.closest('[data-view-bundle]'); if (b) { state.view = b.dataset.viewBundle; drawCase(); } });

  var previewToken = 0;
  async function drawPreview(bundle){
    var token = ++previewToken, box = $('previewPages');
    box.innerHTML = '<p class="muted">미리보기를 그리는 중…</p>';
    var pdf = await pdfjsLib.getDocument({ data: bundle.bytes.slice(0), isEvalSupported: false }).promise;
    if (token !== previewToken) { pdf.destroy(); return; }
    box.innerHTML = '';
    var width = Math.min(box.clientWidth || 600, 820), dpr = Math.min(2, window.devicePixelRatio || 1);
    for (var i = 1; i <= pdf.numPages; i++){
      var page = await pdf.getPage(i), base = page.getViewport({ scale: 1 }), scale = width / base.width;
      var vp = page.getViewport({ scale: scale * dpr });
      var fig = document.createElement('figure'), cv = document.createElement('canvas');
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height); cv.style.width = Math.floor(base.width * scale) + 'px';
      fig.appendChild(cv);
      var cap = document.createElement('figcaption'); cap.textContent = i + ' / ' + pdf.numPages + ' · ' + bundle.captions[i - 1]; fig.appendChild(cap);
      if (token !== previewToken) { pdf.destroy(); return; }
      box.appendChild(fig);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    }
    pdf.destroy();
  }

  // ===== 내려받기 + 발급 기록 =====
  $('caseSide').addEventListener('click', async function(e){
    var b = e.target.closest('[data-download]'); if (!b || b.disabled) return;
    var key = b.dataset.download, bundle = state.result.bundles[key], sp = specs();
    if (bundle.missing.length) return;
    var name = sp.bundles[key].name + '_' + state.input.date.replace(/-/g, '') + '.pdf';
    var url = URL.createObjectURL(new Blob([bundle.bytes], { type: 'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
    try {
      await TAEUI.api('logCreate', { bundleKey: key, sha256: await TaeForms.sha256Hex(bundle.bytes) });
      msg('caseMsg', '내려받았어요: ' + name, true);
    } catch(err) { msg('caseMsg', 'PDF는 내려받았지만 발급 기록을 남기지 못했어요. ' + err.message); }
  });

  // ===== 30분 보관 · 지우기 =====
  function clearAll(){
    Object.keys(state.images).forEach(function(r){ URL.revokeObjectURL(state.images[r].url); });
    state = { images: {}, bornAt: 0, result: null, input: null, tab: 'nps', view: null };
    $('issueForm').reset(); $('issueDate').value = today();
    document.querySelectorAll('.dropzone').forEach(function(z){ drawZone(z.dataset.role); });
    $('previewPages').innerHTML = ''; $('caseSide').innerHTML = '';
    ['dgRrn','deRrn'].forEach(function(id){ $(id).type = 'password'; });
    document.querySelectorAll('[data-toggle]').forEach(function(b){ b.textContent = '보기'; });
  }
  TAEUI.clearIssue = function(){ clearAll(); showIssue(); msg('issueMsg', ''); };
  setInterval(function(){
    if (!state.bornAt) { $('expireNote').textContent = ''; return; }
    var left = state.bornAt + TTL_MS - Date.now();
    if (left <= 0) {
      clearAll(); showIssue();
      msg('issueMsg', '30분이 지나 입력한 정보와 신분증을 지웠어요. 다시 입력해 주세요.');
      return;
    }
    var m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    $('expireNote').textContent = '입력한 정보와 신분증은 ' + m + '분 ' + String(s).padStart(2, '0') + '초 뒤 자동으로 지워져요.';
  }, 1000);

  // 서식 자료는 미리 받아 둠(첫 '다음'이 빨라지도록)
  TaeForms.loadAssets().catch(function(){});
})();

// 4대보험 청구: 1페이지(기본정보 입력) → 2페이지(기관별 미리보기·다운로드)
// 입력값·신분증·만든 PDF 는 이 페이지의 메모리에만 있고, 30분이 지나거나 로그아웃·새 서류 작성 때 지웁니다.
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var esc = TAEUI.esc;
  var TTL_MS = 30 * 60 * 1000;
  var ROLES = { delegator: '위임자 신분증', delegatee: '수임자 신분증' };
  var state = { images: {}, bornAt: 0, result: null, input: null, tab: 'nps', view: null, logged: {}, nps: null };

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
    } catch(e) { st.textContent = e.message; st.classList.add('bad'); return; }
    readId(role, img);
  }

  // ===== 신분증 글자 읽어 칸 채우기 (브라우저 안에서만, assets/ocr.js) =====
  var OCR_FIELDS = {
    delegator: [['name','dgName','성명'], ['rrn','dgRrn','주민등록번호'], ['address','dgAddr','주소']],
    delegatee: [['name','deName','성명'], ['rrn','deRrn','주민등록번호']]
  };
  function fillAuto(id, value){
    var el = $(id);
    if (!value) return 'none';
    if (el.value.trim() && el.dataset.auto !== el.value) return 'kept';   // 직접 입력한 값은 덮어쓰지 않음
    el.value = value; el.dataset.auto = value; el.classList.add('auto');
    return 'filled';
  }
  async function readId(role, img){
    if (!window.TaeOCR) return;
    var status = function(text, bad){
      var z = document.querySelector('.dropzone[data-role="' + role + '"] .dz-status');
      if (z && state.images[role] === img) { z.textContent = text; z.classList.toggle('bad', !!bad); }
    };
    status('신분증 글자를 읽는 중…');
    try {
      var r = await TaeOCR.readId(img.source, function(t){ status(t); });
      if (state.images[role] !== img) return;   // 그사이 다른 사진으로 바뀜
      var filled = [], missed = [], kept = [];
      OCR_FIELDS[role].forEach(function(f){
        var res = fillAuto(f[1], r[f[0]]);
        (res === 'filled' ? filled : res === 'kept' ? kept : missed).push(f[2]);
      });
      if (role === 'delegator') checkNps();
      var msgs = [];
      if (filled.length) msgs.push('신분증에서 읽어 채웠어요: ' + filled.join(', ') + '. 틀린 글자가 없는지 꼭 확인해 주세요.');
      if (kept.length) msgs.push('이미 입력한 값은 그대로 두었어요: ' + kept.join(', ') + '.');
      if (missed.length) msgs.push('읽지 못한 칸: ' + missed.join(', ') + ' — 직접 입력해 주세요.');
      status(msgs.join(' '), !filled.length);
    } catch(e) {
      status('신분증 글자를 읽지 못했어요. 직접 입력해 주세요. (' + e.message + ')', true);
    }
  }
  // ===== 위임자 주소 → 관할 국민연금공단 지사·팩스 (assets/nps.js, 이 브라우저 안에서만) =====
  var npsTimer = null;
  function npsText(r){
    if (r.status === 'found') return '관할 국민연금공단: ' + r.branch + ' · ' + r.department + ' 팩스 ' + r.fax + ' (확인 ' + r.verified_on + ')';
    if (r.status === 'branch_only') return '관할 국민연금공단: ' + r.branch + ' — 가입지원부 팩스번호가 등록되어 있지 않아요.';
    return r.message;
  }
  async function checkNps(){
    var el = $('npsHint'), addr = $('dgAddr').value.trim();
    if (!addr) { el.textContent = ''; el.className = 'nps-hint'; return null; }
    try {
      await TaeNps.load();
      var r = TaeNps.lookup(addr);
      el.textContent = npsText(r);
      el.className = 'nps-hint ' + (r.status === 'found' ? 'ok' : r.status === 'branch_only' ? 'warn' : 'bad');
      return r;
    } catch(e) { el.textContent = e.message; el.className = 'nps-hint bad'; return null; }
  }
  $('dgAddr').addEventListener('input', function(){ clearTimeout(npsTimer); npsTimer = setTimeout(checkNps, 300); });
  ['dgName','dgRrn','dgAddr','deName','deRrn'].forEach(function(id){
    $(id).addEventListener('input', function(){ if (this.value !== this.dataset.auto) this.classList.remove('auto'); });
  });
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
      state.nps = input.delegator.address ? await checkNps() : null;
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
  TAEUI.issueHome = showIssue;
  TAEUI.issueHasData = function(){   // 메인 화면의 '작성 중인 서류 있음' 표시용
    return !!(state.result || Object.keys(state.images).length || $('dgName').value.trim() || $('deName').value.trim());
  };   // 위쪽 '4대보험 청구' 탭을 누르면 입력 화면으로
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
    var faxTo = '', target = faxTarget();
    if (state.tab === 'nps') {
      var n = state.nps;
      faxTo = !n ? '<p class="fax-to bad">위임자 주소가 없어 관할지사를 찾지 못했어요. 정보수정에서 주소를 입력해 주세요.</p>'
        : n.status === 'found' ? '<p class="fax-to ok">팩스 받는 곳 <b>' + esc(n.branch) + ' ' + esc(n.department) + '</b><br>' + esc(n.fax) + ' <span class="muted">(확인 ' + esc(n.verified_on) + ')</span></p>'
        : '<p class="fax-to bad">' + esc(n.message) + ' <a href="' + esc(n.link) + '" target="_blank" rel="noopener">공단 지사찾기</a></p>';
    } else if (state.tab === 'comwel' && TaeNps.comwel()) {
      var c = TaeNps.comwel();
      faxTo = '<p class="fax-to ok">팩스 받는 곳 <b>' + esc(c.name) + '</b><br>' + esc(c.fax) + '</p>';
    }
    var fax = '';
    if (tab.fax_label) {
      var fmiss = res.bundles[tab.fax].missing, why = fmiss.length ? fmiss.join(', ') + '이(가) 없어 보낼 수 없어요.' : !target ? '확인된 팩스번호가 없어 보낼 수 없어요.' : '';
      fax = '<button type="button" class="btn sm fax-btn" data-fax="' + tab.fax + '"' + (why ? ' disabled' : '') + '>' + esc(tab.fax_label) + '</button>' +
        (why ? '<p class="miss-note">' + esc(why) + '</p>' : '') + '<div id="faxBox"></div>';
    }
    $('caseSide').innerHTML =
      (tab.submit ? '<p class="submit-to">제출처 <b>' + esc(tab.submit) + (state.tab === 'nps' && state.nps && state.nps.branch ? ' (' + esc(state.nps.branch) + ')' : '') + '</b></p>' : '') + faxTo +
      '<h3>들어가는 서류</h3><ul class="doc-list">' + docs + '</ul>' +
      '<h3>신분증</h3><ul class="doc-list">' + imgs + '</ul>' +
      '<div class="dl-buttons">' + buttons + fax + '</div>';
    drawPreview(res.bundles[state.view]);
  }
  // ===== 팩스 보내기: 버튼 → 확인 화면 → 최종 확인 → 전송 → 진행 상태 =====
  function faxTarget(){   // 공식 확인된 번호만(직접 입력 없음)
    if (state.tab === 'nps' && state.nps && state.nps.status === 'found') return { name: state.nps.branch + ' ' + state.nps.department, number: state.nps.fax };
    if (state.tab === 'comwel' && TaeNps.comwel()) return { name: TaeNps.comwel().name, number: TaeNps.comwel().fax };
    return null;
  }
  var faxInfo = null;
  async function getFaxInfo(){
    try { faxInfo = await TAEUI.api('fax.info'); } catch(e) { faxInfo = { mode: 'unknown', error: e.message }; }
    return faxInfo;
  }
  function b64(bytes){
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function openFaxConfirm(key){
    var sp = specs(), bundle = state.result.bundles[key], t = faxTarget(), box = $('faxBox');
    if (!t || bundle.missing.length) return;
    box.innerHTML = '<div class="fax-confirm"><p class="muted">팩스 서버 상태를 확인하는 중…</p></div>';
    var info = await getFaxInfo();
    var mode = info.mode === 'relay' ? (info.relayAlive ? '<p class="fax-mode live">실제로 팩스를 보냅니다(하나팩스).</p>'
        : '<p class="fax-mode warn">실제 전송 모드지만 팩스 중계 서버가 3분 넘게 응답하지 않아요. 보내면 대기열에 남았다가 서버가 다시 연결되면 전송돼요.</p>')
      : info.mode === 'test' ? '<p class="fax-mode test">테스트 모드 — 절차만 진행하고 실제 팩스는 보내지 않아요.</p>'
      : '<p class="fax-mode warn">' + esc(info.error || '팩스 서버 상태를 확인하지 못했어요.') + '</p>';
    box.innerHTML = '<div class="fax-confirm" role="dialog" aria-label="팩스 전송 확인"><h3>팩스 전송 확인</h3>' + mode +
      '<dl><dt>받는 곳</dt><dd>' + esc(t.name) + '</dd><dt>팩스번호</dt><dd><b>' + esc(t.number) + '</b></dd>' +
      '<dt>서류</dt><dd>' + esc(sp.bundles[key].name) + '</dd><dt>쪽수</dt><dd>' + bundle.captions.length + '쪽 (' + esc(bundle.captions.join(', ')) + ')</dd></dl>' +
      '<p class="muted">받는 곳과 번호, 서류가 맞는지 확인한 뒤 보내 주세요. 같은 서류를 같은 번호로 두 번 보낼 수 없어요.</p>' +
      '<div class="fax-actions"><button type="button" class="btn sm" data-fax-send="' + key + '">최종 확인 · 전송</button> <button type="button" class="ghost" data-fax-cancel>취소</button></div></div>';
  }
  async function sendFax(key, btn){
    var sp = specs(), bundle = state.result.bundles[key], t = faxTarget();
    btn.disabled = true; btn.textContent = '보내는 중…';
    try {
      var sha = await TaeForms.sha256Hex(bundle.bytes);
      var r = await TAEUI.api('fax.send', { workspace: 'insurance', bundleKey: key, recipientName: t.name, number: t.number,
        pages: bundle.captions.length, sha256: sha, pdfBase64: b64(bundle.bytes),
        delegatorName: state.input.delegator.name, delegateeName: state.input.delegatee.name });
      state.faxJobs = state.faxJobs || {}; state.faxJobs[key] = r.job;
      showFaxJob(key, { job: r.job, status: r.status, to: t.name, number: t.number, pages: bundle.captions.length, result: r.mode === 'test' ? '테스트 모드 — 실제 팩스는 보내지 않았어요' : '' });
      if (r.status !== '테스트 완료') pollFax(key, r.job, 0);
    } catch(err) {
      $('faxBox').innerHTML = '<div class="fax-confirm bad"><p>' + esc(err.message) + '</p></div>';
    }
  }
  function showFaxJob(key, j){
    var done = ['성공', '실패', '테스트 완료'].indexOf(j.status) >= 0;
    var box = $('faxBox'); if (!box) return;
    box.innerHTML = '<div class="fax-confirm ' + (j.status === '실패' ? 'bad' : j.status === '성공' ? 'ok' : '') + '"><h3>팩스 ' + esc(j.status) + '</h3>' +
      '<p>' + esc(j.to || '') + ' ' + esc(j.number || '') + ' · ' + (j.pages || '') + '쪽</p>' + (j.result ? '<p class="muted">' + esc(j.result) + '</p>' : '') +
      (done ? '' : '<p class="muted">진행 상황을 자동으로 확인하고 있어요. 이 화면을 벗어나도 전송은 계속되고, 결과는 발급 기록에서 볼 수 있어요.</p>') + '</div>';
  }
  async function pollFax(key, job, n){
    if (n > 120 || !state.result || !state.faxJobs || state.faxJobs[key] !== job) return;   // 최대 약 10분
    await new Promise(function(r){ setTimeout(r, 5000); });
    try {
      var r = await TAEUI.api('fax.status', { jobs: [job] }), j = r.jobs[0];
      if (j && state.tab && specs().tabs[state.tab].fax === key) showFaxJob(key, j);
      if (j && ['성공', '실패', '테스트 완료'].indexOf(j.status) >= 0) return;
    } catch(e) {}
    pollFax(key, job, n + 1);
  }
  $('caseSide').addEventListener('click', function(e){
    var f = e.target.closest('[data-fax]'); if (f && !f.disabled) { openFaxConfirm(f.dataset.fax); return; }
    var s = e.target.closest('[data-fax-send]'); if (s && !s.disabled) { sendFax(s.dataset.faxSend, s); return; }
    if (e.target.closest('[data-fax-cancel]')) $('faxBox').innerHTML = '';
  });

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
      var sha = await TaeForms.sha256Hex(bundle.bytes), once = key + ':' + sha;
      if (state.logged[once]) { msg('caseMsg', '다시 내려받았어요: ' + name + ' (같은 파일이라 발급 기록은 한 번만 남겨요)', true); return; }
      // 기록에는 위임자·수임자 이름만 보냄(주민등록번호·주소·전화번호는 보내지 않음)
      var r = await TAEUI.api('logCreate', { bundleKey: key, sha256: sha,
        delegatorName: state.input.delegator.name, delegateeName: state.input.delegatee.name });
      state.logged[once] = true;
      msg('caseMsg', r.duplicate ? '다시 내려받았어요: ' + name + ' (방금 기록된 같은 파일이라 다시 기록하지 않았어요)' : '내려받고 발급 기록에 남겼어요: ' + name, true);
    } catch(err) { msg('caseMsg', 'PDF는 내려받았지만 발급 기록을 남기지 못했어요. ' + err.message); }
  });

  // ===== 30분 보관 · 지우기 =====
  function clearAll(){
    Object.keys(state.images).forEach(function(r){ URL.revokeObjectURL(state.images[r].url); });
    state = { images: {}, bornAt: 0, result: null, input: null, tab: 'nps', view: null, logged: {}, nps: null };
    $('npsHint').textContent = ''; $('npsHint').className = 'nps-hint';
    $('issueForm').reset(); $('issueDate').value = today();
    document.querySelectorAll('.dropzone').forEach(function(z){ drawZone(z.dataset.role); });
    $('previewPages').innerHTML = ''; $('caseSide').innerHTML = '';
    ['dgName','dgRrn','dgAddr','deName','deRrn'].forEach(function(id){ $(id).classList.remove('auto'); delete $(id).dataset.auto; });
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

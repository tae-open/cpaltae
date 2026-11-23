// 로그인, 화면 전환, 이력, 계정 관리
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var api = TAEUI.api, esc = TAEUI.esc, when = TAEUI.fmtDateTime;
  var me = null, current = 'write';

  var office = (window.TAEUI_CONFIG && TAEUI_CONFIG.OFFICE_NAME) || '노무법인 태(泰)';
  document.querySelectorAll('[data-office]').forEach(function(n){ n.textContent = office; });
  document.querySelectorAll('[data-office-alt]').forEach(function(n){ n.alt = office; });

  function show(view){
    ['viewLogin','viewPw','viewApp'].forEach(function(id){ $(id).hidden = id !== view; });
  }
  function msg(id, text, good){
    var el = $(id); el.textContent = text || ''; el.hidden = !text;
    el.className = 'status' + (good ? '' : ' bad');
  }
  function busy(btn, on, label){
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || '처리 중…'; }
    else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }

  TAEUI.onAuthLost = function(text){
    me = null; if (TAEUI.clearIssue) TAEUI.clearIssue(); show('viewLogin'); msg('loginMsg', text || '다시 로그인해 주세요.');
  };

  // ===== 로그인 =====
  $('loginForm').addEventListener('submit', async function(e){
    e.preventDefault(); msg('loginMsg', '');
    var id = $('loginId').value.trim(), pw = $('loginPw').value;
    if (!id || !pw) { msg('loginMsg', '아이디와 비밀번호를 입력해 주세요.'); return; }
    busy($('loginBtn'), true, '확인 중…');
    try {
      var r = await api('login', { id: id, password: pw });
      TAEUI.setSession({ token: r.token });
      $('loginPw').value = '';
      enter(r.user);
    } catch(err) { msg('loginMsg', err.message); }
    finally { busy($('loginBtn'), false); }
  });

  function enter(user){
    me = user;
    if (user.mustChange) { openPw(true); return; }
    $('whoName').textContent = user.name;
    $('whoRole').textContent = user.role;
    $('chgPw').hidden = user.role !== '관리자';   // 직원(공용) 계정은 관리자만 비밀번호를 바꿈
    document.querySelectorAll('.admin-only').forEach(function(n){ n.hidden = user.role !== '관리자'; });
    show('viewApp');
    go(current === 'users' || current === 'alllogs' ? (user.role === '관리자' ? current : 'write') : current);
  }

  // ===== 비밀번호 변경 =====
  var forced = false;
  function openPw(isForced){
    forced = isForced;
    $('pwTitle').textContent = isForced ? '새 비밀번호 정하기' : '비밀번호 변경';
    $('pwLead').textContent = isForced ? '임시 비밀번호로 로그인했어요. 계속하려면 본인만 아는 비밀번호로 바꿔 주세요.' : '현재 비밀번호를 확인한 뒤 새 비밀번호로 바꿔요.';
    $('pwCancel').textContent = isForced ? '로그아웃' : '취소';
    ['pwCur','pwNew','pwNew2'].forEach(function(id){ $(id).value = ''; });
    msg('pwMsg', ''); show('viewPw'); $('pwCur').focus();
  }
  $('chgPw').addEventListener('click', function(){ openPw(false); });
  $('pwCancel').addEventListener('click', function(){ forced ? logout() : show('viewApp'); });
  $('pwForm').addEventListener('submit', async function(e){
    e.preventDefault(); msg('pwMsg', '');
    var cur = $('pwCur').value, n1 = $('pwNew').value, n2 = $('pwNew2').value;
    if (!cur || !n1) { msg('pwMsg', '현재 비밀번호와 새 비밀번호를 입력해 주세요.'); return; }
    if (n1 !== n2) { msg('pwMsg', '새 비밀번호 확인이 일치하지 않아요.'); return; }
    if (n1.length < 8 || !/[A-Za-z]/.test(n1) || !/[0-9]/.test(n1)) { msg('pwMsg', '새 비밀번호는 영문과 숫자를 섞어 8자 이상이어야 해요.'); return; }
    busy($('pwBtn'), true, '바꾸는 중…');
    try {
      var r = await api('changePassword', { current: cur, next: n1 });
      if (r.token) TAEUI.setSession({ token: r.token });
      enter(r.user);
    } catch(err) { msg('pwMsg', err.message); }
    finally { busy($('pwBtn'), false); }
  });

  // ===== 로그아웃 =====
  async function logout(){
    try { await api('logout'); } catch(e){}
    TAEUI.setSession(null); me = null;
    if (TAEUI.clearIssue) TAEUI.clearIssue();
    $('loginId').value = ''; msg('loginMsg', '');
    show('viewLogin');
  }
  $('logout').addEventListener('click', logout);

  // ===== 탭 =====
  function go(tab){
    current = tab;
    document.querySelectorAll('.tab').forEach(function(t){ t.setAttribute('aria-selected', String(t.dataset.tab === tab)); });
    document.querySelectorAll('[data-view]').forEach(function(v){ v.hidden = v.dataset.view !== tab; });
        if (tab === 'mylogs') loadLogs('mylogs');
    if (tab === 'alllogs') loadLogs('alllogs');
    if (tab === 'users') loadUsers();
  }
  document.querySelectorAll('.tab').forEach(function(t){ t.addEventListener('click', function(){
    go(t.dataset.tab);
    if (t.dataset.tab === 'write' && TAEUI.issueHome) TAEUI.issueHome();   // 누르면 항상 위임자·수임자 입력 화면
  }); });
  document.querySelectorAll('[data-reload]').forEach(function(b){ b.addEventListener('click', function(){ go(b.dataset.reload); }); });

  function rowMsg(body, cols, text){ $(body).innerHTML = '<tr><td class="none" colspan="' + cols + '">' + esc(text) + '</td></tr>'; }

  // ===== 이력 =====
  async function loadLogs(kind){
    var body = kind + 'Body', cols = kind === 'mylogs' ? 3 : 4;
    rowMsg(body, cols, '불러오는 중…');
    try {
      var r = await api(kind === 'mylogs' ? 'myLogs' : 'admin.listLogs');
      if (!r.logs.length) { rowMsg(body, cols, '아직 발급 기록이 없어요. 4대보험 청구에서 PDF를 내려받으면 여기에 기록돼요.'); return; }
      $(body).innerHTML = r.logs.map(function(l){
        var fp = '<span class="muted" title="' + esc(l.sha256) + '">' + esc((l.sha256 || '').slice(0, 12)) + '</span>';
        return kind === 'mylogs'
          ? '<tr><td>' + esc(when(l.at)) + '</td><td class="wrapcell">' + esc(l.doc) + '</td><td>' + fp + '</td></tr>'
          : '<tr><td>' + esc(when(l.at)) + '</td><td>' + esc(l.writer) + ' <span class="muted">' + esc(l.id) + '</span></td><td class="wrapcell">' + esc(l.doc) + '</td><td>' + fp + '</td></tr>';
      }).join('');
    } catch(err) { rowMsg(body, cols, err.message); }
  }

  // ===== 계정 관리 =====
  var users = [];
  async function loadUsers(){
    rowMsg('usersBody', 6, '불러오는 중…');
    try { users = (await api('admin.listUsers')).users; drawUsers(); }
    catch(err) { rowMsg('usersBody', 6, err.message); }
  }
  function drawUsers(){
    if (!users.length) { rowMsg('usersBody', 6, '계정이 없어요.'); return; }
    $('usersBody').innerHTML = users.map(function(u){
      var self = me && u.id === me.id;
      return '<tr data-id="' + esc(u.id) + '">' +
        '<td>' + esc(u.id) + '</td><td>' + esc(u.name) + (self ? ' <span class="muted">(나)</span>' : '') + '</td>' +
        '<td><span class="pill ' + (u.role === '관리자' ? 'admin' : 'off') + '">' + esc(u.role) + '</span></td>' +
        '<td><span class="pill ' + (u.status === '사용' ? 'on' : 'off') + '">' + esc(u.status) + '</span>' + (u.mustChange ? ' <span class="muted">임시 비밀번호</span>' : '') + '</td>' +
        '<td>' + (u.lastLogin ? esc(when(u.lastLogin)) : '<span class="muted">없음</span>') + '</td>' +
        '<td><div class="acts">' +
          '<button class="ghost" type="button" data-act="setpw">비밀번호 지정</button>' +
          (self ? '' : '<button class="ghost" type="button" data-act="role">' + (u.role === '관리자' ? '직원으로' : '관리자로') + '</button>') +
          (self ? '' : '<button class="ghost' + (u.status === '사용' ? ' danger' : '') + '" type="button" data-act="status">' + (u.status === '사용' ? '사용 중지' : '다시 사용') + '</button>') +
        '</div></td></tr>';
    }).join('');
  }
  function showTemp(name, id, temp){
    var b = $('tempBox');
    b.innerHTML = '<strong>' + esc(name) + ' (' + esc(id) + ')</strong> 님의 임시 비밀번호: <code>' + esc(temp) + '</code> ' +
      '<button class="ghost" type="button" id="copyTemp">복사</button>' +
      '<div class="muted" style="margin-top:6px;font-size:12px">이 화면을 벗어나면 다시 볼 수 없어요. 직원에게 전달하면 첫 로그인 때 새 비밀번호로 바꾸게 됩니다.</div>';
    b.hidden = false;
    $('copyTemp').addEventListener('click', function(){
      var btn = this;
      (navigator.clipboard ? navigator.clipboard.writeText(temp) : Promise.reject()).then(function(){ btn.textContent = '복사했어요'; }, function(){ btn.textContent = '직접 선택해 복사하세요'; });
    });
  }
  // 버튼은 두 번 눌러 확인 (실수 방지)
  var pending = null;
  $('usersBody').addEventListener('click', async function(e){
    var btn = e.target.closest('button[data-act]'); if (!btn) return;
    var id = btn.closest('tr').dataset.id, act = btn.dataset.act;
    var u = users.filter(function(x){ return x.id === id; })[0]; if (!u) return;
    if (act === 'setpw') { openSetPw(u); return; }
    var key = id + ':' + act;
    if (pending !== key) {
      pending = key;
      btn.dataset.orig = btn.textContent; btn.textContent = '한 번 더 누르면 실행';
      setTimeout(function(){ if (pending === key) { pending = null; if (btn.isConnected) btn.textContent = btn.dataset.orig; } }, 3000);
      return;
    }
    pending = null; msg('usersMsg', ''); $('tempBox').hidden = true;
    busy(btn, true);
    try {
      if (act === 'role') {
        await api('admin.updateUser', { id: id, role: u.role === '관리자' ? '직원' : '관리자' });
      } else if (act === 'status') {
        await api('admin.updateUser', { id: id, status: u.status === '사용' ? '중지' : '사용' });
      }
      users = (await api('admin.listUsers')).users; drawUsers();
    } catch(err) { msg('usersMsg', err.message); busy(btn, false); }
  });
  $('addForm').addEventListener('submit', async function(e){
    e.preventDefault(); msg('usersMsg', ''); $('tempBox').hidden = true;
    var id = $('addId').value.trim().toLowerCase(), name = $('addName').value.trim();
    if (!/^[a-z0-9._-]{3,30}$/.test(id)) { msg('usersMsg', '아이디는 영문 소문자·숫자·.-_ 로 3~30자여야 해요.'); return; }
    if (!name) { msg('usersMsg', '이름을 입력해 주세요.'); return; }
    busy($('addBtn'), true, '등록 중…');
    try {
      var pw = $('addPw').value;
      if (pw && (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))) { msg('usersMsg', '비밀번호는 영문과 숫자를 섞어 8자 이상이어야 해요.'); return; }
      var r = await api('admin.addUser', { id: id, name: name, role: $('addRole').value, password: pw });
      $('addId').value = ''; $('addName').value = ''; $('addRole').value = '직원'; $('addPw').value = '';
      if (r.tempPassword) showTemp(r.user.name, r.user.id, r.tempPassword);
      else { $('tempBox').innerHTML = '<strong>' + esc(r.user.name) + ' (' + esc(r.user.id) + ')</strong> 계정을 만들었어요. 정하신 비밀번호로 로그인하면 됩니다.'; $('tempBox').hidden = false; }
      users = (await api('admin.listUsers')).users; drawUsers();
    } catch(err) { msg('usersMsg', err.message); }
    finally { busy($('addBtn'), false); }
  });

  // ===== 비밀번호 지정 (관리자) =====
  var pwTarget = null;
  function openSetPw(u){
    pwTarget = u; $('tempBox').hidden = true; msg('usersMsg', '');
    $('setPwWho').textContent = u.name + ' (' + u.id + ')';
    $('setPwNew').value = ''; $('setPwAdmin').value = ''; msg('setPwMsg', '');
    $('setPwBox').hidden = false; $('setPwNew').focus();
  }
  $('setPwCancel').addEventListener('click', function(){ $('setPwBox').hidden = true; pwTarget = null; });
  $('setPwForm').addEventListener('submit', async function(e){
    e.preventDefault(); msg('setPwMsg', '');
    if (!pwTarget) return;
    var pw = $('setPwNew').value, adminPw = $('setPwAdmin').value;
    if (pw && (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw))) { msg('setPwMsg', '새 비밀번호는 영문과 숫자를 섞어 8자 이상이어야 해요.'); return; }
    if (!adminPw) { msg('setPwMsg', '확인을 위해 관리자 비밀번호를 입력해 주세요.'); return; }
    busy($('setPwBtn'), true, '바꾸는 중…');
    try {
      var r = await api('admin.resetPassword', { id: pwTarget.id, password: pw, adminPassword: adminPw });
      if (r.token) TAEUI.setSession({ token: r.token });
      $('setPwBox').hidden = true;
      if (r.tempPassword) showTemp(pwTarget.name, pwTarget.id, r.tempPassword);
      else { $('tempBox').innerHTML = '<strong>' + esc(pwTarget.name) + ' (' + esc(pwTarget.id) + ')</strong> 비밀번호를 바꿨어요. 이 계정으로 로그인해 있던 화면은 모두 로그아웃돼요.'; $('tempBox').hidden = false; }
      pwTarget = null;
      users = (await api('admin.listUsers')).users; drawUsers();
    } catch(err) { msg('setPwMsg', err.message); }
    finally { busy($('setPwBtn'), false); }
  });

  // ===== 시작 =====
  (async function start(){
    if (!TAEUI.getSession()) { show('viewLogin'); return; }
    try { enter((await api('me')).user); }
    catch(err) {
      if (err.code === 'MUST_CHANGE') { openPw(true); return; }
      show('viewLogin'); if (err.code !== 'AUTH') msg('loginMsg', err.message);
    }
  })();
})();

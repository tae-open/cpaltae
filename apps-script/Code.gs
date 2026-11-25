/**
 * 노무법인 태(泰) 통합 업무시스템 서버 (Google Apps Script)
 *
 * 이 스크립트는 구글 시트에 붙여서(확장 프로그램 > Apps Script) 사용합니다.
 *  - '계정' 시트: 직원 계정 (비밀번호는 해시로만 저장)
 *  - '발급기록' 시트: 다운로드·팩스 발급 기록 (언제·누가·업무·서류·위임자 이름·수임자 이름·방식·파일 지문 — 주민등록번호는 기록하지 않음)
 *  - '팩스발송' 시트: 팩스 보내기 요청과 결과. 보낼 PDF 는 중계 서버가 가져갈 때까지만 드라이브에 잠시 두고 바로 지움
 *
 * 팩스 설정(편집기 왼쪽 톱니바퀴 '프로젝트 설정' → 스크립트 속성):
 *  - FAX_MODE  : test(기본, 실제로 보내지 않음) 또는 relay(클라우드 중계 서버를 거쳐 하나팩스로 보냄)
 *  - RELAY_KEY : 중계 서버 비밀키(중계 서버 설정 파일과 같은 값). relay 모드에서 필수
 *
 * 처음 한 번: 편집기에서 setup 함수를 실행하세요. 관리자 계정(admin)과 임시 비밀번호가
 * 실행 로그에 표시됩니다. 그다음 [배포 > 새 배포 > 웹 앱]으로 배포하고 URL을 config.js에 넣으세요.
 */

// 서버 코드 버전 — 화면이 이 값을 보고 '예전 서버' 안내를 띄움. Code.gs 를 바꿀 때마다 올림
var SERVER_VERSION = '20261126';
var SHEET_USERS = '계정';
var SHEET_LOG = '발급기록';
var USER_HEADERS = ['아이디', '이름', '역할', '상태', '솔트', '비밀번호해시', '비밀번호변경필요', '생성일', '마지막로그인'];
// 기존 기록과 맞도록 새 칸은 항상 뒤에 붙임 — 예전 줄은 그 칸이 비어 있음(업무가 비면 4대보험 청구)
var LOG_HEADERS = ['일시', '아이디', '작성자', '서류', '파일 지문(SHA-256)', '위임자', '수임자', '업무', '방식', '받는 곳', '팩스 작업번호'];
var L = { at: 0, id: 1, writer: 2, doc: 3, sha: 4, delegator: 5, delegatee: 6, ws: 7, method: 8, to: 9, job: 10 };
var SHEET_FAX = '팩스발송';
var FAX_HEADERS = ['작업번호', '요청일시', '아이디', '작성자', '업무', '서류', '받는 곳', '받는 번호', '쪽수', '상태', '결과코드', '결과',
                   '전송시작', '전송종료', '파일 지문(SHA-256)', '임시파일ID', '위임자', '수임자', '모드'];
var F = { job: 0, at: 1, id: 2, writer: 3, ws: 4, doc: 5, to: 6, number: 7, pages: 8, status: 9, code: 10, result: 11,
          start: 12, end: 13, sha: 14, file: 15, delegator: 16, delegatee: 17, mode: 18 };
// 사이트 주소 — 팩스 받는 번호가 공식 확인된 번호인지 사이트의 관할지사 자료로 확인할 때 씀(스크립트 속성 SITE_URL 로 바꿀 수 있음)
var SITE_URL = 'https://tae-open.github.io/cplatae/';
// 업무 → 화면 이름. 새 업무(평균임금 등)를 열 때 DOCS 에 그 업무의 서류 이름을 추가
var WORKSPACES = { insurance: '4대보험 청구', 'average-wage': '평균임금', 'hearing-loss': '난청',
                   musculoskeletal: '근골격계', pneumoconiosis: '진폐' };
var DUP_WINDOW_MS = 10 * 60 * 1000;   // 같은 직원이 같은 파일을 10분 안에 다시 받으면 한 번만 기록
// 화면의 내려받기 버튼(묶음) → 서류 이름. 이 목록에 없는 값은 기록하지 않음
var DOCS = {
  insurance: {
    nps: '국민연금 증명원 발급 신청서',
    tax_income: '소득금액증명원 발급 신청서 및 위임장',
    tax_daily: '일용근로소득증명원 발급 신청서 및 위임장',
    tax_all: '세무서 제출서류 일괄(소득금액증명원·일용근로소득증명원)',
    comwel: '고용보험 발급 신청서 및 위임장'
  }
};
var BUNDLE_NAMES = DOCS.insurance;   // 예전 코드 호환
var COL = { id: 0, name: 1, role: 2, status: 3, salt: 4, hash: 5, mustChange: 6, created: 7, lastLogin: 8 };
var SESSION_SECONDS = 6 * 60 * 60;   // 로그인 유지 6시간 (CacheService 최대치)
var MAX_FAILS = 5;                   // 비밀번호 5번 틀리면
var LOCK_SECONDS = 15 * 60;          // 15분 잠금
var HASH_ROUNDS = 300;

// ===================== 진입점 =====================

function doGet() {
  return json_({ ok: true, service: 'taeui-4insurance', serverVersion: SERVER_VERSION, time: new Date().toISOString() });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: '요청 형식이 올바르지 않아요.' });
  }
  try {
    var route = ROUTES[req.action];
    if (!route) throw appError_('알 수 없는 요청이에요.');
    var result = route(req) || {};
    result.ok = true;
    return json_(result);
  } catch (err) {
    if (err && err.isApp) return json_({ ok: false, error: err.message, code: err.code || '' });
    console.error(err);
    return json_({ ok: false, error: '서버에서 오류가 났어요. 잠시 후 다시 시도해 주세요.' });
  }
}

var ROUTES = {
  login: login_,
  logout: logout_,
  me: me_,
  changePassword: changePassword_,
  logCreate: logCreate_,
  myLogs: myLogs_,
  'admin.listUsers': adminListUsers_,
  'admin.addUser': adminAddUser_,
  'admin.updateUser': adminUpdateUser_,
  'admin.resetPassword': adminResetPassword_,
  'admin.listLogs': adminListLogs_,
  'records.search': recordsSearch_,
  'fax.info': faxInfo_,
  'fax.send': faxSend_,
  'fax.status': faxStatus_,
  'relay.poll': relayPoll_,
  'relay.report': relayReport_
};

// ===================== 최초 설정 =====================

/** 편집기에서 한 번 실행: 시트를 만들고 관리자 계정을 만듭니다. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_USERS, USER_HEADERS);
  ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
  ensureSheet_(ss, SHEET_FAX, FAX_HEADERS);
  var users = readUsers_();
  var hasAdmin = users.some(function (u) { return u.role === '관리자'; });
  if (hasAdmin) {
    console.log('관리자 계정이 이미 있어요. 새로 만들지 않았습니다.');
    return;
  }
  var temp = tempPassword_();
  appendUser_('admin', '관리자', '관리자', temp);
  var msg = '관리자 계정을 만들었어요.\n아이디: admin\n임시 비밀번호: ' + temp + '\n처음 로그인할 때 새 비밀번호로 바꾸게 됩니다.';
  console.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 편집기에서 실행하면 UI가 없을 수 있어요 */ }
}

/** 관리자 비밀번호를 잊었을 때: 편집기에서 실행하면 admin 계정에 새 임시 비밀번호를 발급합니다. */
function resetAdminPassword() {
  var temp = tempPassword_();
  setPassword_('admin', temp, true);
  updateUserField_('admin', COL.status, '사용');
  CacheService.getScriptCache().remove('fail:admin');
  console.log('admin 임시 비밀번호: ' + temp);
}

// ===================== 인증 =====================

function login_(req) {
  var id = cleanId_(req.id);
  var pw = String(req.password || '');
  if (!id || !pw) throw appError_('아이디와 비밀번호를 입력해 주세요.');
  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('fail:' + id) || 0);
  if (fails >= MAX_FAILS) throw appError_('비밀번호를 여러 번 틀려서 15분 동안 로그인할 수 없어요.');

  var user = findUser_(id);
  if (!user || user.hash !== hash_(pw, user.salt)) {
    cache.put('fail:' + id, String(fails + 1), LOCK_SECONDS);
    var left = MAX_FAILS - fails - 1;
    throw appError_('아이디 또는 비밀번호가 맞지 않아요.' + (left > 0 && left <= 2 ? ' (' + left + '번 더 틀리면 15분 잠김)' : ''));
  }
  if (user.status !== '사용') throw appError_('사용이 중지된 계정이에요. 관리자에게 문의해 주세요.');
  cache.remove('fail:' + id);

  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('s:' + token, user.id + '|' + sessionVersion_(user.id), SESSION_SECONDS);
  updateUserField_(user.id, COL.lastLogin, new Date());
  return { token: token, user: publicUser_(user) };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('s:' + req.token);
  return {};
}

function me_(req) {
  return { user: publicUser_(auth_(req)) };
}

function changePassword_(req) {
  var user = auth_(req, { allowMustChange: true });
  if (user.role !== '관리자') throw appError_('직원 계정의 비밀번호는 관리자만 바꿀 수 있어요.');
  if (user.hash !== hash_(String(req.current || ''), user.salt)) throw appError_('현재 비밀번호가 맞지 않아요.');
  var next = String(req.next || '');
  checkPassword_(next);
  if (next === String(req.current)) throw appError_('새 비밀번호는 현재 비밀번호와 달라야 해요.');
  setPassword_(user.id, next, false);
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s:' + token, user.id + '|' + sessionVersion_(user.id), SESSION_SECONDS);
  return { user: publicUser_(findUser_(user.id)), token: token };
}

/** 토큰을 확인하고 최신 계정 정보를 돌려줍니다. */
function auth_(req, opts) {
  opts = opts || {};
  var token = String(req.token || '');
  var saved = token ? CacheService.getScriptCache().get('s:' + token) : null;
  var parts = saved ? String(saved).split('|') : [];
  var id = parts[0];
  if (!id) throw appError_('로그인이 필요해요. 다시 로그인해 주세요.', 'AUTH');
  if (parts[1] !== sessionVersion_(id)) {   // 비밀번호가 바뀌면 그 전에 로그인한 화면은 모두 로그아웃
    CacheService.getScriptCache().remove('s:' + token);
    throw appError_('비밀번호가 바뀌어 로그아웃됐어요. 새 비밀번호로 다시 로그인해 주세요.', 'AUTH');
  }
  var user = findUser_(id);
  if (!user || user.status !== '사용') {
    CacheService.getScriptCache().remove('s:' + token);
    throw appError_('사용할 수 없는 계정이에요. 관리자에게 문의해 주세요.', 'AUTH');
  }
  if (user.mustChange && !opts.allowMustChange) throw appError_('먼저 비밀번호를 바꿔 주세요.', 'MUST_CHANGE');
  if (opts.admin && user.role !== '관리자') throw appError_('관리자만 할 수 있어요.', 'FORBIDDEN');
  return user;
}

// ===================== 작성 이력 =====================

function logCreate_(req) {
  var user = auth_(req);
  var ws = String(req.workspace || 'insurance');
  var name = DOCS[ws] && DOCS[ws][String(req.bundleKey || '')];
  if (!name) throw appError_('알 수 없는 서류예요.');
  var sha = String(req.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw appError_('파일 지문 형식이 올바르지 않아요.');
  var delegator = safe_(req.delegatorName, 20), delegatee = safe_(req.delegateeName, 20);
  var duplicate = false;
  withLock_(function () {
    var sh = sheet_(SHEET_LOG), last = sh.getLastRow(), now = Date.now();
    if (last >= 2) {   // 최근 30줄에서 같은 직원·같은 파일 다운로드가 10분 안에 기록됐는지
      var from = Math.max(2, last - 29);
      var recent = sh.getRange(from, 1, last - from + 1, LOG_HEADERS.length).getValues();
      duplicate = recent.some(function (r) {
        var at = r[0] instanceof Date ? r[0].getTime() : Date.parse(r[0]);
        return String(r[L.id]) === user.id && String(r[L.sha]) === sha && String(r[L.method] || '다운로드') === '다운로드' && now - at < DUP_WINDOW_MS;
      });
    }
    if (!duplicate) sh.appendRow([new Date(), user.id, user.name, name, sha, delegator, delegatee, WORKSPACES[ws], '다운로드', '', '']);
  });
  return { duplicate: duplicate };
}

function myLogs_(req) {
  var user = auth_(req);
  return { logs: readLogs_(function (r) { return r.id === user.id; }, 200) };
}

function adminListLogs_(req) {
  auth_(req, { admin: true });
  return { logs: readLogs_(null, 500) };
}

function readLogs_(filter, limit) {
  var sh = sheet_(SHEET_LOG);
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var rows = sh.getRange(2, 1, n, LOG_HEADERS.length).getValues();
  var out = [];
  for (var i = rows.length - 1; i >= 0 && out.length < limit; i--) {
    var item = logItem_(rows[i]);
    if (!filter || filter(item)) out.push(item);
  }
  return out;
}

function logItem_(r) {
  return { at: toIso_(r[L.at]), id: String(r[L.id]), writer: String(r[L.writer]), doc: String(r[L.doc]), sha256: String(r[L.sha]),
           delegator: String(r[L.delegator] || ''), delegatee: String(r[L.delegatee] || ''),
           workspace: String(r[L.ws] || '4대보험 청구'), method: String(r[L.method] || '다운로드'),
           to: String(r[L.to] || ''), job: String(r[L.job] || '') };
}

// ===================== 발급 기록 검색 =====================
// 시트의 모든 기록을 대상으로 찾음(개수 제한 없음). 화면에는 최근 것부터 한 번에 최대 100건씩 보냄.
// 직원은 자기 계정 기록만, 관리자는 전체(계정을 골라 볼 수 있음). 내보내기(export)는 조건에 맞는 기록을 최대 5,000건까지.

function kstDate_(v) {
  var d = v instanceof Date ? v : new Date(v);
  return isNaN(d) ? '' : new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function recordsSearch_(req) {
  var user = auth_(req);
  var admin = user.role === '관리자';
  var account = admin ? String(req.account || '') : user.id;    // 빈 값 = 전체(관리자만)
  var from = String(req.from || ''), to = String(req.to || '');
  var ws = String(req.workspace || ''), method = String(req.method || '');
  var q = String(req.q || '').replace(/\s+/g, '').slice(0, 30);
  var exportAll = !!req.export;
  var limit = exportAll ? 5000 : Math.min(100, Math.max(1, Number(req.limit) || 50));
  var offset = exportAll ? 0 : Math.max(0, Number(req.offset) || 0);
  var sh = sheet_(SHEET_LOG), n = sh.getLastRow() - 1;
  var rows = n > 0 ? sh.getRange(2, 1, n, LOG_HEADERS.length).getValues() : [];
  var faxes = faxMap_();
  var matched = [], counts = { download: 0, fax: 0 }, byWs = {};
  for (var i = rows.length - 1; i >= 0; i--) {
    var it = logItem_(rows[i]), d = kstDate_(rows[i][L.at]);
    if (account && it.id !== account) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    if (ws && it.workspace !== ws) continue;
    if (method && it.method !== method) continue;
    if (q && (it.delegator + it.delegatee + it.doc + it.writer + it.to).replace(/\s+/g, '').indexOf(q) < 0) continue;
    if (it.method === '팩스' && it.job && faxes[it.job]) { it.faxStatus = faxes[it.job].status; it.faxResult = faxes[it.job].result; }
    counts[it.method === '팩스' ? 'fax' : 'download']++;
    byWs[it.workspace] = (byWs[it.workspace] || 0) + 1;
    matched.push(it);
  }
  var page = matched.slice(offset, offset + limit);
  return { rows: page, total: matched.length, counts: counts, byWorkspace: byWs, offset: offset,
           nextOffset: offset + page.length < matched.length ? offset + page.length : null,
           accounts: admin ? readUsers_().map(function (u) { return { id: u.id, name: u.name }; }) : null };
}

// ===================== 계정 관리 (관리자) =====================

function adminListUsers_(req) {
  auth_(req, { admin: true });
  return { users: readUsers_().map(publicUser_) };
}

function adminAddUser_(req) {
  auth_(req, { admin: true });
  var id = cleanId_(req.id);
  if (!/^[a-z0-9._-]{3,30}$/.test(id)) throw appError_('아이디는 영문 소문자·숫자·.-_ 로 3~30자여야 해요.');
  var name = safe_(req.name, 30);
  if (!name) throw appError_('이름을 입력해 주세요.');
  var role = req.role === '관리자' ? '관리자' : '직원';
  var direct = String(req.password || '');
  if (direct) checkPassword_(direct);
  var password = direct || tempPassword_();
  // 직원(공용) 계정은 본인이 비밀번호를 바꿀 수 없으므로 처음 로그인 때 바꾸라고 하지 않음
  var mustChange = role === '관리자' && !direct;
  withLock_(function () {
    if (findUser_(id)) throw appError_('이미 있는 아이디예요.');
    appendUser_(id, name, role, password, mustChange);
  });
  return { user: publicUser_(findUser_(id)), tempPassword: direct ? '' : password };
}

function adminUpdateUser_(req) {
  var me = auth_(req, { admin: true });
  var id = cleanId_(req.id);
  var target = findUser_(id);
  if (!target) throw appError_('없는 계정이에요.');
  var role = req.role === undefined ? target.role : (req.role === '관리자' ? '관리자' : '직원');
  var status = req.status === undefined ? target.status : (req.status === '중지' ? '중지' : '사용');
  if (id === me.id && (role !== '관리자' || status !== '사용')) throw appError_('내 계정은 관리자 권한을 빼거나 중지할 수 없어요.');
  withLock_(function () {
    if (req.name !== undefined) {
      var name = safe_(req.name, 30);
      if (!name) throw appError_('이름을 입력해 주세요.');
      updateUserField_(id, COL.name, name);
    }
    updateUserField_(id, COL.role, role);
    updateUserField_(id, COL.status, status);
  });
  if (status !== '사용') endSessions_(id);
  return { user: publicUser_(findUser_(id)) };
}

/** 관리자가 계정 비밀번호를 정함(직접 입력 또는 자동 생성). 관리자 본인 비밀번호를 다시 확인하고,
 *  그 계정으로 이미 로그인한 화면은 모두 로그아웃시킴. */
function adminResetPassword_(req) {
  var me = auth_(req, { admin: true });
  if (me.hash !== hash_(String(req.adminPassword || ''), me.salt)) throw appError_('관리자 비밀번호가 맞지 않아요.');
  var id = cleanId_(req.id);
  var target = findUser_(id);
  if (!target) throw appError_('없는 계정이에요.');
  var direct = String(req.password || '');
  if (direct) checkPassword_(direct);
  var password = direct || tempPassword_();
  var mustChange = target.role === '관리자' && !direct && id !== me.id;
  withLock_(function () { setPassword_(id, password, mustChange); });
  CacheService.getScriptCache().remove('fail:' + id);
  if (id === me.id) {   // 내 비밀번호를 바꿨으면 지금 화면은 새 세션으로 이어 줌
    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    CacheService.getScriptCache().put('s:' + token, id + '|' + sessionVersion_(id), SESSION_SECONDS);
    return { tempPassword: direct ? '' : password, token: token };
  }
  return { tempPassword: direct ? '' : password };
}

// ===================== 팩스 보내기 =====================
// 화면(브라우저) → fax.send: PDF 와 받는 곳을 받아 '팩스발송' 시트에 요청을 남김
//   - test 모드: 실제로 보내지 않고 바로 '테스트 완료'(PDF 는 저장하지 않음)
//   - relay 모드: PDF 를 드라이브에 잠시 두고 '요청 접수' → 중계 서버가 relay.poll 로 가져가면 바로 지움
// 중계 서버 → relay.poll / relay.report: 비밀키(RELAY_KEY)가 맞아야만 동작
// 받는 번호는 공식 확인된 번호만(사이트의 관할지사 자료의 가입지원부 번호, 근로복지공단 고정 번호). 직접 입력한 번호는 보내지 않음
var FAX_DONE = ['성공', '실패', '테스트 완료', '취소'];
var FAX_ACTIVE = ['요청 접수', '서버 전달', '전송 중', '성공', '테스트 완료'];   // 같은 서류를 같은 번호로 다시 못 보내는 상태
var RESULT_CODES = { '801': '일부 쪽만 전송됨', '802': '전송 완료', '803': '통화 중(3번 시도)', '804': '잘못된 수신번호',
  '805': '응답 없음', '806': '사람이 받음', '807': '수신 거부', '808': '기타 오류', '809': '수신처 통화 몰림',
  '810': '파일 변환 오류', '811': '전송 데이터 누락', '812': '파일 저장 오류', '814': '입력 항목 오류', '815': '통신 오류' };
var MAX_PDF_BASE64 = 15 * 1024 * 1024;

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function faxMode_() { return prop_('FAX_MODE') === 'relay' ? 'relay' : 'test'; }
function digits_(s) { return String(s || '').replace(/\D/g, ''); }

function faxInfo_(req) {
  auth_(req);
  var seen = Number(prop_('RELAY_SEEN') || 0);
  return { mode: faxMode_(), relaySeen: seen ? new Date(seen).toISOString() : '', relayAlive: !!seen && Date.now() - seen < 3 * 60 * 1000 };
}

/** 공식 확인된 팩스번호 목록(6시간 보관) — 사이트의 assets/nps/directory.json */
function allowedNumbers_() {
  var cache = CacheService.getScriptCache(), hit = cache.get('fax:allowed');
  if (hit) return JSON.parse(hit);
  var url = (prop_('SITE_URL') || SITE_URL).replace(/\/?$/, '/') + 'assets/nps/directory.json';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw appError_('공식 팩스번호 목록을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
  var data = JSON.parse(res.getContentText()), list = {};
  data.branches.forEach(function (b) {
    b.faxes.forEach(function (f) {
      if (f.purpose === '가입증명' || f.department === '가입지원부') list[digits_(f.fax)] = b.name + ' ' + f.department;
    });
  });
  if (data.comwel && data.comwel.fax) list[digits_(data.comwel.fax)] = data.comwel.name;
  cache.put('fax:allowed', JSON.stringify(list), 6 * 3600);
  return list;
}

function faxRows_() {
  var sh = sheet_(SHEET_FAX), n = sh.getLastRow() - 1;
  return { sh: sh, rows: n > 0 ? sh.getRange(2, 1, n, FAX_HEADERS.length).getValues() : [] };
}
function faxMap_() {
  var map = {};
  faxRows_().rows.forEach(function (r) { map[String(r[F.job])] = { status: String(r[F.status]), result: String(r[F.result]) }; });
  return map;
}
function faxItem_(r) {
  return { job: String(r[F.job]), at: toIso_(r[F.at]), id: String(r[F.id]), doc: String(r[F.doc]), to: String(r[F.to]),
           number: String(r[F.number]), pages: Number(r[F.pages]) || 0, status: String(r[F.status]), code: String(r[F.code]),
           result: String(r[F.result]), mode: String(r[F.mode]) };
}

function faxSend_(req) {
  var user = auth_(req);
  var ws = String(req.workspace || 'insurance');
  var doc = DOCS[ws] && DOCS[ws][String(req.bundleKey || '')];
  if (!doc) throw appError_('알 수 없는 서류예요.');
  var number = digits_(req.number);
  if (!/^0\d{8,11}$/.test(number)) throw appError_('팩스번호 형식이 올바르지 않아 전송할 수 없어요.', 'bad_number');
  var allowed = allowedNumbers_();
  if (!allowed[number]) throw appError_('공식 확인되지 않은 팩스번호라 전송할 수 없어요. 관할지사의 확인된 가입지원부 번호와 근로복지공단 번호만 보낼 수 있어요.', 'not_confirmed');
  var sha = String(req.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw appError_('파일 지문 형식이 올바르지 않아요.');
  var b64 = String(req.pdfBase64 || '');
  if (!b64 || b64.length > MAX_PDF_BASE64) throw appError_('PDF 파일이 비었거나 너무 커서(10MB 초과) 보낼 수 없어요.');
  var bytes = Utilities.base64Decode(b64);
  var got = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  if (got !== sha) throw appError_('전송 중 파일이 바뀌었어요. 다시 시도해 주세요.', 'changed');
  var pages = Math.max(1, Math.min(200, Number(req.pages) || 1));
  var mode = faxMode_();
  if (mode === 'relay' && !prop_('RELAY_KEY')) throw appError_('팩스 중계 서버 설정(RELAY_KEY)이 없어 보낼 수 없어요. 관리자에게 문의해 주세요.');
  var to = safe_(req.recipientName, 40) || allowed[number];
  var job = '';
  withLock_(function () {
    var t = faxRows_();
    var dup = t.rows.some(function (r) {
      return String(r[F.sha]) === sha && digits_(r[F.number]) === number && FAX_ACTIVE.indexOf(String(r[F.status])) >= 0;
    });
    if (dup) throw appError_('같은 서류를 같은 번호로 이미 보냈어요(접수·전송 중·성공). 다시 보낼 수 없어요 — 발급 기록을 확인해 주세요.', 'duplicate');
    job = 'F' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);   // 하나팩스 strsid(30자 이내, 중복 금지)
    var fileId = '';
    if (mode === 'relay') {
      var blob = Utilities.newBlob(bytes, 'application/pdf', job + '.pdf');
      fileId = DriveApp.createFile(blob).getId();
    }
    var now = new Date();
    t.sh.appendRow([job, now, user.id, user.name, WORKSPACES[ws], doc, to, number, pages,
                    mode === 'test' ? '테스트 완료' : '요청 접수', '', mode === 'test' ? '테스트 모드 — 실제 팩스는 보내지 않았어요' : '',
                    '', '', sha, fileId, safe_(req.delegatorName, 20), safe_(req.delegateeName, 20), mode]);
    sheet_(SHEET_LOG).appendRow([now, user.id, user.name, doc, sha, safe_(req.delegatorName, 20), safe_(req.delegateeName, 20),
                                 WORKSPACES[ws], '팩스', to + ' ' + number, job]);
  });
  return { job: job, mode: mode, status: mode === 'test' ? '테스트 완료' : '요청 접수' };
}

function faxStatus_(req) {
  var user = auth_(req);
  var want = (req.jobs || []).map(String).slice(0, 20);
  var out = faxRows_().rows.filter(function (r) {
    return want.indexOf(String(r[F.job])) >= 0 && (user.role === '관리자' || String(r[F.id]) === user.id);
  }).map(faxItem_);
  return { jobs: out };
}

// ----- 중계 서버 전용 -----
function relayAuth_(req) {
  var key = prop_('RELAY_KEY'), got = String(req.key || '');
  if (!key || key.length < 24 || got.length !== key.length) throw appError_('중계 서버 키가 맞지 않아요.', 'RELAY');
  var diff = 0;
  for (var i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  if (diff) throw appError_('중계 서버 키가 맞지 않아요.', 'RELAY');
  PropertiesService.getScriptProperties().setProperty('RELAY_SEEN', String(Date.now()));
}

/** 보낼 팩스를 최대 3건 넘겨줌(PDF 포함). 넘긴 건은 '서버 전달'로 바꿈 — PDF 파일은 relay.report(accepted) 때 지움 */
function relayPoll_(req) {
  relayAuth_(req);
  var jobs = [];
  withLock_(function () {
    var t = faxRows_();
    for (var i = 0; i < t.rows.length && jobs.length < 3; i++) {
      var r = t.rows[i];
      if (String(r[F.status]) !== '요청 접수' || String(r[F.mode]) !== 'relay') continue;
      var file = DriveApp.getFileById(String(r[F.file]));
      jobs.push({ job: String(r[F.job]), number: digits_(r[F.number]), subject: String(r[F.doc]).slice(0, 90),
                  pages: Number(r[F.pages]) || 0, sha256: String(r[F.sha]), pdfBase64: Utilities.base64Encode(file.getBlob().getBytes()) });
      t.sh.getRange(i + 2, F.status + 1).setValue('서버 전달');
    }
  });
  return { jobs: jobs, sender: prop_('FAX_SENDER') || '0707966579' };
}

/** 중계 서버가 진행 상황을 알려 줌. state: accepted(서버에 저장·모듈에 넘김) / done(결과 코드) / failed(서버 쪽 오류) */
function relayReport_(req) {
  relayAuth_(req);
  var job = String(req.job || ''), state = String(req.state || '');
  withLock_(function () {
    var t = faxRows_();
    for (var i = 0; i < t.rows.length; i++) {
      var r = t.rows[i];
      if (String(r[F.job]) !== job) continue;
      var row = i + 2, set = function (col, v) { t.sh.getRange(row, col + 1).setValue(v); };
      if (state === 'accepted') {
        if (String(r[F.file])) { try { DriveApp.getFileById(String(r[F.file])).setTrashed(true); } catch (e) {} set(F.file, ''); }
        set(F.status, '전송 중');
      } else if (state === 'done') {
        var code = String(req.code || '').slice(0, 3);
        set(F.code, code);
        if (req.dryRun) {   // 중계 서버 연결 시험(dry-run) — 하나팩스로는 보내지 않음
          set(F.status, '테스트 완료'); set(F.result, '중계 서버 연결 시험(dry-run) — 실제 팩스는 보내지 않았어요');
        } else {
          set(F.status, code === '802' ? '성공' : '실패');
          set(F.result, (RESULT_CODES[code] || '알 수 없는 결과') + (req.pages ? ' · ' + Number(req.pages) + '쪽 전송' : ''));
        }
        set(F.start, safe_(req.start, 19)); set(F.end, safe_(req.end, 19));
      } else if (state === 'failed') {
        set(F.status, '실패'); set(F.result, '중계 서버 오류: ' + safe_(req.message, 120));
        if (String(r[F.file])) { try { DriveApp.getFileById(String(r[F.file])).setTrashed(true); } catch (e) {} set(F.file, ''); }
      } else {
        throw appError_('알 수 없는 상태예요.');
      }
      return;
    }
    throw appError_('없는 팩스 작업이에요.');
  });
  return {};
}

// ===================== 시트 도우미 =====================

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (name === SHEET_LOG) return ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);   // 새 기록 시트는 처음 쓸 때 만듦
  if (name === SHEET_FAX) return ensureSheet_(ss, SHEET_FAX, FAX_HEADERS);
  var sh = ss.getSheetByName(name);
  if (!sh) throw appError_('시트가 준비되지 않았어요. Apps Script 편집기에서 setup을 먼저 실행해 주세요.');
  return sh;
}

function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else {   // 예전 시트에 새로 생긴 제목 칸만 채움(기존 기록은 그대로)
    var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    for (var i = 0; i < headers.length; i++) {
      if (!cur[i]) sh.getRange(1, i + 1).setValue(headers[i]).setFontWeight('bold');
    }
  }
  return sh;
}

function readUsers_() {
  var sh = sheet_(SHEET_USERS);
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, USER_HEADERS.length).getValues().map(function (r, i) {
    return {
      row: i + 2, id: String(r[COL.id]), name: String(r[COL.name]), role: String(r[COL.role]),
      status: String(r[COL.status]), salt: String(r[COL.salt]), hash: String(r[COL.hash]),
      mustChange: r[COL.mustChange] === true || String(r[COL.mustChange]).toUpperCase() === 'TRUE',
      created: r[COL.created], lastLogin: r[COL.lastLogin]
    };
  }).filter(function (u) { return u.id; });
}

function findUser_(id) {
  var users = readUsers_();
  for (var i = 0; i < users.length; i++) if (users[i].id === id) return users[i];
  return null;
}

function appendUser_(id, name, role, password, mustChange) {
  var salt = Utilities.getUuid();
  sheet_(SHEET_USERS).appendRow([id, name, role, '사용', salt, hash_(password, salt), mustChange !== false, new Date(), '']);
}

/** 계정별 세션 번호 — 비밀번호를 바꾸면 올라가서 그 전 로그인은 모두 끊김 */
function sessionVersion_(id) {
  return PropertiesService.getScriptProperties().getProperty('sv:' + id) || '0';
}
function endSessions_(id) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('sv:' + id, String(Number(props.getProperty('sv:' + id) || 0) + 1));
}

function setPassword_(id, password, mustChange) {
  var salt = Utilities.getUuid();
  updateUserField_(id, COL.salt, salt);
  updateUserField_(id, COL.hash, hash_(password, salt));
  updateUserField_(id, COL.mustChange, !!mustChange);
  endSessions_(id);
}

function updateUserField_(id, col, value) {
  var u = findUser_(id);
  if (!u) throw appError_('없는 계정이에요.');
  sheet_(SHEET_USERS).getRange(u.row, col + 1).setValue(value);
}

function publicUser_(u) {
  return { id: u.id, name: u.name, role: u.role, status: u.status, mustChange: u.mustChange, created: toIso_(u.created), lastLogin: toIso_(u.lastLogin),
           serverVersion: SERVER_VERSION };
}

// ===================== 기타 도우미 =====================

function hash_(password, salt) {
  var h = salt + ':' + password;
  for (var i = 0; i < HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + ':' + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function toHex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function checkPassword_(pw) {
  if (pw.length < 8) throw appError_('비밀번호는 8자 이상이어야 해요.');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw appError_('비밀번호에 영문과 숫자를 모두 넣어 주세요.');
}

function tempPassword_() {
  var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  var s = '';
  for (var i = 0; i < 10; i++) s += chars.charAt(((raw[i] + 256) % 256) % chars.length);
  return s.slice(0, 5) + (2 + ((raw[11] + 256) % 8)) + s.slice(5);
}

function cleanId_(v) {
  return String(v || '').trim().toLowerCase();
}

/** 시트 수식으로 해석되지 않게 막고 길이를 제한합니다. */
function safe_(v, max) {
  var s = String(v === undefined || v === null ? '' : v).trim().slice(0, max || 100);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function toIso_(v) {
  return v instanceof Date ? v.toISOString() : (v ? String(v) : '');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function appError_(message, code) {
  var e = new Error(message);
  e.isApp = true;
  e.code = code || '';
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

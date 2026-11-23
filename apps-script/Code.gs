/**
 * 노무법인 태의 · 4대보험 신청서 시스템 서버 (Google Apps Script)
 *
 * 이 스크립트는 구글 시트에 붙여서(확장 프로그램 > Apps Script) 사용합니다.
 *  - '계정' 시트: 직원 계정 (비밀번호는 해시로만 저장)
 *  - '발급기록' 시트: PDF 발급 기록 (누가·언제·어떤 서류·파일 지문만 — 개인정보는 기록하지 않음)
 *
 * 처음 한 번: 편집기에서 setup 함수를 실행하세요. 관리자 계정(admin)과 임시 비밀번호가
 * 실행 로그에 표시됩니다. 그다음 [배포 > 새 배포 > 웹 앱]으로 배포하고 URL을 config.js에 넣으세요.
 */

var SHEET_USERS = '계정';
var SHEET_LOG = '발급기록';
var USER_HEADERS = ['아이디', '이름', '역할', '상태', '솔트', '비밀번호해시', '비밀번호변경필요', '생성일', '마지막로그인'];
var LOG_HEADERS = ['일시', '아이디', '작성자', '서류', '파일 지문(SHA-256)'];
// 화면의 내려받기 버튼(묶음) → 서류 이름. 이 목록에 없는 값은 기록하지 않음
var BUNDLE_NAMES = {
  nps: '국민연금 증명원 발급 신청서',
  tax_income: '소득금액증명원 발급 신청서 및 위임장',
  tax_daily: '일용근로소득증명원 발급 신청서 및 위임장',
  tax_all: '세무서 제출서류 일괄(소득금액증명원·일용근로소득증명원)',
  comwel: '고용보험 발급 신청서 및 위임장'
};
var COL = { id: 0, name: 1, role: 2, status: 3, salt: 4, hash: 5, mustChange: 6, created: 7, lastLogin: 8 };
var SESSION_SECONDS = 6 * 60 * 60;   // 로그인 유지 6시간 (CacheService 최대치)
var MAX_FAILS = 5;                   // 비밀번호 5번 틀리면
var LOCK_SECONDS = 15 * 60;          // 15분 잠금
var HASH_ROUNDS = 300;

// ===================== 진입점 =====================

function doGet() {
  return json_({ ok: true, service: 'taeui-4insurance', time: new Date().toISOString() });
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
  'admin.listLogs': adminListLogs_
};

// ===================== 최초 설정 =====================

/** 편집기에서 한 번 실행: 시트를 만들고 관리자 계정을 만듭니다. */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_USERS, USER_HEADERS);
  ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);
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
  var name = BUNDLE_NAMES[String(req.bundleKey || '')];
  if (!name) throw appError_('알 수 없는 서류예요.');
  var sha = String(req.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw appError_('파일 지문 형식이 올바르지 않아요.');
  withLock_(function () {
    sheet_(SHEET_LOG).appendRow([new Date(), user.id, user.name, name, sha]);
  });
  return {};
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
    var r = rows[i];
    var item = { at: toIso_(r[0]), id: String(r[1]), writer: String(r[2]), doc: String(r[3]), sha256: String(r[4]) };
    if (!filter || filter(item)) out.push(item);
  }
  return out;
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

// ===================== 시트 도우미 =====================

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (name === SHEET_LOG) return ensureSheet_(ss, SHEET_LOG, LOG_HEADERS);   // 새 기록 시트는 처음 쓸 때 만듦
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
  return { id: u.id, name: u.name, role: u.role, status: u.status, mustChange: u.mustChange, created: toIso_(u.created), lastLogin: toIso_(u.lastLogin) };
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

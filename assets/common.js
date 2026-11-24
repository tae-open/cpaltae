// 서버(Apps Script) 연결과 로그인 상태 관리
(function(){
  var KEY = 'taeui.session';

  function getSession(){
    try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch(e){ return null; }
  }
  function setSession(s){
    try { s ? sessionStorage.setItem(KEY, JSON.stringify(s)) : sessionStorage.removeItem(KEY); } catch(e){}
  }

  // Apps Script는 text/plain으로 보내야 브라우저의 사전 확인(CORS) 없이 바로 받습니다.
  async function api(action, data){
    var url = window.TAEUI_CONFIG && window.TAEUI_CONFIG.API_URL;
    if (!url || url.indexOf('여기에') >= 0) throw apiError('config.js에 Apps Script 주소가 아직 없어요. 설치 안내를 따라 넣어 주세요.', 'CONFIG');
    var s = getSession();
    var body = Object.assign({ action: action, token: s ? s.token : '' }, data || {});
    var res;
    try {
      res = await fetch(url, { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect:'follow' });
    } catch(e) {
      throw apiError('서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', 'NETWORK');
    }
    var j;
    try { j = await res.json(); } catch(e) {
      throw apiError('서버 응답을 읽지 못했어요. Apps Script 배포 설정(액세스 권한: 모든 사용자)을 확인해 주세요.', 'BAD_RESPONSE');
    }
    if (!j.ok){
      if (j.code === 'AUTH') { setSession(null); if (window.TAEUI && TAEUI.onAuthLost) TAEUI.onAuthLost(j.error); }
      throw apiError(j.error || '요청을 처리하지 못했어요.', j.code);
    }
    return j;
  }
  function apiError(msg, code){ var e = new Error(msg); e.code = code || ''; return e; }

  function fmtDateTime(iso){
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return iso;
    // 어느 나라에서 열어도 한국 시간(KST)으로 표시
    var k = new Date(d.getTime() + 9 * 3600 * 1000);
    var p = function(n){ return String(n).padStart(2,'0'); };
    return k.getUTCFullYear() + '.' + p(k.getUTCMonth()+1) + '.' + p(k.getUTCDate()) + ' ' + p(k.getUTCHours()) + ':' + p(k.getUTCMinutes());
  }
  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  window.TAEUI = Object.assign(window.TAEUI || {}, { api: api, getSession: getSession, setSession: setSession, fmtDateTime: fmtDateTime, esc: esc });
})();

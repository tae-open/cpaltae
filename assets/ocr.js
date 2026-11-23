/* 신분증 글자 읽기(OCR) — 이 브라우저 안에서만 처리합니다.
 *
 * - Tesseract.js(오픈소스)를 처음 쓸 때만 불러옵니다. 인식 프로그램과 한글 학습 자료(약 10MB)는 내려받지만,
 *   신분증 이미지는 어디로도 보내지 않습니다. 학습 자료는 브라우저에 저장돼 다음부터는 빨리 시작합니다.
 * - 주민등록증·운전면허증에서 성명, 주민등록번호, 주소를 찾아 돌려줍니다. 읽은 값은 틀릴 수 있으므로
 *   화면에서 반드시 확인·수정하게 합니다.
 */
(function(){
  'use strict';
  var LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  var OPTS = {
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/kor@1.0.0/4.0.0_best_int'
  };
  var workerPromise = null, progressFn = null;

  function loadScript(src){
    return new Promise(function(res, rej){
      if (window.Tesseract) return res();
      var s = document.createElement('script'); s.src = src; s.onload = res;
      s.onerror = function(){ rej(new Error('글자 인식 프로그램을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  function getWorker(){
    if (!workerPromise) {
      workerPromise = loadScript(LIB).then(function(){
        return Tesseract.createWorker('kor', 1, Object.assign({}, OPTS, {
          logger: function(m){ if (progressFn) progressFn(m); }
        }));
      }).catch(function(e){ workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  /** 인식이 잘 되도록 크기·대비를 맞춘 그림. mode 1: 흑백+대비, mode 2: 더 크게+흑백 두 값으로 */
  async function prepare(source, mode){
    var bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
    var target = mode === 2 ? Math.max(2000, Math.min(2600, bmp.width * 1.5)) : Math.max(1400, Math.min(2200, bmp.width));
    var scale = target / bmp.width;
    var c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    var g = c.getContext('2d');
    g.filter = mode === 2 ? 'grayscale(1) contrast(1.6)' : 'grayscale(1) contrast(1.25)';
    g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
    if (mode === 2) {   // 밝기 평균을 기준으로 흑/백 두 값으로
      var img = g.getImageData(0, 0, c.width, c.height), d = img.data, sum = 0;
      for (var i = 0; i < d.length; i += 4) sum += d[i];
      var cut = sum / (d.length / 4) * 0.82;
      for (var j = 0; j < d.length; j += 4) { var v = d[j] < cut ? 0 : 255; d[j] = d[j + 1] = d[j + 2] = v; }
      g.putImageData(img, 0, 0);
    }
    return c;
  }
  /** 확신이 낮은 낱말(사진·무늬에서 잘못 읽은 글자)은 빼고 줄로 모음 */
  function textOf(data){
    if (!data.lines || !data.lines.length) return data.text || '';
    return data.lines.map(function(l){
      var text = l.text || '';   // 띄어쓰기는 인식 결과 그대로 두고, 확신이 낮은 낱말만 지움
      (l.words || []).forEach(function(w){
        if (w.confidence < 55 && w.text) text = text.replace(w.text, ' ');
      });
      return text.replace(/\s+/g, ' ').trim();
    }).join('\n');
  }

  // ===== 읽은 글자에서 값 찾기 =====
  var DIGIT_FIX = { O:'0', o:'0', D:'0', Q:'0', I:'1', l:'1', '|':'1', i:'1', Z:'2', z:'2', S:'5', s:'5', B:'8', G:'6', b:'6', g:'9', q:'9', T:'7' };
  function fixDigits(s){ return s.replace(/[OoDQIl|iZzSsBGbgqT]/g, function(c){ return DIGIT_FIX[c]; }); }
  function validRrn(d){
    if (!/^\d{13}$/.test(d)) return false;
    var m = +d.slice(2,4), day = +d.slice(4,6);
    return m >= 1 && m <= 12 && day >= 1 && day <= 31 && /[1-8]/.test(d[6]);
  }
  var RRN_RE = /([0-9OoDQIl|iZzSsBGbgqT]{6})\s*[-–—~_=.]\s*([0-9OoDQIl|iZzSsBGbgqT]{7})/;
  var STOP = /주민등록|운전면허|자동차|대한민국|면허|성명|주소|발급|청장|경찰|적성|갱신|기간|조건|보통|대형|소형|종류|번호|증$/;
  var ADDR_START = /(특별시|광역시|특별자치|[가-힣]{1,4}도\b|[가-힣]{1,5}[시군구]\b|[가-힣0-9]+(로|길)\s*\d)/;
  var ADDR_END = /(\d{4}\s*[.\-]\s*\d{1,2}\s*[.\-]\s*\d{1,2})|청장|경찰|적성|갱신|발급|조건|면허|기간|암호일련|식별번호/;

  function cleanName(line){
    var t = line.replace(/\(.*?\)?$/, '').replace(/[^가-힣\s]/g, ' ').replace(/성\s*명/g, ' ').trim();
    var words = t.split(/\s+/).filter(function(w){ return /^[가-힣]{2,5}$/.test(w) && !STOP.test(w); });
    return words.length ? words[words.length - 1] : '';
  }
  function cleanAddress(s){
    return s.replace(/^\s*주\s*소\s*[:：]?\s*/, '')
            .replace(/[^가-힣0-9A-Za-z\s\-,.()·]/g, ' ')
            .replace(/\s+/g, ' ').replace(/\s+([,)])/g, '$1').replace(/\(\s+/g, '(').trim().slice(0, 120);
  }

  function parse(text){
    var lines = text.split(/\n/).map(function(l){ return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var out = { name: '', rrn: '', address: '', lines: lines };
    var at = -1;
    for (var i = 0; i < lines.length && at < 0; i++){
      var m = lines[i].match(RRN_RE);
      if (m) {
        var d = fixDigits(m[1] + m[2]);
        if (validRrn(d)) { out.rrn = d.slice(0,6) + '-' + d.slice(6); at = i; out._rrnLineRest = lines[i].slice(0, m.index); }
      }
    }
    if (at < 0) return out;
    // 성명: 주민번호 앞쪽(같은 줄 → 바로 위 줄들 순서)
    var name = cleanName(out._rrnLineRest || '');
    for (var j = at - 1; !name && j >= Math.max(0, at - 3); j--) name = cleanName(lines[j]);
    out.name = name;
    // 주소: 주민번호 다음 줄부터, 날짜·발급기관 줄 앞까지
    var parts = [];
    for (var k = at + 1; k < lines.length; k++){
      var l = lines[k];
      if (ADDR_END.test(l)) break;
      if (!parts.length && !ADDR_START.test(l) && !/^\s*주\s*소/.test(l)) continue;
      parts.push(l);
      if (parts.length >= 3) break;
    }
    out.address = cleanAddress(parts.join(' '));
    delete out._rrnLineRest;
    return out;
  }

  /** source: 올린 원본 파일(또는 Blob), onProgress(문구). 주민번호를 못 찾으면 다른 방식으로 한 번 더 읽음 */
  async function readId(source, onProgress){
    progressFn = function(m){
      if (!onProgress) return;
      if (m.status === 'recognizing text') onProgress('글자를 읽는 중… ' + Math.round(m.progress * 100) + '%');
      else if (/load|initializ/.test(m.status)) onProgress('글자 인식 준비 중… (처음 한 번은 30초~1분 걸릴 수 있어요)');
    };
    var worker = await getWorker();
    var tries = [{ mode: 1, psm: '3' }, { mode: 2, psm: '3' }, { mode: 1, psm: '6' }, { mode: 2, psm: '6' }];
    var best = null;
    for (var i = 0; i < tries.length; i++){
      await worker.setParameters({ tessedit_pageseg_mode: tries[i].psm });
      var r = await worker.recognize(await prepare(source, tries[i].mode));
      var found = parse(textOf(r.data));
      var score = (found.rrn ? 4 : 0) + (found.name ? 2 : 0) + (found.address ? 1 : 0);
      if (!best || score > best.score) best = Object.assign(found, { score: score });
      if (found.rrn && found.name) break;
    }
    return best;
  }

  window.TaeOCR = { readId: readId, parse: parse };
})();

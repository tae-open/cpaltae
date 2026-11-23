
// 신청서 PDF 작성 (브라우저 안에서만 처리)
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var pad = function(n){ return String(n).padStart(2,'0'); };
  var t = new Date();
  $('date').value = t.getFullYear() + '-' + pad(t.getMonth()+1) + '-' + pad(t.getDate());

  $('rrn').addEventListener('input', function(e){
    var d = e.target.value.replace(/\D/g,'').slice(0,13);
    e.target.value = d.length > 6 ? d.slice(0,6) + '-' + d.slice(6) : d;
  });
  $('phone').addEventListener('input', function(e){
    var d = e.target.value.replace(/\D/g,'').slice(0,11), out = d;
    if (d.length > 7) out = d.slice(0,3) + '-' + d.slice(3, d.length - 4) + '-' + d.slice(-4);
    else if (d.length > 3) out = d.slice(0,3) + '-' + d.slice(3);
    e.target.value = out;
  });
  $('toggle').addEventListener('click', function(){
    var f = $('rrn'), hidden = f.type === 'password';
    f.type = hidden ? 'text' : 'password';
    this.textContent = hidden ? '숨기기' : '보기';
    drawPins();
  });

  // ===== 항목 정의 =====
  var FIELDS = [
    { key:'name',    label:'이름',         kw:['성명','이름','근로자명','피보험자명'] },
    { key:'rrn',     label:'주민등록번호', kw:['주민등록번호','주민번호'] },
    { key:'phone',   label:'전화번호',     kw:['휴대전화번호','휴대전화','휴대폰','전화번호','연락처'] },
    { key:'address', label:'주소',         kw:['주소'] },
    { key:'date',    label:'날짜',         kw:['신청일','작성일','제출일','신고일','날짜','일자'] }
  ];
  var ALLKW = [];
  FIELDS.forEach(function(f){ f.kw.forEach(function(k){ ALLKW.push(k); }); });
  ALLKW = ALLKW.concat(['사업장','서명','(인)','생년월일','성별','국적','자격취득일','자격상실일','취득일','상실일']);

  function formatDate(v){
    if (!v) return '';
    var p = v.split('-'), y = p[0], m = +p[1], d = +p[2], f = $('datefmt').value;
    if (f === 'kor') return y + '년 ' + m + '월 ' + d + '일';
    if (f === 'dash') return v;
    return y + '. ' + m + '. ' + d + '.';
  }
  function values(){
    return { name:$('name').value.trim(), rrn:$('rrn').value.trim(), phone:$('phone').value.trim(),
             address:$('address').value.trim(), date:formatDate($('date').value) };
  }
  function shown(key, v){
    if (key === 'rrn' && v && $('rrn').type === 'password') return v.replace(/(\d{6}-?\d)\d*$/, '$1******');
    return v;
  }

  // ===== 상태 =====
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var pdfBytes = null, pdfDoc = null, fileName = '', storeKey = '';
  var pageNo = 1, viewport = null, pageSizes = [];
  var place = {};       // key -> {page,x,y,cover,mode,fieldName,how}
  var armed = null;     // 위치 지정 대기 중인 항목 key
  var textCache = {}, widgets = [];

  function fmtSize(n){ return n > 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.round(n/1024)+' KB'; }
  function showErr(msg){ var e = $('uerr'); e.textContent = msg || ''; e.hidden = !msg; }
  function lsGet(k){ try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch(e){ return null; } }
  function lsSet(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} }
  function save(){ if (storeKey) lsSet(storeKey, place); }

  // ===== 글자 위치 분석 =====
  function charsOf(items){
    var out = [];
    items.forEach(function(it){
      var s = it.str || ''; if (!s) return;
      var x = it.transform[4], y = it.transform[5];
      var h = it.height || Math.hypot(it.transform[2], it.transform[3]) || 10;
      var w = it.width || 0, n = s.length;
      for (var i = 0; i < n; i++) out.push({ ch:s[i], x0:x + w*i/n, x1:x + w*(i+1)/n, y:y, h:h });
    });
    return out;
  }
  function linesOf(items){
    var chars = charsOf(items).filter(function(c){ return c.h > 0; });
    chars.sort(function(a,b){ return b.y - a.y || a.x0 - b.x0; });
    var lines = [];
    chars.forEach(function(c){
      var L = lines.length ? lines[lines.length-1] : null;
      if (L && Math.abs(L.y - c.y) < Math.max(2, c.h*0.4)) L.chars.push(c);
      else lines.push({ y:c.y, chars:[c] });
    });
    lines.forEach(function(L){
      L.chars.sort(function(a,b){ return a.x0 - b.x0; });
      L.solid = L.chars.filter(function(c){ return !/\s/.test(c.ch); });
      L.str = L.solid.map(function(c){ return c.ch; }).join('');
    });
    return lines;
  }
  function startsLabel(str, i){
    for (var k = 0; k < ALLKW.length; k++) if (str.substr(i, ALLKW[k].length) === ALLKW[k]) return true;
    return false;
  }
  function findIn(lines, f, pageIdx){
    for (var k = 0; k < f.kw.length; k++){
      for (var l = 0; l < lines.length; l++){
        var L = lines[l], at = L.str.indexOf(f.kw[k]);
        if (at < 0) continue;
        var end = at + f.kw[k].length, last = L.solid[end-1];
        // 라벨 뒤 콜론·괄호 건너뛰기
        while (end < L.solid.length && /[:：)\]]/.test(L.solid[end].ch)) { last = L.solid[end]; end++; }
        var vals = [], prevX = last.x1;
        for (var j = end; j < L.solid.length; j++){
          var c = L.solid[j], gap = c.x0 - prevX;
          if (vals.length === 0 ? gap > 220 : gap > 24) break;
          if (startsLabel(L.str, j)) break;
          vals.push(c); prevX = c.x1;
        }
        var h = last.h;
        if (vals.length){
          var x0 = vals[0].x0, x1 = vals[vals.length-1].x1;
          return { page:pageIdx, x:x0, y:L.y, how:'auto', mode:'overlay',
                   cover:{ x:x0-1.5, y:L.y-h*0.28, w:x1-x0+3, h:h*1.25 } };
        }
        return { page:pageIdx, x:last.x1 + 12, y:L.y, how:'auto', mode:'overlay', cover:null };
      }
    }
    return null;
  }
  function norm(s){ return (s || '').replace(/[\s_\-.\[\]0-9]/g, ''); }
  function detect(){
    var res = {};
    FIELDS.forEach(function(f){
      // 1) PDF 입력 칸 이름으로 찾기
      for (var i = 0; i < widgets.length; i++){
        var w = widgets[i], nm = norm(w.name) + ' ' + norm(w.alt);
        if (f.kw.some(function(k){ return nm.indexOf(k) >= 0; })){
          res[f.key] = { page:w.page, x:w.rect[0]+2, y:w.rect[1]+(w.rect[3]-w.rect[1])*0.3, mode:'form', fieldName:w.name, how:'form', cover:null };
          return;
        }
      }
      // 2) 라벨 글자로 찾기
      for (var p = 1; p <= pdfDoc.numPages; p++){
        var r = findIn(textCache[p], f, p);
        if (r){ res[f.key] = r; return; }
      }
    });
    return res;
  }

  // ===== 파일 불러오기 =====
  async function handleFile(file){
    showErr('');
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { showErr('PDF 파일만 올릴 수 있어요.'); return; }
    if (file.size > 30*1048576) { showErr('파일이 너무 커요. 30MB 이하 파일을 올려주세요.'); return; }
    try {
      var buf = await file.arrayBuffer();
      var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
      var tc = {}, ws = [], sizes = [], chars = 0;
      for (var i = 1; i <= doc.numPages; i++){
        var pg = await doc.getPage(i);
        var c = await pg.getTextContent();
        c.items.forEach(function(it){ chars += (it.str || '').trim().length; });
        tc[i] = linesOf(c.items);
        sizes[i] = pg.view;
        (await pg.getAnnotations()).forEach(function(a){
          if (a.subtype === 'Widget' && a.fieldType === 'Tx' && a.fieldName) ws.push({ page:i, name:a.fieldName, alt:a.alternativeText || '', rect:a.rect });
        });
      }
      pdfBytes = new Uint8Array(buf.slice(0)); pdfDoc = doc; fileName = file.name;
      textCache = tc; widgets = ws; pageSizes = sizes; pageNo = 1; armed = null;
      storeKey = 'pos:' + file.name + ':' + file.size + ':' + doc.numPages;
      var saved = lsGet(storeKey);
      place = saved || detect();
      if (saved) Object.keys(place).forEach(function(k){ if (place[k] && place[k].how !== 'form') place[k].how = 'saved'; });

      $('fname').textContent = file.name + ' · ' + fmtSize(file.size) + ' · ' + doc.numPages + '쪽';
      $('drop').hidden = true; $('work').hidden = false; $('deskActions').hidden = false;
      $('pager').hidden = doc.numPages < 2;
      if (chars < 20 * doc.numPages && !ws.length)
        showErr('글자 정보가 거의 없는 PDF예요(스캔본으로 보여요). 자동으로 칸을 찾을 수 없으니 위치 지정으로 직접 놓아 주세요. 원래 값 지우기도 직접 놓은 항목에는 적용되지 않아요.');
      await renderPage();
      $('status').hidden = true;
    } catch (e) {
      showErr(e && e.name === 'PasswordException'
        ? '암호가 걸린 PDF예요. 암호를 해제한 파일을 올려주세요.'
        : '이 PDF를 읽지 못했어요. 파일이 손상되었거나 지원하지 않는 형식일 수 있어요.');
    }
  }
  ['file','file2'].forEach(function(id){ $(id).addEventListener('change', function(e){ handleFile(e.target.files[0]); e.target.value=''; }); });
  var dz = $('drop');
  ['dragenter','dragover'].forEach(function(n){ dz.addEventListener(n, function(e){ e.preventDefault(); dz.classList.add('drag'); }); });
  ['dragleave','drop'].forEach(function(n){ dz.addEventListener(n, function(e){ e.preventDefault(); dz.classList.remove('drag'); }); });
  dz.addEventListener('drop', function(e){ handleFile(e.dataTransfer.files[0]); });

  $('sample').addEventListener('click', async function(){
    try {
      var r = await fetch('assets/sample.pdf'); if (!r.ok) throw 0;
      var b = await r.blob();
      $('name').value = '이예시'; $('rrn').value = '850315-2345678'; $('phone').value = '010-2345-6789';
      $('address').value = '서울특별시 종로구 예시길 23, 4층'; $('exmark').hidden = false;
      await handleFile(new File([b], '예시_4대보험_신청서.pdf', { type:'application/pdf' }));
    } catch(e){ showErr('예시 신청서를 불러오지 못했어요. 가지고 있는 PDF로 해 주세요.'); }
  });
  ['name','rrn','phone','address'].forEach(function(id){ $(id).addEventListener('input', function(){ $('exmark').hidden = true; }); });

  $('redetect').addEventListener('click', function(){
    if (!pdfDoc) return; place = detect(); armed = null; save(); renderPage();
  });
  $('prev').addEventListener('click', function(){ if (pageNo > 1){ pageNo--; renderPage(); } });
  $('next').addEventListener('click', function(){ if (pdfDoc && pageNo < pdfDoc.numPages){ pageNo++; renderPage(); } });

  // ===== 미리보기 그리기 =====
  var rendering = null;
  async function renderPage(){
    if (!pdfDoc) return;
    var pg = await pdfDoc.getPage(pageNo);
    var base = pg.getViewport({ scale:1 });
    var avail = Math.max(280, $('stage').parentNode.clientWidth - 26);
    var css = Math.min(1.6, avail / base.width);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var vpHi = pg.getViewport({ scale: css * dpr });
    var cv = $('cv');
    if (rendering) { try { rendering.cancel(); } catch(e){} }
    cv.width = Math.floor(vpHi.width); cv.height = Math.floor(vpHi.height);
    cv.style.width = Math.floor(base.width * css) + 'px';
    viewport = pg.getViewport({ scale: css });
    rendering = pg.render({ canvasContext: cv.getContext('2d'), viewport: vpHi });
    try { await rendering.promise; } catch(e){ return; }
    rendering = null;
    $('pageno').textContent = pageNo + ' / ' + pdfDoc.numPages;
    drawPins(); drawChips();
  }
  TAEUI.toolShown = function(){ if (pdfDoc) renderPage(); };
  var rt; window.addEventListener('resize', function(){ clearTimeout(rt); rt = setTimeout(renderPage, 150); });

  function cssScale(){ return viewport ? viewport.scale : 1; }
  function drawPins(){
    var st = $('stage');
    Array.prototype.slice.call(st.querySelectorAll('.pin,.cover')).forEach(function(n){ n.remove(); });
    if (!viewport) return;
    var v = values(), s = cssScale(), size = +$('fsize').value;
    FIELDS.forEach(function(f){
      var p = place[f.key]; if (!p || p.page !== pageNo) return;
      if (p.cover){
        var a = viewport.convertToViewportPoint(p.cover.x, p.cover.y + p.cover.h), b = viewport.convertToViewportPoint(p.cover.x + p.cover.w, p.cover.y);
        var cd = document.createElement('div'); cd.className = 'cover';
        cd.style.left = Math.min(a[0],b[0])+'px'; cd.style.top = Math.min(a[1],b[1])+'px';
        cd.style.width = Math.abs(b[0]-a[0])+'px'; cd.style.height = Math.abs(b[1]-a[1])+'px';
        if (!$('cover').checked) cd.style.display = 'none';
        st.appendChild(cd);
      }
      var pt = viewport.convertToViewportPoint(p.x, p.y);
      var el = document.createElement('div');
      el.className = 'pin' + (p.mode === 'form' ? ' form' : '');
      el.style.fontSize = (size * s) + 'px';
      el.style.left = pt[0] + 'px';
      el.style.top = (pt[1] - size * s * 0.88) + 'px';
      el.textContent = shown(f.key, v[f.key]) || f.label;
      if (!v[f.key]) el.style.color = '#8a93a3';
      el.title = f.label;
      if (s >= 0.9) { var tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = f.label; el.appendChild(tag); }
      el.dataset.key = f.key;
      if (p.mode !== 'form') el.addEventListener('pointerdown', startDrag);
      st.appendChild(el);
    });
  }
  function statusText(p){
    if (!p) return '위치를 못 찾았어요';
    var where = pdfDoc && pdfDoc.numPages > 1 ? p.page + '쪽 · ' : '';
    if (p.mode === 'form') return where + 'PDF 입력 칸에 넣어요';
    if (p.how === 'manual') return where + '직접 놓은 위치';
    if (p.how === 'saved') return where + '지난번 맞춘 위치';
    return where + (p.cover ? '원래 값 자리에 바꿔 넣어요' : '라벨 옆에 넣어요');
  }
  function drawChips(){
    var ul = $('chips'); ul.innerHTML = '';
    FIELDS.forEach(function(f){
      var p = place[f.key];
      var li = document.createElement('li');
      li.className = 'chip' + (p ? ' ok' : '') + (armed === f.key ? ' armed' : '');
      li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="txt"><span class="nm"></span><span class="st"></span></span>';
      li.querySelector('.nm').textContent = f.label;
      li.querySelector('.st').textContent = armed === f.key ? '미리보기에서 시작할 곳을 누르세요' : statusText(p);
      var b = document.createElement('button'); b.type = 'button';
      b.textContent = armed === f.key ? '취소' : '위치 지정';
      b.addEventListener('click', function(){ armed = armed === f.key ? null : f.key; $('stage').classList.toggle('arming', !!armed); drawChips(); });
      li.appendChild(b);
      if (p){
        var x = document.createElement('button'); x.type = 'button'; x.textContent = '빼기';
        x.setAttribute('aria-label', f.label + ' 넣지 않기');
        x.addEventListener('click', function(){ delete place[f.key]; save(); drawPins(); drawChips(); });
        li.appendChild(x);
      }
      ul.appendChild(li);
    });
  }
  function localPoint(e){
    var r = $('cv').getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  $('stage').addEventListener('click', function(e){
    if (!armed || e.target.closest('.pin')) return;
    var lp = localPoint(e), pp = viewport.convertToPdfPoint(lp[0], lp[1] + (+$('fsize').value) * cssScale() * 0.35);
    var old = place[armed];
    place[armed] = { page:pageNo, x:pp[0], y:pp[1], mode:'overlay', how:'manual', cover: old && old.page === pageNo ? old.cover : null };
    armed = null; $('stage').classList.remove('arming'); save(); drawPins(); drawChips();
  });
  var drag = null;
  function startDrag(e){
    var el = e.currentTarget, k = el.dataset.key;
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    drag = { el:el, key:k, sx:e.clientX, sy:e.clientY, l:parseFloat(el.style.left), t:parseFloat(el.style.top) };
    el.addEventListener('pointermove', onDrag); el.addEventListener('pointerup', endDrag); el.addEventListener('pointercancel', endDrag);
  }
  function onDrag(e){ if (!drag) return; drag.el.style.left = (drag.l + e.clientX - drag.sx) + 'px'; drag.el.style.top = (drag.t + e.clientY - drag.sy) + 'px'; }
  function endDrag(e){
    if (!drag) return;
    var el = drag.el, k = drag.key, size = +$('fsize').value * cssScale();
    var moved = Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 2;
    el.removeEventListener('pointermove', onDrag); el.removeEventListener('pointerup', endDrag); el.removeEventListener('pointercancel', endDrag);
    drag = null;
    if (!moved) return;
    var pp = viewport.convertToPdfPoint(parseFloat(el.style.left), parseFloat(el.style.top) + size * 0.88);
    var p = place[k]; p.x = pp[0]; p.y = pp[1]; p.how = 'manual';
    save(); drawPins(); drawChips();
  }
  ['name','rrn','phone','address','date','datefmt','fsize','cover'].forEach(function(id){
    $(id).addEventListener(id === 'datefmt' || id === 'fsize' || id === 'cover' ? 'change' : 'input', drawPins);
  });

  // ===== PDF 만들기 =====
  function downloadPdf(bytes, name){
    var url = URL.createObjectURL(new Blob([bytes], { type:'application/pdf' }));
    var a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 30000);
  }
  var fontBytes = null;
  async function loadFont(){
    if (fontBytes) return fontBytes;
    var r = await fetch('assets/NotoSansKR-Regular.ttf');
    if (!r.ok) throw new Error('font');
    fontBytes = new Uint8Array(await r.arrayBuffer());
    return fontBytes;
  }
  function setStatus(title, body, bad){
    var s = $('status'); s.className = 'status' + (bad ? ' bad' : '');
    s.innerHTML = '<strong></strong><span></span>';
    s.querySelector('strong').textContent = title; s.querySelector('span').textContent = body || '';
    s.hidden = false;
  }

  $('make').addEventListener('click', async function(){
    var v = values();
    var empty = FIELDS.filter(function(f){ return !v[f.key]; }).map(function(f){ return f.label; });
    if (!pdfBytes) { setStatus('신청서 PDF가 필요해요', '오른쪽에서 기존 PDF 신청서를 먼저 올려주세요.', true); return; }
    if (empty.length) { setStatus('비어 있는 항목이 있어요', empty.join(', ') + '을(를) 입력해 주세요.', true); return; }
    var missing = FIELDS.filter(function(f){ return !place[f.key]; }).map(function(f){ return f.label; });
    var btn = this; btn.disabled = true; btn.textContent = 'PDF 만드는 중…';
    try {
      var fb = await loadFont();
      var PL = PDFLib;
      var doc = await PL.PDFDocument.load(pdfBytes, { ignoreEncryption:true });
      doc.registerFontkit(fontkit);
      var font = await doc.embedFont(fb, { subset:true });
      var pages = doc.getPages(), size = +$('fsize').value, useCover = $('cover').checked;
      var form = null, formUsed = false;
      FIELDS.forEach(function(f){
        var p = place[f.key]; if (!p) return;
        if (p.mode === 'form'){
          try { form = form || doc.getForm(); form.getTextField(p.fieldName).setText(v[f.key]); formUsed = true; return; }
          catch(e){ /* 입력 칸을 못 쓰면 글자로 얹기 */ }
        }
        var pg = pages[p.page - 1]; if (!pg) return;
        if (useCover && p.cover) pg.drawRectangle({ x:p.cover.x, y:p.cover.y, width:p.cover.w, height:p.cover.h, color:PL.rgb(1,1,1) });
        pg.drawText(v[f.key], { x:p.x, y:p.y, size:size, font:font, color:PL.rgb(0.07,0.07,0.09) });
      });
      if (formUsed) form.updateFieldAppearances(font);
      var out = await doc.save();
      var outName = (fileName.replace(/\.pdf$/i, '') + '_' + v.name).replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
      downloadPdf(out, outName);
      var note = missing.length ? '위치가 없어 빠진 항목: ' + missing.join(', ') : '';
      try {
        await TAEUI.api('logCreate', { employeeName: v.name, rrn: v.rrn, fileName: outName, sourceName: fileName });
        setStatus('PDF를 내려받았어요', outName + (note ? ' · ' + note : '') + ' · 작성 이력에 기록했어요.');
      } catch(e) {
        setStatus('PDF는 내려받았지만 이력은 기록하지 못했어요', e.message + (note ? ' · ' + note : ''), true);
      }
    } catch(e) {
      setStatus('PDF를 만들지 못했어요', e && e.message === 'font' ? '한글 글꼴을 불러오지 못했어요. 페이지를 새로 고친 뒤 다시 시도해 주세요.' : '이 PDF는 수정할 수 없는 형식이에요. 다른 파일로 시도해 주세요.', true);
    } finally {
      btn.disabled = false; btn.textContent = 'PDF 생성';
    }
  });
})();

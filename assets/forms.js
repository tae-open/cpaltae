/* 서류 자동작성 — 원래 Python 프로그램(app/pdf_fill.py, seal_place.py, stamp_image.py, bundles.py)을 브라우저로 옮긴 것.
 *
 * - 서식: assets/forms/*.pdf (빈 서식, 지문 sha256 확인 후 사용). 원본 PDF 는 쓰지 않음.
 * - 칸 좌표·날인칸·서식에 인쇄된 글자(도장이 피해야 할 글자) 위치: assets/forms/specs.json
 *   (원래 프로그램의 서식 분석 결과를 tools/export_specs.py 로 내보낸 것 — 서식이 바뀌면 다시 내보냄)
 * - 좌표는 원래 프로그램과 같이 왼쪽 위가 (0,0), 아래로 갈수록 y 가 커짐(pt). pdf-lib 에 쓸 때만 뒤집음.
 * - 입력값·신분증·만든 PDF 는 이 브라우저 메모리에만 있음 — 서버로 보내지 않음.
 * - 만든 뒤 칸마다 써 넣은 글자를 다시 읽어 입력과 같은지 확인하고, 다르면 내보내지 않음.
 */
(function(){
  'use strict';
  var MIN_FONT = 5.0, LINE_GAP = 1.2;
  var MARGIN = 0.6;                       // 도장과 장애물 사이 간격(pt)
  var A4 = [595, 842], IMAGE_MARGIN = 36; // 신분증 쪽
  var STAMP = { widthRatio: 0.75, size: 200, border: 6, fontSize: 40, color: '#dc3545', spacing: 1.2, k: 8 };
  var GENERIC = ['nps_certificate','nts_civil_request','nts_power_of_attorney','comwel_certificate','comwel_4insure_poa'];
  var FORM7 = 'nts_withholding_receipt';
  var SUBMIT_TO = '근로복지공단';
  var FORM7_ETC_DETAIL = '일용근로소득 지급명세서 상세내역, 2006~현재, 1매';

  function GenerationError(msg){ var e = new Error(msg); e.name = 'GenerationError'; return e; }

  // ===== 자료 불러오기 =====
  var assets = null;
  async function sha256Hex(bytes){
    var h = await crypto.subtle.digest('SHA-256', bytes);
    return Array.prototype.map.call(new Uint8Array(h), function(b){ return b.toString(16).padStart(2,'0'); }).join('');
  }
  async function fetchBytes(url){
    var r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) throw GenerationError('서식 파일을 불러오지 못했어요(' + url.split('/').pop() + '). 페이지를 새로 고친 뒤 다시 시도해 주세요.');
    return new Uint8Array(await r.arrayBuffer());
  }
  async function loadAssets(base){
    if (assets) return assets;
    base = base || 'assets/';
    var specs = await (await fetch(base + 'forms/specs.json', { cache: 'no-cache' })).json();
    var keys = Object.keys(specs.forms);
    var files = await Promise.all(keys.map(function(k){ return fetchBytes(base + 'forms/' + specs.forms[k].file); }));
    var templates = {};
    for (var i = 0; i < keys.length; i++){
      if (await sha256Hex(files[i]) !== specs.forms[keys[i]].sha256)
        throw GenerationError(specs.forms[keys[i]].num + '번 서식 파일이 검증된 상태와 달라요. 관리자에게 문의해 주세요.');
      templates[keys[i]] = files[i];
    }
    var font = await fetchBytes(base + 'NotoSansKR-Regular.ttf');
    assets = { specs: specs, templates: templates, font: font, measure: fontkit.create(font) };
    return assets;
  }

  // ===== 글자 폭과 줄 맞춤 (pdf_fill._wrap, _fit, _write) =====
  function textLength(s, size){
    if (!s) return 0;
    var run = assets.measure.layout(s);
    var adv = 0; for (var i = 0; i < run.positions.length; i++) adv += run.positions[i].xAdvance;
    return adv / assets.measure.unitsPerEm * size;
  }
  function wrap(text, linesMax, width, size){
    var fits = function(s){ return textLength(s, size) <= width; };
    var lines = [], cur = '';
    var words = text.split(' ');
    for (var w = 0; w < words.length; w++){
      var word = words[w], trial = cur ? cur + ' ' + word : word;
      if (fits(trial)) { cur = trial; continue; }
      if (cur) lines.push(cur);
      cur = '';
      for (var c = 0; c < word.length; c++){
        var ch = word[c];
        if (fits(cur + ch)) cur += ch; else { lines.push(cur); cur = ch; }
      }
    }
    lines.push(cur);
    return lines.length <= linesMax && lines.every(fits) ? lines : null;
  }
  function fit(text, r, start){
    var h = r[3] - r[1], wdt = r[2] - r[0], size = start;
    while (size >= MIN_FONT){
      var nmax = Math.max(1, Math.floor(h / (size * LINE_GAP)));
      for (var n = 1; n <= nmax; n++){
        var lines = wrap(text, n, wdt - 1, size);
        if (lines) return { size: size, lines: lines };
      }
      size -= 0.25;
    }
    return null;
  }
  function union(a, b){ return a ? [Math.min(a[0],b[0]), Math.min(a[1],b[1]), Math.max(a[2],b[2]), Math.max(a[3],b[3])] : b; }

  /** 칸에 글자를 쓰고 쓴 영역을 돌려줌. 칸을 넘치면 오류. ops 에 그릴 내용만 모음(나중에 pdf-lib 로 그림). */
  function write(ops, field, text){
    if (!text) return null;
    var r = field.rect, h = r[3] - r[1];
    var start = Math.min(Math.max(+(field.font_size || 10), h * 0.9), h * 1.05, 10.5);
    var fitted = fit(text, r, start);
    if (!fitted) throw GenerationError("'" + field.label + "' 칸에 입력값이 너무 길어 칸 안에 넣을 수 없어요. 줄여서 입력해 주세요.");
    var mid = (r[1] + r[3]) / 2, box = null, n = fitted.lines.length, size = fitted.size;
    fitted.lines.forEach(function(line, i){
      var width = textLength(line, size), x;
      if (field.align === 'center') x = r[0] + (r[2] - r[0] - width) / 2;
      else if (field.align === 'right') x = r[2] - width;
      else x = r[0] + 1;
      var y = mid + (i - (n - 1) / 2) * size * LINE_GAP + size * 0.36;
      ops.push({ page: field.page, text: line, x: x, y: y, size: size });
      box = union(box, [x, y - size * 0.85, x + width, y + size * 0.2]);
    });
    return box;
  }
  /** 서식에 인쇄된 글자(예: '~') 앞뒤에 나눠 씀 — '1983~현재' → '1983' + (인쇄된 ~) + '현재'. */
  function writeAround(ops, field, text, printed){
    if (text.split(printed.mark).length !== 2) throw GenerationError("'" + field.label + "' 칸의 인쇄된 '" + printed.mark + "' 를 확인하지 못해 생성을 중단했어요.");
    var parts = text.split(printed.mark), r = field.rect, m = printed.rect;
    var boxes = [
      write(ops, Object.assign({}, field, { rect: [r[0], r[1], m[0] - 1.5, r[3]], align: 'right' }), parts[0]),
      write(ops, Object.assign({}, field, { rect: [m[2] + 1.5, r[1], r[2], r[3]], align: 'left' }), parts[1])
    ].filter(Boolean);
    return boxes.length ? union(boxes[0], boxes[boxes.length - 1]) : null;
  }

  // ===== 막도장 (stamp_image.make_stamp) =====
  var STAMP_FONT = '"Malgun Gothic", "맑은 고딕", "Noto Sans KR", sans-serif';
  async function makeStamp(name, who, cache){
    var chars = Array.from((name || '').trim()).filter(function(c){ return !/\s/.test(c); });
    if (!chars.length) throw GenerationError(who + ' 성명이 없어 막도장을 만들 수 없어요.');
    var key = chars.join('');
    if (cache[key]) return cache[key];
    var k = STAMP.k, size = STAMP.size * k, border = STAMP.border * k;
    var rx = size / 2 * STAMP.widthRatio, ry = size / 2, pad = border;
    var w = Math.floor(2 * rx + 2 * pad), h = Math.floor(2 * ry + 2 * pad);
    var fontPx = STAMP.fontSize * k, inner = (2 * ry - 2 * border) * 0.85;
    while (fontPx > 8 * k && fontPx * (STAMP.spacing * (chars.length - 1) + 1) > inner) fontPx -= k;
    try { await document.fonts.load('700 ' + Math.round(fontPx) + 'px "Noto Sans KR"', key); } catch(e) {}
    var big = document.createElement('canvas'); big.width = w; big.height = h;
    var g = big.getContext('2d');
    g.strokeStyle = STAMP.color; g.fillStyle = STAMP.color; g.lineWidth = border;
    g.beginPath(); g.ellipse(w / 2, h / 2, rx, ry, 0, 0, Math.PI * 2); g.stroke();
    g.font = '700 ' + Math.round(fontPx) + 'px ' + STAMP_FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    var step = fontPx * STAMP.spacing, top = h / 2 - step * (chars.length - 1) / 2;
    chars.forEach(function(ch, i){ g.fillText(ch, w / 2, top + step * i); });
    // 반으로 줄여 가장자리를 매끄럽게 한 뒤 투명한 가장자리를 잘라냄
    var sw = Math.floor(w / 2), sh = Math.floor(h / 2);
    var small = document.createElement('canvas'); small.width = sw; small.height = sh;
    var s = small.getContext('2d'); s.imageSmoothingQuality = 'high'; s.drawImage(big, 0, 0, sw, sh);
    var px = s.getImageData(0, 0, sw, sh).data, x0 = sw, y0 = sh, x1 = -1, y1 = -1;
    for (var y = 0; y < sh; y++) for (var x = 0; x < sw; x++) if (px[(y * sw + x) * 4 + 3]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    var cw = x1 - x0 + 1, ch2 = y1 - y0 + 1;
    var out = document.createElement('canvas'); out.width = cw; out.height = ch2;
    out.getContext('2d').drawImage(small, -x0, -y0);
    var blob = await new Promise(function(res){ out.toBlob(res, 'image/png'); });
    var stamp = { png: new Uint8Array(await blob.arrayBuffer()), ratio: cw / ch2, dataUrl: out.toDataURL('image/png') };
    cache[key] = stamp;
    return stamp;
  }

  // ===== 날인 위치 (seal_place.plan / place) =====
  function intersects(a, b){ return Math.max(a[0], b[0]) < Math.min(a[2], b[2]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3]); }
  function contains(a, b){ return a[0] <= b[0] && b[2] <= a[2] && a[1] <= b[1] && b[3] <= a[3]; }
  function planSeal(slot, ratio, filled){
    var size = slot.base, ax = slot.anchor[0], ay = slot.anchor[1];
    var obstacles = slot.obstacles.concat((filled || []).filter(function(r){ return intersects(r, slot.reach); }));
    var free = function(rect){
      var grown = [rect[0] - MARGIN, rect[1] - MARGIN, rect[2] + MARGIN, rect[3] + MARGIN];
      return contains(slot.page_box, rect) && !obstacles.some(function(o){ return intersects(grown, o); });
    };
    var width = size * ratio, steps = [0];
    for (var k = 1; k <= Math.floor(size / 4); k++) steps.push(-k, k);
    var dxs = [0, -2, 2, -4, 4, -6, 6, -8, 8];
    for (var i = 0; i < steps.length; i++) for (var j = 0; j < dxs.length; j++){
      var cx = ax + dxs[j], cy = ay + steps[i];
      var rect = [cx - width / 2, cy - size / 2, cx + width / 2, cy + size / 2];
      if (free(rect)) return rect;
    }
    throw GenerationError("날인칸 '" + slot.label + "' 주변에 글자·표와 겹치지 않을 공간이 없어 도장을 넣지 않았어요.");
  }
  function placeSeal(slot, ratio, filled){
    var ref = planSeal(slot, ratio, filled), size = slot.size;
    var cx = (ref[0] + ref[2]) / 2, cy = (ref[1] + ref[3]) / 2, w = size * ratio;
    return { rect: [cx - w / 2, cy - size / 2, cx + w / 2, cy + size / 2], ref: ref };
  }

  // ===== 값 정하기 (pdf_fill._source_value, build_form7 의 values) =====
  function birth(rrn){
    var d = (rrn || '').replace(/-/g, '');
    if (d.length < 7 || !/^\d{7}/.test(d)) return '';
    var century = { '1':1900, '2':1900, '5':1900, '6':1900, '3':2000, '4':2000, '7':2000, '8':2000 }[d[6]] || 1800;
    var y = century + +d.slice(0,2), m = +d.slice(2,4), day = +d.slice(4,6);
    var dt = new Date(Date.UTC(y, m - 1, day));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return '';
    return y + '.' + String(m).padStart(2,'0') + '.' + String(day).padStart(2,'0');
  }
  function sourceValue(source, dg, de, d, firm){
    if (source.indexOf('fixed:') === 0) return source.slice(6);
    var v = {
      'client.name': dg.name, 'client.rrn': dg.rrn, 'client.phone': dg.phone, 'client.full_address': dg.address,
      'client.birth': birth(dg.rrn),
      'agent.name': de.name, 'agent.rrn': de.rrn, 'agent.phone': de.phone, 'agent.birth': birth(de.rrn), 'agent.relation': '대리인',
      'applicant.name': de.name, 'applicant.rrn': de.rrn, 'applicant.phone': de.phone,
      'case.date.year': String(d.y), 'case.date.month': String(d.m), 'case.date.day': String(d.d),
      'case.date.month_2digit': String(d.m).padStart(2,'0'),
      'case.submit_to': SUBMIT_TO,
      'firm.fax': firm.fax, 'firm.name': firm.name, 'firm.address': firm.address
    };
    return v[source] || '';   // 입력받지 않는 정보(사업장, 관할 기관 등)는 빈칸
  }
  function form7Values(dg, de, d){
    return {
      'taxpayer.name': dg.name, 'taxpayer.rrn': dg.rrn, 'taxpayer.address': dg.address, 'taxpayer.mobile': dg.phone,
      'submit_to': SUBMIT_TO,
      'date.year': String(d.y), 'date.month': String(d.m), 'date.day': String(d.d),
      'taxpayer.sign_name': dg.name, 'office': '',
      'poa.date.year': String(d.y), 'poa.date.month': String(d.m).padStart(2,'0'), 'poa.date.day': String(d.d),
      'poa.taxpayer_name': dg.name, 'poa.agent.name': de.name, 'poa.agent.rrn': de.rrn, 'poa.agent.phone': de.phone,
      'consent.taxpayer_name': dg.name, 'consent.agent_name': de.name,
      'etc.detail': FORM7_ETC_DETAIL   // 기타 민원 '기타 ( )' 칸 (2026-11-23 요청)
    };
  }

  // ===== 서식 하나 만들기 =====
  async function buildForm(key, dg, de, d, stampCache){
    var PL = PDFLib, spec = assets.specs.forms[key], firm = assets.specs.firm, rules = spec.rules;
    var byKey = {}; spec.fields.forEach(function(f){ byKey[f.key] = f; });
    var ops = [], written = {}, filled = {};
    var entries;
    if (key === FORM7) {
      var v7 = form7Values(dg, de, d);
      entries = Object.keys(v7).map(function(k){ return [byKey[k], String(v7[k]).trim()]; });
    } else {
      entries = spec.fields.filter(function(f){ return rules.skip_fields.indexOf(f.key) < 0; }).map(function(f){
        var text = f.key in rules.values ? rules.values[f.key] : sourceValue(rules.sources[f.key] || f.source, dg, de, d, firm).trim();
        return [f, text];
      });
    }
    entries.forEach(function(e){
      var f = e[0], text = e[1];
      var box = spec.printed[f.key] ? writeAround(ops, f, text, spec.printed[f.key]) : write(ops, f, text);
      if (box) { written[f.key] = text; (filled[f.page] = filled[f.page] || []).push(box); }
    });

    var stamps = { client: await makeStamp(dg.name, '위임자', stampCache), agent: await makeStamp(de.name, '수임자', stampCache) };
    stamps.applicant = stamps.agent;   // 대리 신청: 신청인 = 수임자
    var seals = [];
    spec.seal_slots.forEach(function(slot){
      var st = stamps[slot.signer];
      if (!st) throw GenerationError("날인칸 '" + slot.label + "' 의 날인자를 정할 수 없어 생성을 중단했어요.");
      var placed = placeSeal(slot, st.ratio, filled[slot.page]);
      (filled[slot.page] = filled[slot.page] || []).push(placed.ref);   // 다음 도장이 이 자리와 겹치지 않게
      seals.push({ page: slot.page, rect: placed.rect, signer: slot.signer === 'applicant' ? 'agent' : slot.signer, label: slot.label, size: slot.size, stamp: st });
    });

    // 그리기
    var doc = await PL.PDFDocument.load(assets.templates[key], { updateMetadata: false });
    doc.registerFontkit(fontkit);
    var font = await doc.embedFont(assets.font, { subset: true });
    var pages = doc.getPages(), images = {};
    ops.forEach(function(o){
      var H = spec.pages[o.page][1];
      pages[o.page].drawText(o.text, { x: o.x, y: H - o.y, size: o.size, font: font, color: PL.rgb(0, 0, 0) });
    });
    for (var i = 0; i < seals.length; i++){
      var s = seals[i], H2 = spec.pages[s.page][1];
      var img = images[s.stamp.dataUrl] || (images[s.stamp.dataUrl] = await doc.embedPng(s.stamp.png));
      pages[s.page].drawImage(img, { x: s.rect[0], y: H2 - s.rect[3], width: s.rect[2] - s.rect[0], height: s.rect[3] - s.rect[1] });
    }
    var bytes = await doc.save({ useObjectStreams: false });

    // 검사(build_generic / _verify_form7 와 같은 기준)
    Object.keys(rules.fixed_checks || {}).forEach(function(k){
      if (written[k] !== rules.fixed_checks[k]) throw GenerationError("고정값 '" + rules.fixed_checks[k] + "' 이 들어가지 않았어요.");
    });
    (rules.same_values || []).forEach(function(p){
      if (written[p[0]] !== written[p[1]]) throw GenerationError("'" + byKey[p[0]].label + "' 칸과 '" + byKey[p[1]].label + "' 칸의 내용이 달라 생성을 중단했어요.");
    });
    if (key === FORM7 && written['submit_to'] !== SUBMIT_TO) throw GenerationError("제출처가 고정값('근로복지공단')과 달라요.");
    seals.forEach(function(s){
      if (Math.abs((s.rect[3] - s.rect[1]) - s.size) > 0.05) throw GenerationError("날인칸 '" + s.label + "' 의 막도장 크기가 정해진 크기와 달라 생성을 중단했어요.");
    });
    await verifyText(bytes, spec, written, byKey);
    return { bytes: bytes, pages: pages.length, seals: seals.map(function(s){ return { page: s.page, rect: s.rect, signer: s.signer, label: s.label, size: s.size }; }) };
  }

  /** 만든 PDF 에서 칸마다 글자를 다시 읽어 써 넣은 값과 같은지 확인(이전 정보가 섞이지 않게). */
  async function verifyText(bytes, spec, written, byKey){
    var pdf = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    var chars = {};
    for (var p = 0; p < spec.pages.length; p++){
      var page = await pdf.getPage(p + 1), tc = await page.getTextContent(), H = spec.pages[p][1], list = [];
      tc.items.forEach(function(it){
        var s = it.str || ''; if (!s) return;
        var arr = Array.from(s), x = it.transform[4], base = H - it.transform[5], w = it.width;
        arr.forEach(function(c, i){ if (c.trim()) list.push({ cx: x + w * (i + 0.5) / arr.length, base: base, left: x + w * i / arr.length, ch: c }); });
      });
      chars[p] = list;
    }
    pdf.destroy();
    Object.keys(written).forEach(function(k){
      var f = byKey[k], r = f.rect, pad = 1;
      var found = chars[f.page].filter(function(c){ return r[0] - pad <= c.cx && c.cx < r[2] + pad && r[1] - pad <= c.base - 1 && c.base - 1 < r[3] + pad; });
      found.sort(function(a, b){ return a.base - b.base || a.left - b.left; });
      var lines = [];
      found.forEach(function(c){
        if (lines.length && c.base - lines[lines.length - 1].base < 2) lines[lines.length - 1].cs.push(c);
        else lines.push({ base: c.base, cs: [c] });
      });
      var got = lines.map(function(l){ return l.cs.sort(function(a, b){ return a.left - b.left; }).map(function(c){ return c.ch; }).join(''); }).join('');
      if (got.replace(/\s/g, '') !== written[k].replace(/\s/g, ''))
        throw GenerationError(spec.num + "번 서식의 '" + f.label + "' 칸 내용이 입력과 달라 생성을 중단했어요.");
    });
  }

  // ===== 기관별 묶음 (bundles.build) =====
  async function buildBundle(bundleKey, forms, images){
    var PL = PDFLib, b = assets.specs.bundles[bundleKey];
    var out = await PL.PDFDocument.create({ updateMetadata: false }), captions = [];
    for (var i = 0; i < b.forms.length; i++){
      var key = b.forms[i], src = await PL.PDFDocument.load(forms[key].bytes, { updateMetadata: false });
      var copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach(function(pg, n){ out.addPage(pg); captions.push(assets.specs.forms[key].title + ' · ' + (n + 1) + '/' + copied.length + '쪽'); });
    }
    var missing = [];
    for (var j = 0; j < b.images.length; j++){
      var role = b.images[j], im = images[role];
      if (!im) { missing.push(assets.specs.images[role]); continue; }
      var emb = im.type === 'png' ? await out.embedPng(im.bytes) : await out.embedJpg(im.bytes);
      var page = out.addPage(A4), bw = A4[0] - 2 * IMAGE_MARGIN, bh = A4[1] - 2 * IMAGE_MARGIN;
      var sc = Math.min(bw / emb.width, bh / emb.height), w = emb.width * sc, h = emb.height * sc;
      var x = IMAGE_MARGIN + (bw - w) / 2, yTop = IMAGE_MARGIN + (bh - h) / 2;
      page.drawImage(emb, { x: x, y: A4[1] - yTop - h, width: w, height: h });
      captions.push(assets.specs.images[role]);
    }
    return { bytes: await out.save({ useObjectStreams: false }), captions: captions, missing: missing };
  }

  /** 1페이지 입력으로 서류 6종과 기관별 묶음을 모두 만듦. input = {date:'YYYY-MM-DD', delegator, delegatee, images:{delegator,delegatee}} */
  async function buildAll(input){
    await loadAssets();
    var p = input.date.split('-'), d = { y: +p[0], m: +p[1], d: +p[2] };
    var stampCache = {}, forms = {};
    var keys = GENERIC.concat([FORM7]);
    for (var i = 0; i < keys.length; i++) forms[keys[i]] = await buildForm(keys[i], input.delegator, input.delegatee, d, stampCache);
    var bundles = {};
    var bkeys = Object.keys(assets.specs.bundles);
    for (var j = 0; j < bkeys.length; j++) bundles[bkeys[j]] = await buildBundle(bkeys[j], forms, input.images || {});
    return { forms: forms, bundles: bundles };
  }

  // ===== 신분증 이미지 검사·정리 (attachments.clean_image) =====
  var MAX_BYTES = 10 * 1024 * 1024, MAX_PIXELS = 40000000;
  function ImageError(msg){ var e = new Error(msg); e.name = 'ImageError'; return e; }
  async function cleanImage(file){
    var ext = (file.name || '').split('.').pop().toLowerCase();
    if (['jpg','jpeg','png'].indexOf(ext) < 0) throw ImageError('JPG, JPEG, PNG 파일만 올릴 수 있어요.');
    if (!file.size) throw ImageError('이미지 파일이 비어 있어요.');
    if (file.size > MAX_BYTES) throw ImageError('이미지는 10MB 이하만 올릴 수 있어요.');
    var head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    var type = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF ? 'jpg'
             : head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47 ? 'png' : null;
    if (!type) throw ImageError('JPG, JPEG, PNG 이미지만 올릴 수 있어요. 파일 이름만 바꾼 파일은 올릴 수 없어요.');
    var bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch(e) { throw ImageError('이미지 파일이 손상되었거나 읽을 수 없어요. JPG 또는 PNG 파일을 올려 주세요.'); }
    if (bmp.width * bmp.height > MAX_PIXELS) { bmp.close && bmp.close(); throw ImageError('이미지가 너무 커요(4천만 화소 이하).'); }
    // 다시 그려 저장 → 촬영 위치·기기 정보 같은 메타데이터가 빠짐(회전은 반영)
    var c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    var g = c.getContext('2d');
    if (type === 'jpg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
    g.drawImage(bmp, 0, 0); bmp.close && bmp.close();
    var blob = await new Promise(function(res){ c.toBlob(res, type === 'jpg' ? 'image/jpeg' : 'image/png', 0.92); });
    if (!blob) throw ImageError('이미지를 처리하지 못했어요. 다른 파일로 시도해 주세요.');
    return { type: type, bytes: new Uint8Array(await blob.arrayBuffer()), w: c.width, h: c.height, url: URL.createObjectURL(blob),
             source: file };   // source: 글자 읽기용 원본(메모리에만, PDF 에는 정리된 bytes 를 씀)
  }

  window.TaeForms = { _specs: function(){ return assets && assets.specs; }, loadAssets: loadAssets, buildAll: buildAll, cleanImage: cleanImage, sha256Hex: sha256Hex,
                      birth: birth, _internals: { textLength: textLength, fit: fit, wrap: wrap, planSeal: planSeal } };
})();

"""7번 서식(국세 증명발급 등 민원신청서) 수정 — 2026-11-23 사용자 요청.

- '소득금액증명' 앞 ■ → □ (같은 글꼴의 □ 글자 코드로 바꿈, 모양·위치 그대로)
- 그 옆 '일용근로소득 지급명세서 (원천징수영수증) 상세내역', 증명기간 '1986~현재', 매수 '1' 지움
- '기타 민원'의 '기타' 앞 □ → ■ (같은 글꼴의 ■ 글자 코드)
- '기타 ( )' 안의 글자는 서식에 박지 않고 서류를 만들 때마다 써 넣음(assets/forms.js 의 etc.detail)
방법은 원래 프로그램의 tools/prepare_blank_templates.py 와 같음: 글자 명령에서 코드만 바꾸고 폭만큼 간격을 넣어
다른 글자 위치를 그대로 둠. 바꾼 칸 밖의 화면이 원래 서식과 픽셀 단위로 같아야 저장.

사용법(원래 프로그램 tae-pdf-system 폴더의 가상환경에서):
  python tools/edit_form7_etc.py <tae-pdf-system 폴더> <입력 PDF> <출력 PDF>
"""
import hashlib, sys
from collections import Counter
from pathlib import Path

SRC_ROOT, IN, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
sys.path.insert(0, str(SRC_ROOT))
import pikepdf, pymupdf  # noqa: E402
from PIL import Image, ImageChops, ImageDraw  # noqa: E402
from tools.pdf_text_ops import char_list, map_text_ops  # noqa: E402
from tools.prepare_blank_templates import probe_codes, find_donor, _strip_and_save, Failure  # noqa: E402

PAGE = 0
REMOVE = [pymupdf.Rect(163, 244, 336, 258),    # 일용근로소득 지급명세서 (원천징수영수증) 상세내역
          pymupdf.Rect(395, 244, 442, 258),    # 1986~현재
          pymupdf.Rect(499, 244, 508, 258)]    # 1
TO_EMPTY = pymupdf.Rect(92, 244, 102, 258)     # 소득금액증명 ■ → □
TO_FILLED = pymupdf.Rect(207, 405, 217, 419)   # 기타 민원 '기타' □ → ■

def inside(c, r):
    return r.x0 <= c[2] <= r.x1 and r.y0 <= c[1] <= r.y1

pt, base_counter, mapping = map_text_ops(IN, PAGE)
base = list(base_counter.elements())
targets = {}
for c in base:
    if any(inside(c, r) for r in REMOVE):
        targets[c] = "remove"
    elif inside(c, TO_EMPTY) and c[0] == "■":
        targets[c] = "□"
    elif inside(c, TO_FILLED) and c[0] == "□":
        targets[c] = "■"
removed_text = "".join(c[0] for c in sorted(base, key=lambda c: c[2]) if targets.get(c) == "remove")
print("지울 글자:", removed_text)
if list(targets.values()).count("□") != 1 or list(targets.values()).count("■") != 1:
    raise Failure("바꿀 네모를 정확히 찾지 못함")
if removed_text.replace(" ", "") != "일용근로소득지급명세서(원천징수영수증)상세내역1986~현재1":
    raise Failure("지울 글자가 예상과 다름")

ops = [i for i, gone in mapping.items() if any(c in targets for c in gone)]
replacements, swapped = {}, []
for i in ops:
    font_name, font = pt.state[i][0], pt.fonts[pt.state[i][0]]
    tokens, chars = probe_codes(pt, base_counter, i)
    new_tokens = []
    for (kind, val), c in zip(tokens, chars):
        act = targets.get(c) if kind == "c" else None
        if act == "remove":
            new_tokens.append(("n", pt.remove_number(i, val)))
        elif act in ("□", "■"):
            donor = find_donor(pt, base_counter, mapping, font_name, want=act)
            if donor is None:
                raise Failure(f"같은 글꼴에 {act} 글자가 없음")
            if abs(font.width(donor) - font.width(val)) > 1:
                raise Failure("네모 폭이 달라 옆 글자가 움직임")
            new_tokens += [("c", donor), ("n", pt.remove_number(i, val) - pt.remove_number(i, donor))]
            swapped.append((c, act))
        else:
            new_tokens.append((kind, val))
    replacements[i] = pt.build(i, new_tokens)
ins = pt.assemble(replacements)
after = Counter(char_list(pt.render(ins)[PAGE]))
removed, added = base_counter - after, after - base_counter
if removed != Counter(targets.keys()):
    raise Failure("지워진 글자가 대상과 다름")
if sorted((a[0], a[1], a[2]) for a in added.elements()) != sorted((act, c[1], c[2]) for c, act in swapped):
    raise Failure("네모 교체 결과가 예상과 다름(위치가 움직였거나 다른 글자가 생김)")

with pikepdf.open(IN) as pdf:
    pdf.pages[PAGE].Contents = pdf.make_stream(pikepdf.unparse_content_stream(ins))
    data = _strip_and_save(pdf)
src_doc, doc = pymupdf.open(IN), pymupdf.open(stream=data, filetype="pdf")
z = 150 / 72
for p in doc:
    a, b = src_doc[p.number].get_pixmap(dpi=150), p.get_pixmap(dpi=150)
    diff = ImageChops.difference(Image.frombytes("RGB", (a.width, a.height), a.samples),
                                 Image.frombytes("RGB", (b.width, b.height), b.samples)).convert("L")
    if p.number == PAGE:
        draw = ImageDraw.Draw(diff)
        for r in REMOVE + [TO_EMPTY, TO_FILLED]:
            draw.rectangle([(r.x0 - 1) * z, (r.y0 - 1) * z, (r.x1 + 1) * z, (r.y1 + 1) * z], fill=0)
    if diff.getbbox() is not None:
        raise Failure(f"{p.number + 1}쪽: 바꾼 칸 밖에서 화면이 달라짐")
OUT.write_bytes(data)
print("저장:", OUT, hashlib.sha256(data).hexdigest())

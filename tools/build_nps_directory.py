"""국민연금 관할지사·팩스 자료(CSV) → 웹 화면용 assets/nps/directory.json

원래 프로그램(tae-pdf-system)의 '국민연금 지사 관리'와 같은 규칙으로 읽습니다.
  - 공공데이터 지사 현황 파일: 지사 목록 + 대표 FAX (자동 입력에는 쓰지 않고 후보로만)
  - 관할구역+팩스(통합) CSV: 한 줄 = 관할구역 하나 + 그 지사의 가입지원부 팩스
    · 읍면동 빈칸 = 시군구 전체, 같은 관할구역이 두 번 있거나 같은 지사에 다른 번호가 있으면 중단
    · 팩스확인상태에 '검증 필요', '보류', '미확인' 등이 있으면 '(검증 필요)' 후보로만(자동 입력 안 함)
한 줄이라도 틀리면 파일을 만들지 않습니다. 개인정보는 들어 있지 않은 공개 자료입니다.

사용법(파이썬만 있으면 됨, 추가 설치 없음):
  python tools/build_nps_directory.py <공공데이터 지사현황.csv> <관할구역+팩스 통합.csv> assets/nps/directory.json
"""
import csv, io, json, re, sys
from datetime import date

OFFICIAL_PAGE = "https://www.nps.or.kr/pbcpgdnc/ognzprsn/getOHAG0012M0.do?menuId=MN24001022"
OFFICIAL_DATA = "https://www.data.go.kr/data/15010814/fileData.do"
AREAS_HEAD = ["지사명", "시도", "시군구", "읍면동", "출처", "확인일", "담당부서", "업무구분", "팩스번호", "팩스확인상태", "팩스번호출처"]
OFFICIAL_HEAD = ["순번", "지사(센터)명", "우편번호", "주소", "전화번호", "FAX"]
UNCONFIRMED_WORDS = ("검증 필요", "검증필요", "보류", "미확인", "확인 필요", "확인필요", "비공식", "민간")
SIDO = {
    "서울": "서울특별시", "서울시": "서울특별시", "서울특별시": "서울특별시",
    "부산": "부산광역시", "부산시": "부산광역시", "부산광역시": "부산광역시",
    "대구": "대구광역시", "대구시": "대구광역시", "대구광역시": "대구광역시",
    "인천": "인천광역시", "인천시": "인천광역시", "인천광역시": "인천광역시",
    "광주": "전남광주통합특별시", "광주광역시": "전남광주통합특별시",
    "대전": "대전광역시", "대전시": "대전광역시", "대전광역시": "대전광역시",
    "울산": "울산광역시", "울산시": "울산광역시", "울산광역시": "울산광역시",
    "세종": "세종특별자치시", "세종시": "세종특별자치시", "세종특별자치시": "세종특별자치시",
    "경기": "경기도", "경기도": "경기도",
    "강원": "강원특별자치도", "강원도": "강원특별자치도", "강원특별자치도": "강원특별자치도",
    "충북": "충청북도", "충청북도": "충청북도", "충남": "충청남도", "충청남도": "충청남도",
    "전북": "전북특별자치도", "전라북도": "전북특별자치도", "전북특별자치도": "전북특별자치도",
    "전남": "전남광주통합특별시", "전라남도": "전남광주통합특별시", "전남광주통합특별시": "전남광주통합특별시",
    "경북": "경상북도", "경상북도": "경상북도", "경남": "경상남도", "경상남도": "경상남도",
    "제주": "제주특별자치도", "제주도": "제주특별자치도", "제주특별자치도": "제주특별자치도",
}
COMWEL = {"name": "근로복지공단", "fax": "0505-055-3100", "source": "노무법인 태(泰) 지정 고정 번호(2026-10-24 요청)",
          "verified_on": "2026-10-24"}


class Bad(Exception):
    pass


def decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "cp949"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    raise Bad("파일 글자 형식(UTF-8 또는 CP949)을 읽을 수 없습니다.")


def text(v, where, required=True, limit=100):
    v = " ".join((v or "").split())
    if required and not v:
        raise Bad(f"{where}: 비울 수 없습니다.")
    if len(v) > limit:
        raise Bad(f"{where}: {limit}자 이내로 적어 주세요.")
    return v


def fax(v, where):
    v = (v or "").strip()
    if not re.fullmatch(r"0\d{1,3}-?\d{3,4}-?\d{4}", v):
        raise Bad(f"{where}: 팩스번호 형식이 올바르지 않습니다(예: 02-0000-0000).")
    return v


def day(v, where):
    try:
        d = date.fromisoformat((v or "").strip())
    except ValueError:
        raise Bad(f"{where}: 날짜는 YYYY-MM-DD 로 적어 주세요.")
    if d > date.today():
        raise Bad(f"{where}: 확인일이 오늘보다 뒤입니다.")
    return d.isoformat()


def rows_of(path, head):
    rows = list(csv.reader(io.StringIO(decode(open(path, "rb").read()))))
    got = [h.strip() for h in rows[0]] if rows else []
    if got != head:
        raise Bad(f"{path}: 머리글이 다릅니다. 필요한 머리글: {', '.join(head)}")
    return [(n, [c.strip() for c in r]) for n, r in enumerate(rows[1:], start=2) if any(c.strip() for c in r)]


def build(official_path, areas_path, official_date):
    branches = {}   # 이름 → {name, link, faxes, areas}
    for n, r in rows_of(official_path, OFFICIAL_HEAD):
        w = f"공공데이터 {n}번째 줄"
        name = text(r[1], f"{w} 지사명", limit=40)
        if name in branches:
            raise Bad(f"{w}: 같은 지사명이 두 번 있습니다.")
        branches[name] = {"name": name, "link": OFFICIAL_PAGE, "areas": [],
                          "faxes": [{"department": "대표(공공데이터)", "purpose": "대표", "fax": fax(r[5], f"{w} FAX"),
                                     "source": f"공공데이터포털 국민연금공단_지사 및 상담센터 현황({OFFICIAL_DATA})",
                                     "verified_on": official_date}]}
    seen, cert = set(), {}
    for n, r in rows_of(areas_path, AREAS_HEAD):
        w = f"관할구역 {n}번째 줄"
        if len(r) < 11:
            raise Bad(f"{w}: 칸 수가 모자랍니다(11칸).")
        name = text(r[0], f"{w} 지사명", limit=40)
        if name not in branches:
            raise Bad(f"{w}: 공공데이터 지사 목록에 없는 지사입니다({name}).")
        sido = SIDO.get(r[1])
        if not sido:
            raise Bad(f"{w}: 시도 이름을 확인해 주세요.")
        sigungu, dong = text(r[2], f"{w} 시군구", False, 30), text(r[3], f"{w} 읍면동", False, 30)
        if dong and not sigungu:
            raise Bad(f"{w}: 읍면동을 적으려면 시군구도 적어 주세요.")
        if (sido, sigungu, dong) in seen:
            raise Bad(f"{w}: 같은 관할구역이 두 번 있습니다({sido} {sigungu} {dong}).")
        seen.add((sido, sigungu, dong))
        d = day(r[5], f"{w} 확인일")
        text(r[4], f"{w} 출처", limit=200)
        branches[name]["areas"].append([sido, sigungu, dong, d])
        if r[8]:
            dept = text(r[6] or "가입지원부", f"{w} 담당부서", limit=30)
            ok = bool(r[9]) and not any(x in r[9] for x in UNCONFIRMED_WORDS)
            item = (dept, fax(r[8], f"{w} 팩스번호"), ok, text(r[10] or r[4], f"{w} 팩스번호출처", limit=200), d)
            if cert.setdefault(name, item)[:3] != item[:3]:
                raise Bad(f"{w}: 같은 지사({name})에 다른 팩스번호·확인상태가 적혀 있습니다.")
    for name, (dept, num, ok, src, d) in cert.items():
        branches[name]["faxes"].append({"department": dept if ok else dept + "(검증 필요)",
                                        "purpose": "가입증명" if ok else "기타", "fax": num, "source": src, "verified_on": d})
    used = [b for b in branches.values() if b["areas"]]
    return {"version": 1, "official_page": OFFICIAL_PAGE, "stale_days": 180,
            "summary": {"branches_with_areas": len(used), "areas": len(seen),
                        "confirmed_faxes": sum(1 for v in cert.values() if v[2]),
                        "held_faxes": sum(1 for v in cert.values() if not v[2]),
                        "no_fax": len(used) - len(cert)},
            "branches": list(branches.values()), "comwel": COMWEL}


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    m = re.search(r"(\d{4})(\d{2})(\d{2})", sys.argv[1])
    official_date = f"{m[1]}-{m[2]}-{m[3]}" if m else date.today().isoformat()
    try:
        data = build(sys.argv[1], sys.argv[2], official_date)
    except Bad as e:
        sys.exit(f"만들지 않았습니다 — {e}")
    with open(sys.argv[3], "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("완료:", data["summary"])

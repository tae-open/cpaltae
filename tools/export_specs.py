"""원래 Python 프로그램(tae-pdf-system)의 서식 분석 결과를 브라우저용으로 내보냄.
서식 PDF 나 form_specs.json 을 바꿨을 때만 다시 실행합니다.

사용법(원래 프로그램의 가상환경에서):
  python tools/export_specs.py <tae-pdf-system 폴더> <이 저장소의 assets/forms 폴더>
결과: assets/forms/specs.json 과 빈 서식 PDF 6개(지문 sha256 포함)
"""
import os,sys,json,hashlib,shutil
SRC=sys.argv[1]; OUT=sys.argv[2]
sys.path.insert(0,SRC)
from app import pdf_fill, seal_place, bundles
import pymupdf
os.makedirs(OUT,exist_ok=True)
R=lambda r:[round(float(v),3) for v in r]
out={"version":1,"firm":pdf_fill.FIRM,"forms":{}}
order=["nps_certificate","nts_civil_request","nts_power_of_attorney","comwel_certificate","comwel_4insure_poa","nts_withholding_receipt"]
for key in order:
    form=pdf_fill.FORMS[key]
    if key==pdf_fill.FORM7_KEY:
        path=pdf_fill._template(True); sha=hashlib.sha256(path.read_bytes()).hexdigest()
    else:
        path,sha=pdf_fill._generic_template(form)
    doc=pymupdf.open(path)
    pages=[]
    for p in doc:
        assert p.rotation==0 and p.mediabox.x0==0 and p.mediabox.y0==0 and p.cropbox==p.mediabox, key
        pages.append([p.rect.width,p.rect.height])
    fname=key+'.pdf'; shutil.copy(path,os.path.join(OUT,fname))
    checks=dict(pdf_fill._template_checks(str(path),sha,key))
    assert 'unclear' not in checks.values(), key
    slots=[]
    for slot in form["seal_slots"]:
        chars,lines=seal_place._template_obstacles(str(path),sha,slot["page"])
        ax,ay=slot["anchor"]
        anchor=[c for c in chars if c[0] in "인날" and abs((c[1].x0+c[1].x1)/2-ax)<6 and abs((c[1].y0+c[1].y1)/2-ay)<6]
        garbled=False
        if not anchor and slot.get("anchor_by_position"):
            anchor=[c for c in chars if abs((c[1].x0+c[1].x1)/2-ax)<1.5 and abs((c[1].y0+c[1].y1)/2-ay)<4]; garbled=True
        assert anchor, (key,slot["key"])
        base=anchor[0][2]
        same=sorted((c for c in chars if abs(c[2]-base)<2),key=lambda c:c[1].x0)
        lefts=[c for c in same if c[0]=="(" and c[1].x1<=ax]; rights=[c for c in same if c[0]==")" and c[1].x0>=ax]
        xf=lefts[-1][1].x0 if lefts else ax-20; xt=rights[0][1].x1 if rights else ax+20
        label={id(c) for c in same if xf-0.5<=c[1].x0 and c[1].x1<=xt+0.5 and (garbled or c[0] in seal_place.LABEL_CHARS)}
        bsize=seal_place.base_for(key,slot["key"])
        reach=pymupdf.Rect(ax,ay,ax,ay)+(-bsize-10,-bsize-10,bsize+10,bsize+10)
        obst=[R(c[1]) for c in chars if id(c) not in label and c[1].intersects(reach)]
        slots.append({"key":slot["key"],"label":slot["label"],"signer":slot["signer"],"page":slot["page"],
            "anchor":[ax,ay],"base":bsize,"size":seal_place.size_for(key,slot["key"]),"reach":R(reach),
            "page_box":R(seal_place._page_rect(str(path),sha,slot["page"])),"obstacles":obst})
    printed={}
    for fk,mark in pdf_fill.GENERIC_RULES.get(key,{}).get("around_printed",{}).items():
        f=pdf_fill._field(form,fk); r=pymupdf.Rect(f["rect"]); page=doc[f["page"]]
        found=[c for b in page.get_text("rawdict")["blocks"] for l in b.get("lines",[]) for s in l["spans"] for c in s["chars"] if c["c"]==mark and r.contains(pymupdf.Rect(c["bbox"]).tl+(0.5,0.5))]
        assert len(found)==1
        printed[fk]={"mark":mark,"rect":R(found[0]["bbox"])}
    rules=pdf_fill.GENERIC_RULES.get(key,{})
    out["forms"][key]={"num":bundles.FORMS[key][0],"title":bundles.FORMS[key][1],"file":fname,"sha256":sha,"pages":pages,
        "fields":[{k:f.get(k) for k in("key","page","rect","source","align","font_size","label")} for f in form["fields"]],
        "seal_slots":slots,"printed":printed,
        "rules":{"skip_fields":sorted(rules.get("skip_fields",[])),"sources":rules.get("sources",{}),"values":rules.get("values",{}),
                 "fixed_checks":rules.get("fixed_checks",{}),"same_values":rules.get("same_values",[])},
        "checked":sorted(f"{g}.{v}" for (g,v),s in checks.items() if s=="checked")}
out["bundles"]=bundles.BUNDLES; out["tabs"]=bundles.TABS; out["images"]=bundles.IMAGES
json.dump(out,open(os.path.join(OUT,'specs.json'),'w'),ensure_ascii=False,separators=(',',':'))
print('ok',os.path.getsize(os.path.join(OUT,'specs.json')))
for k,f in out["forms"].items(): print(k,len(f["fields"]),[ (s["key"],len(s["obstacles"])) for s in f["seal_slots"]],f["printed"])

#!/usr/bin/env python3
"""노무법인 태(泰) 팩스 중계 프로그램 — 클라우드 서버에서 상시 실행.

동작
  1) 10초마다 Apps Script(relay.poll)에 '보낼 팩스'를 물어봄 — 서버는 밖으로만 연결(들어오는 포트를 열 필요 없음)
  2) 받은 PDF 의 지문(SHA-256)을 확인하고 하나팩스 모듈의 전송 폴더에 저장한 뒤,
     하나팩스 모듈의 hfsenddata 표에 전송 요청 한 줄을 넣음(파일이 먼저 있어야 함 — 매뉴얼 1.6)
  3) Apps Script 에 'accepted'를 알리면 구글 드라이브의 임시 PDF 는 지워짐
  4) 하나팩스 모듈이 결과(intstate 3/4/5, strresultcode)를 적으면 Apps Script 에 'done'으로 알리고 PDF 파일을 지움

모드(설정 파일 MODE)
  dry-run : 하나팩스 표에 넣지 않고 전송 폴더에도 저장하지 않음. 받은 즉시 '802 완료'로 흉내 — 연결 시험용
  live    : 실제로 하나팩스 모듈에 넘김

설정 파일(기본 /etc/tae-fax-relay.conf, JSON): API_URL, RELAY_KEY, MODE, SEND_DIR, DB{host,port,user,password,name}, STATE_FILE
개인정보: PDF 내용·주민등록번호는 로그에 남기지 않음. PDF 는 결과가 나오면 바로 지움.
"""
import base64, hashlib, json, logging, os, signal, sys, time, urllib.request
from datetime import datetime

CONF_PATH = os.environ.get("TAE_RELAY_CONF", "/etc/tae-fax-relay.conf")
POLL_SECONDS = int(os.environ.get("TAE_RELAY_POLL", "10"))   # 시험할 때만 바꿈
RESULT_STATES = (3, 4, 5)   # 3 전송종료, 4 DB항목 오류, 5 서버 업로드 후 오류
log = logging.getLogger("relay")
running = True


def load_conf():
    with open(CONF_PATH, encoding="utf-8") as f:
        c = json.load(f)
    for k in ("API_URL", "RELAY_KEY", "MODE"):
        if not c.get(k):
            sys.exit(f"설정 파일 {CONF_PATH} 에 {k} 가 없습니다.")
    if c["MODE"] not in ("dry-run", "live"):
        sys.exit("MODE 는 dry-run 또는 live 여야 합니다.")
    c.setdefault("SEND_DIR", "/opt/hanafax/file/send")
    c.setdefault("STATE_FILE", "/var/lib/tae-fax-relay/pending.json")
    return c


def api(conf, payload, timeout=60):
    """Apps Script 웹 앱 호출(POST → 구글이 결과 주소로 넘겨 줌, urllib 가 따라감)."""
    body = json.dumps(dict(payload, key=conf["RELAY_KEY"])).encode()
    req = urllib.request.Request(conf["API_URL"], data=body, headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        res = json.loads(r.read().decode("utf-8"))
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "Apps Script 오류")
    return res


def load_state(conf):
    try:
        with open(conf["STATE_FILE"], encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(conf, state):
    os.makedirs(os.path.dirname(conf["STATE_FILE"]), exist_ok=True)
    tmp = conf["STATE_FILE"] + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, conf["STATE_FILE"])


def db(conf):
    import pymysql   # live 모드에서만 필요 (apt install python3-pymysql)
    d = conf["DB"]
    return pymysql.connect(host=d.get("host", "127.0.0.1"), port=int(d.get("port", 3306)), user=d["user"],
                           password=d["password"], database=d["name"], charset="utf8mb4", autocommit=True)


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")   # 서버 시간대는 Asia/Seoul 로 설정(설치 스크립트)


def accept(conf, state, job, sender):
    jid = job["job"]
    if jid in state:          # 이미 넘긴 건(재시작 등) — 다시 넣지 않음
        api(conf, {"action": "relay.report", "job": jid, "state": "accepted"})
        return
    pdf = base64.b64decode(job["pdfBase64"])
    if hashlib.sha256(pdf).hexdigest() != job["sha256"]:
        api(conf, {"action": "relay.report", "job": jid, "state": "failed", "message": "PDF 지문이 맞지 않음"})
        log.warning("작업 %s: PDF 지문 불일치 — 보내지 않음", jid)
        return
    if conf["MODE"] == "dry-run":
        state[jid] = {"dry": True, "pages": job.get("pages", 0)}
        save_state(conf, state)
        api(conf, {"action": "relay.report", "job": jid, "state": "accepted"})
        log.info("작업 %s: [dry-run] 받음 → %s (%s쪽) — 실제로 보내지 않음", jid, job["number"], job.get("pages"))
        return
    path = os.path.join(conf["SEND_DIR"], jid + ".pdf")
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(pdf)
    os.replace(tmp, path)
    with db(conf) as con, con.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM hfsenddata WHERE strsid=%s", (jid,))
        if cur.fetchone()[0] == 0:
            cur.execute("INSERT INTO hfsenddata (strsender_faxnum, strreceiver_faxnum, strsubject, intconvtif, strfilenames, "
                        "intfiles, intstate, strregdate, strsid, strcountrycode) VALUES (%s,%s,%s,1,%s,1,0,%s,%s,'82')",
                        (sender, job["number"], job.get("subject", "")[:90], jid + ".pdf", now_str(), jid))
    state[jid] = {"file": path}
    save_state(conf, state)
    api(conf, {"action": "relay.report", "job": jid, "state": "accepted"})
    log.info("작업 %s: 하나팩스 모듈에 넘김 → %s (%s쪽)", jid, job["number"], job.get("pages"))


def collect_results(conf, state):
    if not state:
        return
    if conf["MODE"] == "dry-run":
        for jid, s in list(state.items()):
            if s.get("dry"):
                api(conf, {"action": "relay.report", "job": jid, "state": "done", "code": "802", "pages": s.get("pages", 0),
                           "start": now_str(), "end": now_str(), "dryRun": True})
                del state[jid]
                log.info("작업 %s: [dry-run] 완료로 알림", jid)
        save_state(conf, state)
        return
    ids = list(state.keys())
    with db(conf) as con, con.cursor() as cur:
        cur.execute("SELECT strsid, intstate, strresultcode, intsentpages, strstarttime, strendtime FROM hfsenddata "
                    "WHERE strsid IN (" + ",".join(["%s"] * len(ids)) + ")", ids)
        rows = cur.fetchall()
    for sid, st, code, pages, start, end in rows:
        if st not in RESULT_STATES:
            continue
        code = (code or "").strip() or {4: "814", 5: "815"}.get(st, "808")
        api(conf, {"action": "relay.report", "job": sid, "state": "done", "code": code, "pages": pages or 0,
                   "start": start or "", "end": end or ""})
        f = state.pop(sid, {}).get("file")
        if f and os.path.exists(f):
            os.remove(f)   # 결과가 나온 PDF 는 서버에 남기지 않음
        log.info("작업 %s: 결과 %s 알림", sid, code)
    save_state(conf, state)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    conf = load_conf()
    state = load_state(conf)
    log.info("팩스 중계 시작 — 모드 %s, 대기 중인 작업 %d건", conf["MODE"], len(state))

    def stop(*_):
        global running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    wait = POLL_SECONDS
    while running:
        try:
            res = api(conf, {"action": "relay.poll"})
            for job in res.get("jobs", []):
                try:
                    accept(conf, state, job, res.get("sender") or "07079665797")
                except Exception as e:   # 한 건이 실패해도 다른 건은 계속
                    log.error("작업 %s 처리 실패: %s", job.get("job"), e)
                    try:
                        api(conf, {"action": "relay.report", "job": job["job"], "state": "failed", "message": str(e)[:100]})
                    except Exception:
                        pass
            collect_results(conf, state)
            wait = POLL_SECONDS
        except Exception as e:
            log.error("Apps Script 연결 실패: %s — %d초 뒤 다시 시도", e, wait)
            wait = min(wait * 2, 300)
        for _ in range(wait):
            if not running:
                break
            time.sleep(1)
    log.info("팩스 중계 종료")


if __name__ == "__main__":
    main()

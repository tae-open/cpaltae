#!/usr/bin/env bash
# 노무법인 태(泰) 팩스 중계 서버 설치 — Ubuntu 22.04/24.04 (AWS Lightsail 서울)
#
# 서버 접속 화면(Lightsail 의 '브라우저로 연결')에서 한 줄로 실행:
#   curl -fsSL https://raw.githubusercontent.com/tae-open/cplatae/main/fax-relay/setup_server.sh | sudo bash
#
# 하는 일
#   1) 시간대 Asia/Seoul, 자바(하나팩스 모듈용), MariaDB(하나팩스 전송표), 파이썬 MySQL 연결 도구 설치
#   2) hanafax 데이터베이스·전용 DB 계정 만들기(비밀번호는 무작위로 만들어 /etc/tae-fax-relay.conf 에만 저장)
#   3) 하나팩스 모듈 내려받아 /opt/hanafax 에 풀기 (모듈의 계정·DB 연결 설정은 하나팩스 안내에 따라 따로 — 아래 출력 참고)
#   4) 중계 프로그램을 /opt/tae-fax-relay 에 두고, 시스템 서비스로 등록(dry-run 모드로 시작)
#   5) 중계 비밀키를 만들어 화면에 한 번 보여 줌 → Apps Script 스크립트 속성 RELAY_KEY 에 넣기
# 여러 번 실행해도 안전합니다(이미 있는 비밀번호·비밀키는 그대로 둠).
set -euo pipefail

SITE="${TAE_SITE:-https://tae-open.github.io/cplatae/}"
RAW="${TAE_RAW:-https://raw.githubusercontent.com/tae-open/cplatae/main/fax-relay}"
CONF=/etc/tae-fax-relay.conf

if [ "$(id -u)" -ne 0 ]; then echo "sudo 로 실행해 주세요."; exit 1; fi
echo "== 1/5 기본 프로그램 설치"
timedatectl set-timezone Asia/Seoul || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openjdk-17-jre-headless mariadb-server python3-pymysql unzip curl >/dev/null
systemctl enable --now mariadb >/dev/null

echo "== 2/5 하나팩스 모듈 내려받기"
id hanafax >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/hanafax --shell /usr/sbin/nologin hanafax
mkdir -p /opt/hanafax/file/send /opt/hanafax/file/recv /opt/hanafax/file/conv
if [ ! -d /opt/hanafax/config ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/hanafax.zip" https://b2b.hanafax.com/down/hanafax.zip
  unzip -q "$tmp/hanafax.zip" -d "$tmp/x"
  inner=$(find "$tmp/x" -maxdepth 2 -type d -name config -printf '%h\n' | head -1)
  cp -a "${inner:-$tmp/x}/." /opt/hanafax/
  rm -rf "$tmp"
fi
chown -R hanafax:hanafax /opt/hanafax
chmod 700 /opt/hanafax/config /opt/hanafax/sql 2>/dev/null || true

echo "== 3/5 데이터베이스 준비"
if [ ! -f "$CONF" ]; then
  DBPASS=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  KEY=$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
  API=$(curl -fsSL "${SITE}config.js" | sed -n "s/.*API_URL: *'\([^']*\)'.*/\1/p" | head -1)
  cat > "$CONF" <<EOF
{
  "API_URL": "${API}",
  "RELAY_KEY": "${KEY}",
  "MODE": "dry-run",
  "SEND_DIR": "/opt/hanafax/file/send",
  "STATE_FILE": "/var/lib/tae-fax-relay/pending.json",
  "DB": {"host": "127.0.0.1", "port": 3306, "user": "hanafax", "password": "${DBPASS}", "name": "hanafax"}
}
EOF
  chmod 600 "$CONF"; chown hanafax:hanafax "$CONF"
  NEWKEY=1
fi
DBPASS=$(python3 -c "import json;print(json.load(open('$CONF'))['DB']['password'])")
mysql -e "CREATE DATABASE IF NOT EXISTS hanafax CHARACTER SET utf8mb4;
CREATE USER IF NOT EXISTS 'hanafax'@'localhost' IDENTIFIED BY '${DBPASS}';
ALTER USER 'hanafax'@'localhost' IDENTIFIED BY '${DBPASS}';
GRANT ALL PRIVILEGES ON hanafax.* TO 'hanafax'@'localhost'; FLUSH PRIVILEGES;"
TABLE_SQL=$(find /opt/hanafax/db -type f -iname '*mysql*' 2>/dev/null | head -1 || true)
if [ -n "$TABLE_SQL" ] && ! mysql hanafax -e "SELECT 1 FROM hfsenddata LIMIT 1" >/dev/null 2>&1; then
  mysql hanafax < "$TABLE_SQL" && echo "   하나팩스 표를 만들었습니다($TABLE_SQL)."
fi

echo "== 4/5 중계 프로그램 설치"
mkdir -p /opt/tae-fax-relay /var/lib/tae-fax-relay
curl -fsSL -o /opt/tae-fax-relay/relay.py "$RAW/relay.py"
chown -R hanafax:hanafax /opt/tae-fax-relay /var/lib/tae-fax-relay
cat > /etc/systemd/system/tae-fax-relay.service <<'EOF'
[Unit]
Description=Tae fax relay (Apps Script -> HanaFAX B2B module)
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
User=hanafax
ExecStart=/usr/bin/python3 /opt/tae-fax-relay/relay.py
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tae-fax-relay >/dev/null
systemctl restart tae-fax-relay

echo "== 5/5 완료"
echo
echo "서버 공인 IP: $(curl -fsSL https://checkip.amazonaws.com 2>/dev/null || echo '확인 실패 — Lightsail 화면의 고정 IP를 쓰세요')"
if [ "${NEWKEY:-0}" = 1 ]; then
  echo
  echo "★ 중계 비밀키(한 번만 보여 줌) — Apps Script 프로젝트 설정 > 스크립트 속성에 RELAY_KEY 로 넣으세요:"
  echo "   $(python3 -c "import json;print(json.load(open('$CONF'))['RELAY_KEY'])")"
fi
echo
echo "남은 일(하나팩스 접속 정보를 받은 뒤 — 하나팩스 원격 설치 지원을 받아도 됩니다):"
echo "  1) /opt/hanafax/config/hanafax.properties : server.id, db.type = mysql,"
echo "     file.send.path = /opt/hanafax/file/send, svc.recv = 0, svc.conv = 0"
echo "  2) /opt/hanafax/config/dbconf.xml (MySQL 단락): jdbc:mysql://127.0.0.1:3306/hanafax, 사용자 hanafax"
echo "     DB 비밀번호는 sudo cat $CONF 의 DB.password (모듈의 setdbpasswd 로 넣기)"
echo "  3) 하나팩스 로그인 비밀번호는 모듈의 setloginpasswd 로 직접 넣기(이 스크립트는 모름)"
echo "  4) 모듈 시작(매뉴얼 6.5 / 7장) 후 시험 발송 → 잘 되면 $CONF 의 MODE 를 live 로 바꾸고"
echo "     sudo systemctl restart tae-fax-relay"
echo
echo "중계 프로그램 상태 보기: sudo journalctl -u tae-fax-relay -f"

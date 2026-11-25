# 팩스 중계 서버 설치 안내 (하나팩스 B2B)

화면에서 **팩스전송**을 누르면 아래 순서로 팩스가 나갑니다.

```
직원 브라우저 ─(PDF)→ Apps Script(팩스 대기열, PDF는 잠시만 보관)
                           ↑ 10초마다 "보낼 팩스 있어?"
             클라우드 서버(고정 IP): 중계 프로그램 → 하나팩스 모듈 → 하나팩스 → 받는 기관 팩스
                           ↓ 결과(성공·통화 중·잘못된 번호 등)
             화면의 진행 상태와 '발급 기록'에 표시
```

- 서버는 **밖으로만** 연결합니다. 공유기 포트 열기·보안 인증서 설정이 필요 없습니다(SSH 22번만 열어 두면 됨).
- 구글 드라이브의 임시 PDF는 서버가 받아 가는 즉시, 서버의 PDF는 결과가 나오는 즉시 지웁니다.
- 받는 번호는 **공식 확인된 번호만**(관할지사 가입지원부 번호, 근로복지공단 0505-055-3100) 보낼 수 있습니다.
- 발신번호는 070-7966-5797(번호 이동 없이 발신 표시만)로 보냅니다. Apps Script 스크립트 속성 `FAX_SENDER`로 바꿀 수 있습니다.

## 1. 클라우드 서버 만들기 (AWS Lightsail)

1. https://lightsail.aws.amazon.com → **Create instance**
2. Region **Seoul**, Linux/Unix, **OS Only → Ubuntu 24.04 LTS**, 메모리 **2GB** 요금제, 이름 `tae-fax`
3. **Networking → Create static IP** → `tae-fax`에 연결 → 이 숫자 주소를 하나팩스 신청서의 "설치될 서버의 공인IP"에 적기
4. 서버의 Networking 탭 방화벽: **SSH(22)만** 남기기

## 2. 설치 스크립트 실행

Lightsail 서버 화면의 **Connect using SSH**(브라우저 창)에서 아래 한 줄을 붙여 넣고 Enter:

```
curl -fsSL https://raw.githubusercontent.com/tae-open/cplatae/main/fax-relay/setup_server.sh | sudo bash
```

끝나면 화면에 **중계 비밀키**(영문·숫자 40자)가 한 번 나옵니다. 복사해 두세요.

## 3. Apps Script에 설정 넣기

구글 시트 → 확장 프로그램 → Apps Script → 왼쪽 **톱니바퀴(프로젝트 설정)** → 맨 아래 **스크립트 속성 → 속성 추가**

| 속성 | 값 |
|---|---|
| `RELAY_KEY` | 2번에서 나온 중계 비밀키 |
| `FAX_MODE` | `relay` (넣기 전까지는 `test` — 실제로 보내지 않음) |

그다음 **배포 → 배포 관리 → 연필 → 새 버전 → 배포**. 처음이면 드라이브·외부 연결 권한을 묻는 창이 뜨니 **허용**하세요
(편집기에서 `setup`을 한 번 실행해도 권한 창이 뜹니다).

## 4. 연결 시험 (하나팩스 승인 전에도 가능)

서버는 처음에 **dry-run(연결 시험)** 모드로 켜집니다. 화면에서 팩스전송을 누르면 서버까지 PDF가 갔다가
"테스트 완료 — 실제 팩스는 보내지 않았어요"로 끝납니다. 서버 기록 보기:

```
sudo journalctl -u tae-fax-relay -f
```

## 5. 하나팩스 모듈 설정 (하나팩스에서 접속 정보를 받은 뒤)

하나팩스 원격 설치 지원을 받아도 됩니다. 설치 스크립트가 모듈을 `/opt/hanafax`에 풀고 DB(MariaDB, 이름 `hanafax`)를 만들어 두었습니다.

1. `/opt/hanafax/config/hanafax.properties`
   - `server.id` = 하나팩스에서 받은 B2B 아이디
   - `db.type = mysql`
   - `file.send.path = /opt/hanafax/file/send` (recv·conv 도 `/opt/hanafax/file/recv`, `/conv`)
   - `svc.recv = 0` (받는 팩스는 하나팩스 웹에서 계속 확인), `svc.conv = 0`
2. `/opt/hanafax/config/dbconf.xml`의 MySQL 단락: `jdbc:mysql://127.0.0.1:3306/hanafax`, 사용자 `hanafax`,
   비밀번호는 `sudo cat /etc/tae-fax-relay.conf`의 `DB.password` (모듈의 `setdbpasswd`로 넣기)
3. 하나팩스 로그인 비밀번호는 모듈의 `setloginpasswd`로 **직접** 넣기(아무에게도 보내지 마세요)
4. 표가 없다면: `sudo mysql hanafax < /opt/hanafax/db/(MySQL용 파일)`
5. 모듈 시작(매뉴얼 6.5·7장) → 하나팩스와 시험 발송

## 6. 실제 전송 켜기

시험 발송이 잘 되면:

```
sudo sed -i 's/"MODE": "dry-run"/"MODE": "live"/' /etc/tae-fax-relay.conf
sudo systemctl restart tae-fax-relay
```

## 자주 쓰는 명령

| 하고 싶은 일 | 명령 |
|---|---|
| 중계 프로그램 상태 | `sudo systemctl status tae-fax-relay` |
| 중계 기록 보기 | `sudo journalctl -u tae-fax-relay -n 100` |
| 하나팩스 전송표 보기 | `sudo mysql hanafax -e "select strsid,strreceiver_faxnum,intstate,strresultcode from hfsenddata order by intid desc limit 20"` |
| 다시 시작 | `sudo systemctl restart tae-fax-relay` |
| 중계 비밀키 다시 보기 | `sudo cat /etc/tae-fax-relay.conf` |

화면에서 "팩스 중계 서버가 3분 넘게 응답하지 않아요"가 보이면 서버가 꺼졌거나 비밀키가 다른 것입니다.

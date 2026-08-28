# 대시보드

`/admin`은 이 서버가 붙들고 있는 상태를 보여줍니다. 어느 슬롯이 어느 프로젝트를
어떤 권한으로 잡고 있는지, 워크스페이스 루트마다 프로젝트가 몇 개인지가 한 화면에
나옵니다. 다른 머신을 피어로 등록하면 그 인스턴스까지 같이 보입니다.

macOS 상태바 앱과 달리 웹이라 맥과 우분투에서 똑같이 열립니다.

## 여는 법

오너 토큰이 필요합니다. 프로젝트 목록과 각 세션이 하는 일이 드러나는 화면이고,
서버는 보통 공개 터널로 노출되어 있기 때문입니다.

```
https://mcp.example.com/admin?token=<owner token>
```

토큰이 맞으면 쿠키로 옮기고 주소창에서 지웁니다. 쿼리 문자열은 셸 기록과 브라우저
기록, 중간 프록시 로그에 남기 때문입니다. 이후로는 `/admin`으로 바로 들어갑니다.
쿠키는 기본 30일 동안 유지됩니다. 필요하면 서버 시작 환경에
`CHATGPT2CODEX_ADMIN_COOKIE_DAYS=1`부터 `90`까지 지정할 수 있습니다.

기계용 경로도 있습니다.

```bash
curl -H "Authorization: Bearer $TOKEN" https://mcp.example.com/status.json
```

## 인스턴스 이름

두 대를 함께 쓰면 이름이 필요합니다. 같은 도구를 노출하는 서버가 둘이라 이름이
없으면 어느 쪽 `webapp`인지 구분할 수 없습니다.

```bash
CHATGPT2CODEX_INSTANCE_NAME=ubuntu-server chatgpt2codex-start
```

설정하지 않으면 호스트명을 씁니다.

## 피어 등록

`~/.local/share/chatgpt2codex/peers.txt`에 한 줄에 하나씩 적습니다. 형식은
`이름  URL  토큰파일`이고, 빈 줄과 `#` 주석은 무시합니다. `workspaces.txt`와 같은
방식이라 익힐 게 하나뿐입니다.

```
# 이름        URL                       토큰 파일
mac-studio    https://mcp.example.com   ~/.local/share/chatgpt2codex/peer-mac.token
```

토큰 파일에는 **상대 인스턴스의 오너 토큰**만 들어갑니다.

```bash
printf '%s' '<mac 쪽 owner token>' > ~/.local/share/chatgpt2codex/peer-mac.token
chmod 600 ~/.local/share/chatgpt2codex/peer-mac.token
```

피어는 **서버가 대신 조회합니다.** 브라우저가 두 서버를 직접 부르지 않으므로
피어 토큰이 브라우저로 내려가지 않고, CORS를 열 일도 없습니다.

양쪽에 서로를 등록하면 어느 쪽에서 열든 두 대가 다 보입니다.

## 화면 읽는 법

인스턴스마다 카드가 하나씩 나옵니다.

```
[ubuntu-server]  linux
    활성 슬롯: 2/100      ← 리스를 들고 있는 세션 수 / 동시 연결 상한
    편집 중: 1            ← full-write 를 잡은 세션 수
    전체 프로젝트: 15
    워크스페이스: 3

    슬롯   프로젝트        권한         모드    만료
    W01    charon-memory   full-write   edit    14:30 UTC
    W02    ping-fit        tests-only   verify  14:45 UTC
```

슬롯 하나가 ChatGPT 대화창 하나입니다. `활성 슬롯`의 분모는 동시 연결 상한
(`maxSessions`)이고, 분자는 그중 프로젝트를 잡고 있는 세션 수입니다. 창을 열어두고
프로젝트를 고르지 않았다면 슬롯은 있지만 권한이 `no lease`로 나옵니다.

만료된 리스는 활성으로 세지 않습니다. 잡혀 있지도 않은 프로젝트가 잠긴 것처럼
보이면 안 되기 때문입니다.

화면은 30초마다 새로고침됩니다.

## 피어가 안 보일 때

죽은 피어는 카드 하나가 빨갛게 바뀔 뿐 나머지는 정상 동작합니다. 사유가 함께
표시됩니다.

| 표시 | 원인 |
|---|---|
| `token file unreadable` | `peers.txt`의 토큰 파일 경로가 틀렸습니다 |
| `token file is empty` | 파일은 있으나 내용이 없습니다 |
| `HTTP 401` | 토큰이 상대 인스턴스의 것과 다릅니다 |
| `unreachable — is it running?` | 상대 서버가 꺼져 있거나 주소가 틀렸습니다 |
| `timed out` | 4초 안에 응답이 없었습니다 |

## 보안 메모

`/admin`과 `/status.json`은 오너 토큰 없이는 어떤 정보도 내주지 않습니다. 실패한
인증에는 짧은 지연을 둡니다. 토큰 자체의 엔트로피가 충분하므로 이는 자동화된
추측을 성가시게 만드는 정도의 장치이지 보안의 근거는 아닙니다.

프로젝트 이름은 디스크의 디렉토리 이름에서 옵니다. 클론해 온 저장소라면 그 이름을
소유자가 정하지 않았을 수 있으므로, 화면에 넣기 전에 이스케이프합니다.

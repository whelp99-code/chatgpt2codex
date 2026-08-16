# 02 — 요구사항과 인수 기준

MUST 6개. 각 MUST는 정상 경로와 실패 경로 인수 기준을 모두 갖는다.

---

## REQ-SESS-001 — 서로 다른 프로젝트의 동시 편집 보장

```
Requirement ID: REQ-SESS-001
Title: 서로 다른 프로젝트를 선택한 두 세션은 동시에 쓰기 리스를 가질 수 있다
Priority: P0 / Mandatory: MUST
Actor: ChatGPT 대화창 (MCP 세션)
Trigger: 두 번째 세션이 project_select를 호출
Precondition: 첫 번째 세션이 프로젝트 A에 full-write 리스 보유
Input: projectId(B), preset(full-write)
Input Validation: 기존 project_select 검증을 그대로 사용 — 추가 없음
Authorization: 기존 리스 권한 체계 그대로 — 추가 없음
Processing: assertWritable이 projectId 단위로만 점유자를 찾는다
Output: 두 번째 세션에 유효한 full-write 리스
State Change: sessions.json에 두 세션 엔트리가 각자의 lease를 갖고 공존
Side Effects: ledger에 project.selected 이벤트 2건
Failure Conditions: 같은 프로젝트를 두 세션이 full-write로 잡으려 하면 PROJECT_LOCKED
Performance Target: N/A — 기존 동작이며 이번 변경으로 경로가 바뀌지 않는다
Security Target: 세션 A가 세션 B의 리스를 볼 수는 있어도(슬롯 번호) 사용할 수는 없다
Acceptance Criteria: ACCEPT-SESS-001, ACCEPT-SESS-002
Excluded Behavior: 같은 프로젝트의 동시 쓰기를 허용하도록 완화하지 않는다
Dependencies: 없음 (기존 코드)
```

```
Acceptance ID: ACCEPT-SESS-001
Requirement ID: REQ-SESS-001
Given: 세션 s1이 프로젝트 A에 full-write 리스를 보유
When: 세션 s2가 프로젝트 B를 full-write로 project_select
Then: s2의 호출이 성공하고 리스가 발급된다
And: listSessions()가 s1·s2 두 엔트리를 각자의 lease와 함께 반환한다
```

```
Acceptance ID: ACCEPT-SESS-002   (실패 경로)
Requirement ID: REQ-SESS-001
Given: 세션 s1이 프로젝트 A에 full-write 리스를 보유
When: 세션 s2가 같은 프로젝트 A를 full-write로 project_select
Then: DomainError(PROJECT_LOCKED)가 발생한다
And: 오류 details에 heldBySlot으로 s1의 슬롯 라벨이 담긴다
And: s2에는 리스가 발급되지 않는다
```

---

## REQ-STAT-001 — 모든 도구 호출이 세션 활동 시각을 갱신

```
Requirement ID: REQ-STAT-001
Title: MCP 도구를 호출하면 그 세션의 마지막 활동 시각이 갱신된다
Priority: P0 / Mandatory: MUST
Actor: ChatGPT 대화창
Trigger: 임의의 MCP 도구 호출 (fs_read, fs_edit, exec 등 48개 중 어느 것이든)
Precondition: 세션이 서버에 연결되어 있다
Input: 없음 (호출 자체가 신호)
Input Validation: N/A — 부수 효과이며 사용자 입력을 받지 않는다
Authorization: N/A — 이미 인증된 세션의 요청 경로에서만 일어난다
Processing: 도구 호출 처리 경로에서 해당 sessionKey의 활동 시각을 현재 시각으로 기록
Output: 없음 (도구 결과에 영향 없음)
State Change: 서버 메모리의 활동 시각 갱신
Side Effects: 없음 — 도구 결과, ledger, sessions.json 내용에 변화 없음
Failure Conditions: 활동 시각 기록이 실패해도 도구 호출은 정상 완료되어야 한다
Performance Target: 도구 호출당 추가 지연 1ms 미만, 추가 디스크 쓰기 0회
Security Target: 활동 시각 외에 어떤 정보도 수집·저장하지 않는다 (도구 이름, 인자, 결과 전부 제외)
Acceptance Criteria: ACCEPT-STAT-001, ACCEPT-STAT-002
Excluded Behavior: 어떤 도구를 썼는지는 기록하지 않는다 — 시각만 갱신한다
Dependencies: 없음
```

```
Acceptance ID: ACCEPT-STAT-001
Requirement ID: REQ-STAT-001
Given: 세션 s1이 project_select를 마쳤고 그 시점 활동 시각이 T0
When: 60초 뒤 s1이 project_select가 아닌 임의의 도구를 호출
Then: s1의 활동 시각이 T0보다 큰 값으로 갱신된다
And: sessions.json 파일의 내용은 변하지 않는다 (디스크 쓰기 없음)
```

```
Acceptance ID: ACCEPT-STAT-002   (실패 경로)
Requirement ID: REQ-STAT-001
Given: 활동 시각 기록기가 예외를 던지는 상태
When: 세션이 도구를 호출
Then: 도구 호출은 정상 결과를 반환한다
And: 예외가 호출자에게 전파되지 않는다
```

---

## REQ-STAT-002 — 대시보드가 진행중/대기를 자동 표시

```
Requirement ID: REQ-STAT-002
Title: 대시보드의 각 세션 행에 진행중 또는 대기 상태가 표시된다
Priority: P0 / Mandatory: MUST
Actor: 저장소 소유자 (브라우저)
Trigger: GET /admin 또는 GET /status.json
Precondition: 오너 토큰 인증 통과
Input: 없음
Input Validation: N/A — 기존 토큰 검증 외에 새 입력이 없다
Authorization: 기존 오너 토큰 검증 그대로
Processing: (현재 시각 - 세션 활동 시각) < ACTIVE_WINDOW_MS 이면 진행중, 아니면 대기
Output: SlotView에 status 필드("active" | "idle"), /admin 표에 한국어 배지
State Change: 없음 (읽기 전용)
Side Effects: 없음
Failure Conditions: 활동 시각을 알 수 없는 세션은 "대기"로 표시한다 (안전한 쪽)
Performance Target: /admin 응답 시간이 현재 대비 10ms 이상 늘지 않는다
Security Target: status.json에 새로 노출되는 정보는 상태 문자열뿐이다
Acceptance Criteria: ACCEPT-STAT-003, ACCEPT-STAT-004
Excluded Behavior: "완료"는 이 요구사항이 다루지 않는다 (REQ-HIST-001 소관)
Dependencies: REQ-STAT-001
```

```
Acceptance ID: ACCEPT-STAT-003
Requirement ID: REQ-STAT-002
Given: 세션 s1의 활동 시각이 현재로부터 5초 전, 세션 s2는 10분 전
When: localStatus()를 호출
Then: s1의 status가 "active"이고 s2의 status가 "idle"이다
And: renderDashboard 결과 HTML에 두 상태의 한국어 배지가 각각 나타난다
```

```
Acceptance ID: ACCEPT-STAT-004   (실패 경로)
Requirement ID: REQ-STAT-002
Given: 활동 시각을 제공하는 출처가 비어 있는 세션 s3 (서버 재시작 직후 등)
When: localStatus()를 호출
Then: s3의 status가 "idle"이다
And: 예외가 발생하지 않고 나머지 세션도 정상 표시된다
```

---

## REQ-NAME-001 — 세션 표시 이름을 폴더명과 슬롯으로 병기

```
Requirement ID: REQ-NAME-001
Title: 세션이 "프로젝트폴더명 (W01)" 형식으로 표시된다
Priority: P1 / Mandatory: MUST
Actor: 저장소 소유자 (브라우저)
Trigger: GET /admin
Precondition: 없음
Input: 없음
Input Validation: N/A
Authorization: 기존 오너 토큰 검증 그대로
Processing: 프로젝트 폴더명과 슬롯 라벨을 합쳐 한 열로 표시
Output: /admin 표의 세션 열에 병기된 문자열
State Change: 없음
Side Effects: 없음
Failure Conditions: 프로젝트를 아직 선택하지 않은 세션은 "(W01)" 형태로 슬롯만 표시
Performance Target: N/A — 문자열 조합이며 측정 가능한 비용이 없다
Security Target: 폴더 절대 경로는 노출하지 않는다 (마지막 경로 요소만)
Acceptance Criteria: ACCEPT-NAME-001, ACCEPT-NAME-002
Excluded Behavior: 사용자 지정 별칭은 지원하지 않는다
Dependencies: 없음
```

```
Acceptance ID: ACCEPT-NAME-001
Requirement ID: REQ-NAME-001
Given: 세션 W01이 폴더 chatgpt2codex-repo 프로젝트를 선택한 상태
When: renderDashboard를 호출
Then: HTML에 "chatgpt2codex-repo (W01)"이 포함된다
And: 절대 경로 문자열(/Volumes/... 또는 /home/...)은 그 열에 포함되지 않는다
```

```
Acceptance ID: ACCEPT-NAME-002   (실패 경로)
Requirement ID: REQ-NAME-001
Given: 세션 W02가 연결만 되고 project_select를 하지 않은 상태 (activeProjectId = null)
When: renderDashboard를 호출
Then: 그 행에 "(W02)"가 표시된다
And: "null" 또는 "undefined" 문자열이 화면에 나타나지 않는다
```

---

## REQ-HIST-001 — 세션 종료를 완료 이력으로 기록

```
Requirement ID: REQ-HIST-001
Title: 세션이 정리되면 완료 이력 한 건이 디스크에 남는다
Priority: P0 / Mandatory: MUST
Actor: 서버 (sweep 스케줄러)
Trigger: sweepSessions가 세션을 제거하고 제거된 키를 반환
Precondition: 제거되는 세션이 프로젝트를 선택한 적이 있다
Input: 제거된 sessionKey 목록
Input Validation: 서버 내부 값이므로 외부 검증 불필요
Authorization: N/A — 서버 내부 동작
Processing: 제거 직전의 세션 정보(슬롯, 프로젝트, 마지막 활동 시각)를 이력 레코드로 append
Output: 이력 파일에 JSONL 한 줄
State Change: 이력 파일 증가, sessions.json에서 해당 세션 제거(기존 동작)
Side Effects: 없음
Failure Conditions: 이력 쓰기가 실패해도 세션 정리는 정상 완료되어야 한다
Performance Target: sweep 주기당 추가 파일 쓰기 1회 이하
Security Target: 파일 권한 0600, 절대 경로·명령어·파일 내용은 기록하지 않는다
Acceptance Criteria: ACCEPT-HIST-001, ACCEPT-HIST-002
Excluded Behavior: 서버 시작 시의 sweepSessions(null)은 이력을 남기지 않는다 (이전 프로세스의 잔재이므로)
Dependencies: 없음
```

```
Acceptance ID: ACCEPT-HIST-001
Requirement ID: REQ-HIST-001
Given: 세션 s1이 프로젝트 A를 선택한 상태로 존재
When: sweepSessions(["other"])가 호출되어 s1이 제거됨
Then: 이력 파일에 s1의 슬롯·프로젝트명·종료 시각을 담은 레코드가 한 줄 추가된다
And: 파일 권한이 0600이다
```

```
Acceptance ID: ACCEPT-HIST-002   (실패 경로)
Requirement ID: REQ-HIST-001
Given: 이력 파일 경로가 쓰기 불가 상태
When: sweepSessions가 세션을 제거
Then: 세션은 sessions.json에서 정상 제거된다
And: 예외가 sweep 스케줄러 밖으로 전파되지 않는다
```

---

## REQ-HIST-002 — 완료 이력을 대시보드에 표시하고 보존 기간이 지나면 정리

```
Requirement ID: REQ-HIST-002
Title: 최근 완료된 세션이 대시보드에 보이고, 보존 기간이 지난 것은 사라진다
Priority: P1 / Mandatory: MUST
Actor: 저장소 소유자 (브라우저)
Trigger: GET /admin
Precondition: 이력 파일에 레코드가 있다
Input: 없음
Input Validation: 손상된 JSONL 줄은 건너뛴다 (파일 전체를 버리지 않는다)
Authorization: 기존 오너 토큰 검증 그대로
Processing: 보존 기간 내 레코드만 읽어 최근순으로 표시
Output: /admin의 완료 영역, status.json의 history 배열
State Change: 없음 (읽기 전용). 파일 정리는 별도 시점에 수행
Side Effects: 없음
Failure Conditions: 이력 파일이 없으면 빈 목록으로 표시하고 오류를 내지 않는다
Performance Target: 이력 파일이 10,000줄일 때도 /admin 응답이 500ms를 넘지 않는다
Security Target: 이력 표시에 절대 경로를 포함하지 않는다
Acceptance Criteria: ACCEPT-HIST-003, ACCEPT-HIST-004
Excluded Behavior: 이력 검색·필터·페이지네이션은 만들지 않는다
Dependencies: REQ-HIST-001
```

```
Acceptance ID: ACCEPT-HIST-003
Requirement ID: REQ-HIST-002
Given: 이력 파일에 2시간 전 완료 1건과 30일 전 완료 1건이 있고 보존 기간이 7일
When: localStatus()를 호출
Then: history 배열에 2시간 전 레코드만 담긴다
And: renderDashboard 결과에 그 프로젝트명이 완료 영역에 나타난다
```

```
Acceptance ID: ACCEPT-HIST-004   (실패 경로)
Requirement ID: REQ-HIST-002
Given: 이력 파일에 정상 레코드 1줄과 JSON으로 파싱되지 않는 1줄이 섞여 있음
When: localStatus()를 호출
Then: 정상 레코드 1건이 반환된다
And: 예외가 발생하지 않는다
```

---

## SHOULD 요구사항

```
Requirement ID: REQ-STAT-003
Title: 진행중 판정 임계값과 이력 보존 기간을 환경변수로 조정할 수 있다
Priority: P3 / Mandatory: SHOULD
Actor: 저장소 소유자
Trigger: 서버 시작
Input: CHATGPT2CODEX_ACTIVE_WINDOW_MS, CHATGPT2CODEX_HISTORY_RETENTION_MS
Input Validation: 양의 정수가 아니면 기본값 사용
Processing: 시작 시 1회 읽어 설정에 반영
Output: N/A
State Change: 없음
Side Effects: 없음
Failure Conditions: 잘못된 값이면 기본값으로 조용히 되돌린다
Performance Target: N/A
Security Target: N/A
Acceptance Criteria: 단위 테스트에서 잘못된 값 입력 시 기본값이 쓰이는지 확인
Excluded Behavior: 런타임 중 변경(핫 리로드)은 지원하지 않는다
Dependencies: REQ-STAT-002, REQ-HIST-002
```

---

## 모호성 채점 (PHASE 05)

**판정: READY.** 사용자 결정으로 상태 기준·이름 형식·보존 정책이 모두 확정되었고, 조사로
기술적 제약이 드러났다. 미해결 충돌 없음.

남은 값 두 개는 `ASSUMED`로 진행하며 03 문서의 ASSUMED 목록에 근거와 롤백을 적었다:
진행중 임계값(90초), 이력 보존 기간(7일). 둘 다 REQ-STAT-003의 환경변수로 뒤집을 수 있어
잘못 잡아도 코드 변경 없이 교정된다.

## 배치 질문

**없음.** 조사와 사용자 결정으로 모두 해소되었다.

# Studio / ACP / native 계약 제안

> 1–9절은 2026-10-24–25 소스 감사에서 작성했다. 10절은 2026-11-21의 Studio #94 결정과 별도 검증 범위를 기록한다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 2026-10-24. 기존 `aelix_control`/`_aelix/manage` 계약을 대체한
구현 명세가 아니다. 아래의 추가 필드·메서드는 이름보다 의미를 먼저 합의할 후보이며,
현재 구현으로 주장하려면 별도 compatibility/minor-version 검증이 필요하다.

## 1. 버전과 capability

릴리스 manifest는 Studio, AionUi baseline/main 관측 SHA, AionCore binary,
Python build, native 네 패키지, ACP, Analytics, lock/patch/source/archive/wheel
hash와 capability schema version을 함께 기록한다. package version만 보지 않는다.

예시의 값은 실제 출시 버전을 지정하지 않는 스키마 설명이다.

```json
{
  "nativeSource": { "kind": "release-wheel", "version": "0.1.0b2", "sha256": "..." },
  "adapter": { "version": "...", "sourceCommit": "..." },
  "hostControl": { "schema": "aelix.host-control/1", "version": 1 },
  "capabilities": { "session.readOnlyLive": false, "auth.manage": false },
  "compatibility": { "profile": "beta2-public", "patches": [] }
}
```

기존 ACP 표준 selector는 `configOptions`를 우선하고 legacy modes/models와 일관되게
유지한다. 커스텀 동작은 `_aelix/*`, 광고는 `_meta`의 namespaced capability를 쓴다.
알 수 없는 명령은 명시적 오류이며 LLM prompt로 보내지 않는다.
capability 유무뿐 아니라 `supported/appliesAt/requiresRestart/reason`을 제공한다.
버튼은 광고된 capability에만 연결하며 핵심 미지원은 숨기기보다 이유와 대안을 표시한다.

관리 요청의 결과는 `accepted`와 `observed`를 구분한다. 예를 들어 모델 선택이
접수됐어도 native effective model을 다시 읽기 전에는 성공 상태로 확정하지 않는다.
`expectedRevision` 불일치는 충돌로 반환하고 최신 값·출처를 다시 읽는다.
세션 교체·profile 변경·reload 후 catalog와 selector를 원자적으로 갱신한다.

현재 코드의 integer `runtimeControlVersion`을 새 문자열 스키마와 혼용하지 않는다.
기존 version=1의 wire 의미를 바꾸면 additive minor negotiation 또는 새 version이 필요하다.

### 1.1 전역 관리와 실행 중 제어의 통로 — D05

첫 버전의 권장 배치는 두 경로다.

| 경로                                                                   | 처리할 것                                                                              | 소유권/금지할 혼동                                                                                                   |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| renderer → 인증된 Studio facade → 기존 Aion host → ACP → native worker | prompt·cancel·model/reasoning selector·approval·표준 slash·실행 중 세션 제어           | 현재 세션 감독자 유지. configOptions 성공으로 임의 custom request 전달까지 추정하지 않음                             |
| renderer → 같은 facade → stdio native 관리 helper                      | 모델 없는 auth/endpoint bootstrap, profile·package 관리, native catalog/읽기 전용 관찰 | helper는 live worker를 우회 mutation하거나 같은 세션을 다시 감독하지 않음. native 서비스/공통 store 계약 호출만 수행 |

helper는 초기에는 Studio repo의 작은 Python host 구성 요소로 둔다. 새 공개 TCP
listener나 범용 daemon을 요구하지 않으며, WebUI는 이미 인증된 host 경계 안에서
호출한다. native sessionless control이 준비되면 helper를 얇은 중계로 줄일 수 있다.
ACP의 기존 선택적 관리 API는 다른 client용으로 유지할 수 있지만 native 정책을
서로 다르게 구현하지 않는다. 전역 작업의 결과는 revision/invalidation으로 worker에 반영한다.

실행 중 `_aelix/*` 요청/응답, 역방향 UI dialog, context/child metadata, busy delivery,
stable request ID가 Aion host를 실제 통과하는지 항목별 probe한다. 통로가 없으면
bounded forwarding patch 또는 명시적 host cutover를 비교한다. 별도 helper 존재만으로
이 세션 통로가 해결되지는 않는다. 표준 ACP method도 현재 client/version/capability를
검증한 경우에만 쓰며 새 문서의 메서드를 구형 AionCore 지원으로 간주하지 않는다.

## 2. 세션의 정체성과 소유권

정본: native session UUID + native branch/entry 관계 + host identity + canonical file
identity. Studio conversation ID와 ACP ID는 view/transport mapping이며 새 native
session을 의미하지 않는다. 하나의 native 파일을 서로 다른 ACP ID로 등록해도
writer는 하나다. 경로 별칭/심볼릭 링크와 파일 교체도 같은 정책으로 처리한다.

소유권 후보 상태:

| 상태                             | 보기                                          | 쓰기/이어가기                                                   |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| idle / unowned, 협조하는 runtime | 최신 snapshot                                 | OS lock 획득·재읽기 후 writer 허용                              |
| owned_by_tui                     | live viewer 가능하면 live, 아니면 수준을 명시 | "터미널에서 사용 중. 종료 후 이어받기"                          |
| owned_by_studio                  | TUI/다른 탭은 viewer                          | 기존 owner만 prompt·compact·설정 변경                           |
| owner_unknown / legacy_cli       | 읽기 전용·원본 bytes 보존                     | 같은 파일에 쓰지 않고 새 branch로 복제 또는 호환 CLI 업그레이드 |
| storage_lock_unsupported         | 읽기 가능 여부 별도 확인                      | 안전한 단일 writer 보장이 없으면 writer 거부                    |
| interrupted / effects_unknown    | 마지막 확정 기록과 중단 표시                  | 자동 재전송 금지, 별도 사용자 판단                              |

PID, heartbeat, 화면 버튼의 disabled는 writer 권한이 아니다. 기존 native
`SessionWriterLock`를 canonical file 기준으로 공통 사용하고 프로세스가 살아 있는
동안 유효해야 한다. owner 설명용 metadata는 PID 재사용 방지용 시작 identity를
포함하되 OS lock 획득 여부가 우선한다. 원격 multi-host fencing은 후속 분산 계약이다.

lock은 실제 JSONL writer인 **native worker**가 획득·보유하고, host는 ready/owned
결과를 받은 뒤 입력을 연다. 부모 ACP가 같은 native lock을 먼저 보유한 상태에서
자식 worker도 다시 획득하게 만들지 않는다. 명시적인 lock handle 이양 계약 없이
두 프로세스가 중복 획득하면 자기 충돌이 된다. ACP lease는 transport ID 중복 방지에 한정한다.

안전한 이어받기 순서:

1. 사용자가 실행 중인 쪽을 종료/해제한다. 새 화면이 일방적으로 kill하거나 lock 파일을 삭제하지 않는다.
2. 원래 owner가 현재 turn/승인/child의 상태를 정리하고 writer를 해제한다.
3. 새 owner가 같은 native 파일의 공통 OS lock을 획득한다.
4. lock 아래에서 최신 transcript/leaf/model/thinking/settings revision을 다시 읽는다.
5. 성공한 세션에만 입력을 허용한다. 실패하면 viewer 상태와 원인을 유지한다.

공개 beta.2 CLI에는 이 공통 native lock 모듈이 없다. Studio/ACP의 사설 lease만으로
공개 beta.2 CLI의 쓰기를 막을 수 없다. Preview에서 기존 CLI 세션을 복제해서
이어가는 대안은 원본을 보존하고 새 session/parent provenance를 명확히 표시해야 한다.
공통 잠금 계약에 참여하지 않는 legacy와 같은 파일의 안전한 인계는 Preview에서
약속하지 않는다. 협조하는 공개 runtime/CLI의 공통 계약을 쓰는 경우에 별도로 검증한다.

## 3. 실시간 보기, snapshot, 복구

현재 main의 `ReadOnlySessionStorage`는 열린 시점 snapshot이다. 파일 tail로 완료
메시지를 갱신하는 것과 실행 중 추론/tool/approval stream을 보는 것을 구분한다.

목표 observation 계약:

- `snapshot`은 native identity/leaf/config revision, execution status, pending
  approval, child runs, 최근 메시지와 일치하는 cursor/watermark를 반환한다.
- `watch(afterCursor)`는 같은 session/run epoch의 후속 이벤트를 전달한다.
  snapshot 취득과 subscribe 사이 이벤트가 빠지지 않게 replay 또는 tail을 연결한다.
- 메시지·도구 결과·소유권·승인·child 상태는 durable state로 복구한다. 델타를 전부
  디스크에 fsync한다는 약속은 하지 않는다. crash로 받은 적 없는 델타는 gap/interrupted로 표시한다.
- cursor가 오래됐거나 파일이 회전/교체되면 `snapshot_required`로 명시한다.
- viewer에 승인 요청을 보여줘도 답할 권한은 owner에만 있다. 만료·취소된 승인을 재사용하지 않는다.
- viewer 서버는 원본의 prompt/compact/rename/config/profile/extension mutation과,
  원본 live harness를 잠시 전환하는 현재 `sessions/branch`도 거부한다.
  UI 제한만으로 읽기 전용을 구현하지 않는다.
- viewer가 선택한 immutable snapshot/cursor에서 **별도 target identity를 생성**하는
  `createDerivedSession(snapshotCursor)`류 작업은 원본 mutation과 구분할 수 있다.
  target의 writer만 새로 얻고 native 복제 API로 UUID·parent provenance를 생성한다.
  원본 JSONL을 byte copy해서 원본 UUID까지 재사용하는 것을 새 branch로 보지 않는다.

독립 CLI를 항상 Studio daemon 아래 실행하도록 강요하지 않는다. core에는 observation
SPI와 lifecycle을 두고, coding-agent의 로컬 관찰 publisher 또는 host transport가
이를 연결한다. 연결이 없으면 가능한 데이터 신선도 수준을 정확히 보여준다.
네트워크 연결 수명과 native 작업 수명을 분리하는 supervisor는 후속 기능이며,
현재 ACP stdin EOF가 child를 종료하는 동작을 이미 해결됐다고 설명하지 않는다.

## 4. 설정 정본과 적용 시점

모델/추론/도구 선택의 정본은 현재 native effective state다. native resolver가
운영자 CLI 인자, 프로필, 프로젝트/user 설정, 세션 override의 우선순위와 출처를
반환한다. Studio에서 같은 우선순위 로직을 다시 구현하지 않는다.

현재 ACP preferences는 호환 캐시/명시적 사용자 선택으로 보존하되, CLI에서 더
최근에 변경된 native 상태를 오래된 preferences로 덮지 않는다. native revision을
읽고 충돌을 안내한다. 구버전 provenance가 없으면 임의로 새 사용자 override를 추정하지 않는다.

| 설정              | 사용자에게 보여줄 상태                                            | 기본 적용 정책 제안                                                                                                                         |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| model / reasoning | 선택값·effective 값·지원 레벨·출처                                | native가 지원하는 idle 전환. busy면 대기/거부를 명확히                                                                                      |
| permission        | native launch posture와 ACP 승인 정책, 적용 시점, pending consent | Preview Ask/Yolo 목표. beta.2 시작 flag와 bridge 정책을 일치시키고 우선 idle restart. 현재 Ask-only를 이미 두 모드 지원이라고 표시하지 않음 |
| tools             | loaded/selected/effective/denied 및 source                        | native launch grant·profile 정책 내 변경                                                                                                    |
| skills            | 발견/선택/실제 context 포함 여부                                  | 명령 메뉴 숨김과 loading off를 구분. 필요시 idle restart                                                                                    |
| extensions        | installed/enabled/loaded/error/restart-required                   | live unload 보장 없이 새 worker generation 적용                                                                                             |
| profile           | 원본 native profile revision·세션 override                        | 변경 preview→검증→idle restart/새 세션 선택                                                                                                 |

request mutation은 expected revision과 operation ID를 갖고, 성공 응답에 적용 시점과
관찰된 effective state를 반환한다. 여러 항목 저장 중 일부 실패하면 원래 적용값과
부분 완료를 숨기지 않는다. 자동으로 broad tool grant나 전체 접근으로 복구하지 않는다.

고정된 operator/parent authority ceiling과 사용자가 바꿀 수 있는 profile/tool
preference를 구분한다. Preview bridge에는 frozen ceiling이 있지만 검토한
control-v1 `tools/set_active`는 loaded-tool membership만 검사한다. 위 표의
불변 ceiling은 **신규 native 정책 제안이며 현재 전면 보장이 아니다**. profile의
도구 목록을 보안 상한으로 쓸 경우 공통 API·거부 테스트가 선행되어야 한다.

**설정 store의 잠금은 session writer lock과 별개다.** 서로 다른 세션을 쓰는 CLI와
Studio worker도 같은 auth/settings/profile registry를 바꿀 수 있다. 이 범위에는
canonical store별 stable sidecar의 공통 cross-process lock이 필요하다.
lock 아래에서 최신 bytes/revision을 다시 읽고 compare→단일 필드/범위 mutation→
atomic publish→새 revision을 수행한다. 긴 OAuth/browser 대기 동안 lock을 잡지 않는다.
callback commit 때 다시 검증해 다른 Provider의 변경을 오래된 held 객체로 덮지 않는다.
완료 후 관련 worker의 AuthStorage/registry/settings cache를 갱신하거나 적용 시점을 표시한다.

검토한 main의 auth/settings storage에는 Windows cross-process lock이 없는 경로가
남아 있다. 따라서 현재 native store 재사용만으로 다중 worker의 안전한 갱신을
확정하지 않는다. 공통 계약에 참여하지 않는 legacy CLI writer는 별도 지원 상태로
표시하고 공유 store 동시 mutation을 보장하지 않는다. Windows에서도 **두 실제
프로세스**가 서로 다른 Provider/settings/profile을 갱신하는 회귀와 conflict/crash를 검사한다.

공개 beta.2 AuthStorage에는 POSIX flock이 이미 있다. 위 공백을 모든 플랫폼의
잠금 부재로 표현하지 않는다. 파일 lock과 atomic rename의 조합, stale held 객체,
Windows 경로, revision 충돌까지의 안전성이 별도 검증 대상이다.

## 5. Provider/Auth와 첫 설치

AionCore의 Provider DB와 Aelix AuthStorage는 별개다. Aelix agent를 선택했으면
Studio Provider 화면은 **native provider/auth 서비스**에 연결한다. 다른 외부
agent의 자체 인증은 그대로 둔다. Aion Provider 입력 성공을 Aelix 인증 성공으로 표시하지 않는다.

onboarding 순서:

1. bundled runtime identity/integrity/capability 확인. CLI 사용자면 설정·세션 root와
   CLI 버전을 발견하고 사용자에게 연결할 범위를 설명한다.
2. 설정된 Provider/source만 조회한다. API key/OAuth token 원문을 상태 조회에 반환하지 않는다.
3. API key, 지원 OAuth, 내부 OpenAI-compatible endpoint/CA를 native 서비스로 등록한다.
4. 실제 모델 catalog를 읽고 모델을 선택한다. 저비용 실제 검증 요청의 실행 여부를 UX로 드러낸다.
5. 첫 user turn과 tool approval을 수행한다. 오류는 키/모델 권한/endpoint/네트워크를 구분한다.

인증 관리가 사용 가능한 LLM 세션의 존재를 요구하는 순환 의존성을 피한다.
공개 beta.2에서도 관리 helper가 `AuthStorage(path).set_api_key` 및
`login(provider, callbacks)`를 호출하는 후보가 있다. 새 native control RPC만을
유일한 해법으로 요구하지 않는다. UI callback/취소/오류와 실제 wheel 수용은 미완료다.
기존 CLI 인증을 복제하는 두 번째 store를 만들지 않고, 파일/권한을 재사용하는
native API를 호출한다. API key 변경 후 held AuthStorage/registry의 stale 상태를
지원되는 서비스 갱신 또는 idle restart로 정리한다. beta.2에서 외부 파일 변경이
기존 actor의 held AuthStorage에 즉시 live 반영된다고 가정하지 않는다.

native CLI와 같은 `get_agent_dir()` 해석 결과의 `auth.json`을 명시적으로 전달한다.
검토한 beta.2의 `default_auth_path()`는 별도 XDG 기본값을 가지므로 인자 없는
AuthStorage 생성으로 우연히 두 번째 인증 store를 만들지 않는다. CLI 인자·환경
override와 endpoint/settings root도 동일한 resolver 계약으로 연결한다.

Studio WebUI 로그인과 모델 Provider OAuth는 다르다. 단일 운영자 WebUI의
인증/Origin 경계를 유지하고, OAuth 진행·callback·취소·로그아웃은 transient 상태로
처리한다. key/token/OAuth code를 transcript, telemetry, request ledger에 저장하지 않는다.
연결된 기존 CLI의 파일을 자동 이동하거나 무조건 최신 버전으로 바꾸지 않는다.
OAuth callback은 desktop/remote WebUI의 browser·server 위치와 Provider가 지원하는
흐름을 함께 검증한다. 모든 Provider가 device/manual code를 지원한다고 가정하지 않는다.

## 6. 프로필과 패키지 관리

프로필의 정본은 native AgentProfile Markdown/parser다. 새 Studio 전용 agent
정체성을 만들지 않는다. Studio card는 그 profile revision과 runtime reference를
가리키며 prompt·model·thinking·tools·skills·extensions·MCP/작업 공간 정책의
effective 구성을 보여준다. native 필드에 없는 UI 기본값은 namespaced 별도 metadata다.

현재 ACP의 `--profile coding|analytics`는 launch preset이며 native AgentProfile
선택과 다른 개념이다. 같은 이름의 옵션으로 혼동하지 않게 runtime preset과 native
identity를 구분한다. ACP가 덧붙이는 기본 system prompt 때문에 같은 프로필의 CLI와
Studio 동작이 달라지지 않도록, 역할 지시는 native 명명 프로필/동일 resolver로 모은다.
Studio 전용 표시·미리보기 설명은 모델의 역할 prompt가 아닌 host presentation으로 보낸다.

profile CRUD는 경로/신뢰/출처/상속을 검증하고 기존 파일 변경은 revision 조건을
적용한다. credential은 프로필에 복사하지 않는다. `approval_mode`는 delegated
child 정책이며 최상위 permission mode가 아님을 UI에서 설명한다.
프로젝트 범위 프로필의 확장 코드 제한 등 native 정책은 form에서도 보존한다.
프로필을 만들었다는 이유로 project trust나 code loading grant를 자동 승인하지 않는다.

서명된 앱 번들과 bundled Python site는 읽기 전용이다. 확장 설치는 native가
사용하는 **사용자 쓰기 가능 managed runtime/세대별 환경**에 wheel·의존성을 준비하고,
manifest/버전제약/import 검증 후 worker를 새 generation으로 전환한다.
단순히 별도 venv에 pip를 실행하는 것을 해당 세션의 확장 설치 성공으로 보지 않는다.
overlay와 완전한 managed venv 중 하나를 검증해 선택하며, 무검증 PYTHONPATH 주입을 기본값으로 삼지 않는다.

launcher는 단순 bundled Python 고정이 아니라 `effective RuntimeBinding`을 해석한다.
binding에는 base runtime/ABI digest, extension generation digest, profile revision이
포함된다. native profile에 없는 `runtimeRef`는 Studio metadata로 유지하고 native
파서에 임의 필드를 몰래 추가하지 않는다. native/extension 버전 skew면 새 generation을 준비한 뒤 전환한다.
전환은 새 worker/restart에만 적용한다. active worker·pending operation·보존된 session
pin·unresolved run이 참조하는 generation은 삭제/GC하지 않는다. session 재개는 해당
generation 또는 명시적으로 검증한 migration을 선택하고 차이를 보여준다.
runtime generation GC와 Analytics project의 독립 `.venv` 정리는 서로 다른 정책이다.

설치/업데이트/삭제/off는 각각 계획→명시적 동의→적용→import/도구 관찰→commit의
상태를 갖는다. 실패 시 이전 환경은 재선택 가능해야 한다. 실행 중 package 삭제와
Python module의 완전한 hot unload를 약속하지 않는다. off 후 다음 turn/restart에서
도구와 prompt 기여가 실제로 빠졌는지 검사한다. 핵심 승인 bridge는 임의 off 대상이 아니다.

## 7. 명령, child/Team, 큰 이력

`/clear` 신규 구현은 사용자 기준으로 제외한다. `/new`/새 대화가 새 context/session이며
보기 동작·삭제와 구분한다. 기존 Aion UI를 우선 재사용하고 명령 이름의 전수 복제를
요구하지 않는다. TUI `fork`의 기본 cut은 선택 user entry **직전(before)**이고,
Aion ACP HEAD fork/`clone`은 현재 branch의 root→leaf 이력을 leaf **포함(at)**으로 복제한다.
다른 branch entry까지 포함한 JSONL 파일 전체 byte copy와 다르다. 부모 세션은 계속 보존한다.
Studio가 제공하는 cut을 UI에 정확히 표시하고 TUI before(entry) 옵션 전수 구현을
필수로 삼지 않는다. `/tree`는 lineage이며 기존 배지/부모 링크로 표현할 수 있다.
최상위 writer를 바꾸는 native 명령은 결과 mapping을 반영한 뒤 UI navigation을 수행한다.

실행 중 입력은 cancel/steer/follow-up/readonly observation 등 native가 허용한
typed 경로로 보낸다. 이미지 큐 전송의 2026-11-21 결정과 검증 계획은 [10절](#running-input-images)에 있다.
busy 세션에 새 prompt를 보내는 것과 steering mode selector를
바꾸는 것은 각각 다른 기능이다. 큐에 들어간 내용/시점/삭제/취소와 native 반영을 보여준다.
`!command`는 TUI처럼 결과를 context에 남기는 user bash, `!!command`는 transient
user bash이며 별도 수동 PTY와 구분한다. `/` 외 모든 입력을 LLM에 전송하지 않는다.
native user_bash hook·정책·출처를 지키고 문자 prefix만 제거해 무제한 shell로 실행하지 않는다.

표준 select/input/confirm/editor/notification은 typed client action으로 구현한다.
임의 TUI widget을 HTML로 자동 변환한다고 약속하지 않는다. 확장 기여 UI는 capability와
격리 경계가 있는 별도 표면이고, 지원 안 되는 native command는 실행 전에 설명한다.

beta.2 Ask/Yolo는 startup permission flag + bridge policy + idle restart를 초기 경로로
삼는다. Ask는 client 승인/거절, Yolo는 client prompt를 생략하되 bridge/관리 채널을
유지한다. native guardrail/tool 선택·다른 확장 거부·취소는 유지한다. 현재 adapter의
Ask-only 광고 조건은 별도 수정이 필요하다. Plan/Edit/Auto 전체 live 전환은 이 두
모드의 지원과 구분한다. 상세 의미와 수용은 [공개 beta.2 표면](beta2-public-surface.md)을 따른다.
범용 extension command dispatcher는 live harness/context를 요구한다. 목록 조회 API를
명령 실행 API로 간주하지 않고, SDK host를 새로 소유하는 lifecycle 비용/지원 범위를
검토한다. Preview용 core backport는 현재 경로에서 제외한다.

Aion Team의 멤버 대화와 Aelix native child run은 서로 다른 정체성이다. childRunId,
parentRunId, native child session, profile revision, 상태·usage·pending consent·cancel
가능 여부를 연결한다. `_aelix/subagent` 실시간 알림만 보내지 말고 재접속 snapshot과
durable terminal state에 남긴다. Team 생성이 아닌 실제 메시지·도구·중단을 검증한다.

공개 beta.2도 `AELIX_MCP_CONFIG`로 actor 시작 전 MCP 구성을 읽을 수 있다. 현재
adapter의 client mcpServers 거부를 native MCP 전체 부재로 해석하지 않는다.
Team 연결 후보는 private per-actor config로 변환→native 시작→실제 도구 검증이며,
stdio/HTTP/header 지원·사용자 MCP 조합·grant·종료 정리를 확인한다. startup 구성
성공과 실행 중 MCP hot 교체는 다른 capability다.

도구 결과/diff/아티팩트와 host status는 assistant의 새 발화처럼 삽입하지 않는다.
아티팩트는 resource identity, mime/size/hash, producer session/toolCall/run과 연결하고,
지원되는 ACP content/resource 또는 namespaced metadata로 전달한다. approval diff는
실제 edit/write와 연결한다. 채팅에는 card/link로 보여주되 원래 model text를 보존하고,
재접속 시 같은 근거에서 같은 카드를 복구한다. 현재 ACP의 `AionUi 분석 미리보기`
텍스트 삽입은 이 목표와 다른 기존 presentation 경로다.

client는 첫 전송 전에 turn/request ID를 만들고 같은 요청 재시도에 동일 ID와 payload
fingerprint를 쓴다. Aion host가 `_meta["aelix/requestId"]`를 보존하는지 실제 wire에서
검사한다. timeout/interrupted/effects_unknown는 "실행 안 됨"이 아니다. 새 키로 자동 재전송하지 않는다.

현재 ACP reader/wire의 16 MiB 경계와 native 전체 aggregate event/get_messages는
긴 세션의 수용 공백이다. native JSONL 저장 자체의 16 MiB 상한과 혼동하지 않는다.
compact lifecycle event, paged history, bounded snapshot/cursor를 함께 설계한다.
frame 크기를 올리는 것만으로 메모리·backpressure·large-session 수용을 해결하지 않는다.

## 8. rollback과 공유 데이터

rollback 대상을 세 가지로 나눈다: immutable app/runtime generation, Studio 전용
DB/projection, CLI와 공유하는 native auth/settings/profile/session 원본.
앱 update rollback은 호환 binary/generation 재선택 또는 forward recovery가 기본이다.
manifest에는 store/session schema의 최소 reader/writer 버전과 downgrade 가능 여부를 기록한다.

Studio가 만든 예전 공통 root snapshot을 자동으로 복원하지 않는다. 업데이트 후 CLI가
추가한 transcript·profile 변경을 잃거나 삭제된 자격 증명을 되살릴 수 있기 때문이다.
공유 원본 복원은 모든 writer의 quiescence 확인, 현재 대비 변경 차이 제시, 명시적인
복구 작업으로 한정한다. 새 schema를 안전하게 읽을 수 없는 구버전은 readonly/거부로 처리한다.
외부 tool effect는 binary/schema rollback으로 취소됐다고 표시하지 않는다.

## 9. 파일·Analytics·브라우저·터미널

파일 참조는 host+허용 root+resource identity를 사용하고 renderer의 로컬 절대 경로를
정본으로 삼지 않는다. Analytics Workspace는 원본 상대 CSS/JS·다중 페이지·코드/데이터
링크를 보존하는 격리 콘텐츠 경로로 제공한다. 단일 HTML exporter는 호환 fallback이다.
차트 클릭/선택이 후속 분석을 자동 실행하는 기능은 Analytics의 별도 승인된 계약을 따른다.

확인한 Studio 작업 트리의 `renderer/utils/file/previewPayload.ts`는 텍스트/HTML
편집용 read gate의 기본값을 **1 MiB**, 사용자 설정 범위를 1–100 MiB로 둔다.
브라우저 엔진 자체의 HTML 최대 크기가 아니며 변경값은 새로 여는 tab에 적용된다.
대형 HTML 렌더링은 전체 편집 버퍼와 별도 URL/stream 경로로 설계하고, 파일 read,
editor 메모리, HTTP/IPC, ACP frame 한도를 각각 기록한다. 제한을 단순히 모두 키우지 않는다.

기존 HTMLRenderer에는 desktop 파일 경로 로딩과 WebUI 상대 자산 inline 경로가 있다.
따라서 이전 index.html CSS 실패를 재현 없이 upstream 버그로 확정하지 않는다.
resource ref/file path 유실·base origin·상대 CSS/JS·다중 페이지 navigation·WebUI 배치를
같은 fixture로 비교해 원인을 좁힌다. Analytics Workspace는 채팅에 큰 HTML을 반복
삽입하기보다 원본 ref에서 열고, chart/report card와 근거 링크를 채팅에 남긴다.

일반 웹 브라우징, 생성 HTML, native settings 화면은 origin/권한을 분리한다.
내장 브라우저 엔진을 재사용하고 임의 외부 사이트 iframe 지원을 보장하지 않는다.
사람이 사용하는 PTY와 agent tool terminal은 수명·입력·권한이 다르다. command output
카드를 interactive terminal 지원으로 세지 않는다. 원격 host에서는 agent/file/PTY/콘텐츠가
같은 host와 권한을 따라야 한다.

참조: [ACP configOptions](https://agentclientprotocol.com/protocol/v1/session-config-options),
[ACP extensibility](https://agentclientprotocol.com/protocol/v1/extensibility).

<a name="running-input-images"></a>

## 10. 실행 중인 턴에 PNG·JPEG 픽셀 보내기

**Studio #94 설계 · 2026-11-21.** 단독 ACP 대화에서 일반 전송을 기다리지 않고 steer 또는 follow-up으로 이미지 픽셀을 보낸다. 고정 native의 두 큐는 이미 이미지를 받는다. Host는 승인한 파일의 바이트만 제공하고, ACP가 모델 입력과 큐 쓰기를 책임진다. **Host 착수 전에 native `context` hook 시험(A-0)**으로 이력 이미지 재전송 정책을 판정한다. 독립적인 Studio worker·파생 업로드 시험(S-1a)은 A-0과 병행할 수 있다. [Issue #94](https://github.com/handochan/aelix-studio/issues/94) · [1차 결정](https://github.com/handochan/aelix-studio/issues/94#issuecomment-7059311054) · [추가 결정](https://github.com/handochan/aelix-studio/issues/94#issuecomment-7059578337)

### 확정한 열 가지 결정

| 순서 | 결정                                                                                                                      | 적용                                                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Host는 범용 바이트 제공만 담당한다.                                                                                       | 현재 대화·내장 ACP binding에 파일 읽기를 승인하고 **기존 ACP 연결**로 청크를 반환한다. D17의 예외는 이 한 기능이다. Host가 이미지, 턴, 모드, 모델을 해석하지 않는다.                                                                                                                                                                    |
| 2    | PNG/JPEG는 provider가 받을 수 있는 범위만 보낸다.                                                                         | 각 변 **8000 px 이하**, **제출당 4장 이하**. 파일·제출·모델 요청 각각에 한도를 적용한다. 최종 바이트 수치는 결정 5가 앞선 수치를 대체한다. 초과 PNG/JPEG의 v1 변환 방식은 결정 9를 따른다.                                                                                                                                              |
| 3    | 축소 후에도 한도를 넘거나 모델이 이미지를 지원하지 않으면 픽셀을 차단한다.                                                | 초안·칩을 보존한다. ‘경로만 보내기’는 사용자 새 클릭으로만 실행한다. 일반 전송의 자동 경로 전환과 의도적으로 다르다.                                                                                                                                                                                                                    |
| 4    | 일반 전송과 같은 권한으로 확인하고 승인 사본은 RAM에만 둔다.                                                              | 호출자의 대화 소유권과 기존 `ChatFileRef` resolver를 재사용한다. 디스크 spool, picker 영수증, 업로드 출처 원장을 추가하지 않는다. 출처 강화는 두 경로의 공통 후속 작업이다.                                                                                                                                                             |
| 5    | 전송 파일당 **3,750,000 B**, 전송 파일 합계 **6 MiB(6,291,456 B)**, ACP→native JSONL 한 줄 **8 MiB(8,388,608 B) 이하**다. | 파일·합계는 변환을 마친 파일의 base64 전 크기다. UI에 선택 원본·전송본·줄 크기를 구분해 표시한다. Windows Stop 지연을 측정한 뒤 재검토한다.                                                                                                                                                                                             |
| 6    | 세션 이미지 예산은 **슬라이딩 윈도우를 먼저 시험**한 뒤 정한다.                                                           | A-0 통과 시 매 모델 호출에 한해 오래된 이미지를 자리표시로 바꾸고 사용자에게 알린다. 실패 시 **세션 보관 이미지 8 MiB + 20장** 고정 상한으로 전환한다. 일반 전송·도구 결과도 포함하고 수동 compact 복구를 안내한다.                                                                                                                     |
| 7    | 이미지 단독 전송을 지원한다.                                                                                              | 사용자 텍스트가 비면 ACP가 고정 영문 설명을 한 번 붙인다. 사용자 작성 문구와 자동 설명을 구별한다.                                                                                                                                                                                                                                      |
| 8    | **수락 안내에 썸네일**을 표시한다.                                                                                        | Claude가 접수 안내에 연결한다. 썸네일이 없으면 아이콘 + W×H를 표시하며 전송을 막지 않는다. 재열기 뒤 상태·이력 복원은 별도 카드다.                                                                                                                                                                                                      |
| 9    | **v1에서 초과 PNG/JPEG를 자동 축소**한다.                                                                                 | 긴 변 약 2048 px부터 시도하며 원본을 보존한다. 고해상도 JPEG는 검증된 축소 디코드 경로를 쓴다. 변환용 입력이 16 MiB를 넘거나, 변환이 필요한 PNG가 16,777,216픽셀 또는 한 변 16,384 px를 넘거나, 브라우저에서 160 MiB 안에 변환할 수 없으면 실제 한도와 ‘경로만 보내기’를 표시한다. 수락 안내에는 ‘축소됨(원본 → 전송 크기)’을 표시한다. |
| 10   | **재열기 후 접수 상태 복원은 별도 카드**로 유지한다.                                                                      | #94의 썸네일은 현재 대화에서 수락된 입력의 notice에만 붙인다. 재시작·재열기 뒤 대기/접수 notice 복원과 transcript 이미지 재생은 후속 범위다.                                                                                                                                                                                            |

Codex·LM Studio의 약 2048 px와 LobeHub의 1920 px/JPEG 품질 조정은 변환 시작값의 선례다. 기존 제품에서도 대기 행·방향 수정·재접속 복원은 서로 다른 동작이다. #94는 두 모드의 실시간 전송과 수락 안내까지 제공한다. [SOTA 비교 보고서](https://github.com/handochan/aelix-studio/issues/94#issuecomment-7059742551) · [SOTA 이후 사용자 결정](https://github.com/handochan/aelix-studio/issues/94#issuecomment-7060213770)

### 현재 경로와 측정 근거

기준은 Studio `7ecb20dc`(#92 병합), Host `8f55032a`(`host-v0.2.2-aelix.7`), ACP `369df4784`, native `83714045`다. Studio는 현재 Host에서 확인한 파일 경로와 `@@` 대화 참조를 하나의 text에 넣는다(A). H1에 base64를 직접 넣는 B1은 전체 HTTP body 64 KiB 때문에 원본 48 KiB도 온전히 담을 수 없다. 이 설계(B2)는 작은 참조만 H1에 실어 D12의 Host 변경을 줄이고, D01에 따라 wheel을 수정하지 않는다. D20에 따라 기능 dispatch는 독립 RunningInput 모듈과 기존 composer에 둔다. [baseline.json:7–43](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/scripts/studio-preview/baseline.json#L7-L43) · [decisions.md:11–22](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/docs/studio-release-train/decisions.md#L11-L22) · [decisions.md:64–67](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/docs/studio-release-train/decisions.md#L64-L67) · [references.ts:25–78](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/references.ts#L25-L78) · [Host 설계 #48](https://github.com/handochan/aelix-studio-host/pull/48) · [H1 구현 #49](https://github.com/handochan/aelix-studio-host/pull/49)

고정 ACP A1은 `turnId, message, requestId` 세 키만 받아 native에 text만 쓴다. 일반 ACP prompt는 이미지 block을 native `images[]`로 변환한다. 클래식 `steer`·`follow_up`도 `mimeType, data`를 받아 같은 `UserMessage`의 text 뒤에 이미지를 붙인다. steer는 tool batch 경계 등에서, follow-up은 안쪽 루프 종료 뒤에 drain된다. reducer가 교체한 내용이 모델 문맥에 들어간다. OpenAI Chat Completions는 data URL, Responses는 `input_image`, Anthropic은 base64 `image.source`, Google은 `inlineData`를 쓴다. 이 중 HTTP 수신 바이트를 실행 검증한 것은 **OpenAI Chat Completions 호환 합성 서버**다. [session_relay.py:138–179](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/runtime/session_relay.py#L138-L179) · [session.py:1395–1434](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L1395-L1434) · [rpc_mode.py:1176–1224](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-coding-agent/src/aelix_coding_agent/rpc/rpc_mode.py#L1176-L1224) · [core.py:2041–2052](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/core.py#L2041-L2052) · [core.py:2099–2106](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/core.py#L2099-L2106) · [loop.py:233–251](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/loop.py#L233-L251) · [loop.py:305–314](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/loop.py#L305-L314) · [openai_completions.py:219–236](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/openai_completions.py#L219-L236) · [\_openai_responses_shared.py:296–309](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/_openai_responses_shared.py#L296-L309) · [\_anthropic_transforms.py:156–174](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/_anthropic_transforms.py#L156-L174) · [\_google_shared.py:270–286](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/_google_shared.py#L270-L286)

| 검증 경계             | 관측 결과                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 고정 native 직접 호출 | 최초 실험은 **메모리 세션·확장 비활성**이었다. 5 MiB PNG는 2×2 이미지에 부가 청크를 넣은 것이고 JPEG는 782 B였다. 일반 native prompt와 두 큐에서 마지막 user 메시지의 바이트만 비교했다. 텍스트 전용 모델은 ACK 뒤에도 이미지 block 0개였다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 동일 ACP stdio 역요청 | macOS arm64 M5 Pro, 고정 ACP에 시험 handler를 붙이고 Python 모의 Host가 응답했다. **3,932,160 B는 과거 부하 시험 크기이며 제품 파일 한도를 초과한다.** 7회 모두 데이터 **27왕복 + 완료 1왕복**, SHA-256 일치. 전체 중앙 159.1 ms(157.0–167.0), 데이터 왕복 189회 중앙 5.82 ms·p95 6.58 ms. raw 청크 147,264 B, 최대 JSON 응답 196,560 B(개행 제외), 모의 외곽 body 179 B였다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 메모리                | pull 중 ACP Python heap peak 중앙 5.09 MiB, RSS 고수위 증가 ACP 8.20–9.19 MiB·모의 Host 0.78–1.27 MiB. Host는 원본을 이미 보유한 상태에서 쟀다. 전체 픽셀 경로에는 base64 bytes·문자열·JSON·UTF-8·pipe 복사본과 native의 이벤트 재직렬화가 더해진다. 6 MiB 원본의 base64 전체 복사본 5개만 가정해도 약 40 MiB다. 전체 RSS 실측은 플랫폼 수용에 남는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 파일 기반 세션·재전송 | 고정 native/ACP wheel payload와 pin을 대조했다. 실제 ACP coding profile·명시적 번들 `bridge.py`·파일 세션, 시험 픽셀 handler와 합성 provider로 **PNG 3,669,060 B(1152×1061), JPEG 3,670,523 B(1493×1493)**를 각각 별개의 steer/follow-up에 넣고 순서를 바꿔 반복했다. 양쪽 실행 모두 provider 요청 #3에 기존 steer와 새 follow-up bytes가 원래 순서·MIME·digest로 들어갔다(9,801,293 B). 두 이미지가 native JSONL에 남았고, 실제 ACP close/load 후 요청 #4에서도 재전송됐다(9,801,376 B). ACP live/reload 이미지 update는 모두 0건이었다. 시험에서 permission 채널만 TCP loopback을 사용했다. [session.py:249–287](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L249-L287) · [server.py:347–357](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/server.py#L347-L357) |
| native 양방향 줄      | 4096 B씩 공급한 native 줄 조립의 3회 중앙값은 5/7/8/11/12 MiB에서 **151/396/530/1,071/1,271 ms**였다. 실제 Stop ACK 시간은 아니다. 별도 합성 `agent_end`(사용자 이미지 2개+도구 이미지 2개, 19,572,587 B)를 고정 ACP reader에 넣자 `rpc_closed=true`와 대기 RPC 실패가 관측됐다. [\_jsonl.py:112–147](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-coding-agent/src/aelix_coding_agent/rpc/_jsonl.py#L112-L147) · [\_jsonl.py:189–200](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-coding-agent/src/aelix_coding_agent/rpc/_jsonl.py#L189-L200) · [session.py:665–700](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L665-L700)                                                                              |

위 결과는 Rust Host의 중첩 요청·인증·SDK trace, 실제 Windows/Linux, Studio 화면, 외부 provider, 새 receipt 멱등성, 마지막 청크 유실 및 A-0의 훅 동작까지 검증한 결과로 사용하지 않는다. 기존 Studio E2E는 경로 텍스트 방식의 근거다. [studio-running-input.e2e.ts:211–291](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/tests/e2e/features/conversations/acp/studio-running-input.e2e.ts#L211-L291)

### 첫 카드 A-0. 모델 요청의 이미지 윈도우

**판정 전 상태는 미검증이다.** 고정 native의 `context` 이벤트는 매 LLM 호출 전 message 목록을 받고 `ContextResult(messages=...)`를 반환할 수 있다. 목록 복사는 얕다. 번들 bridge가 원본 객체를 제자리에서 수정하면 파일 이력까지 바뀔 위험이 있다. 교체할 메시지와 그 안의 content 목록을 새로 만들고, untouched block과 역할·도구 호출 ID·순서를 보존한다. 반환 목록이 실제로 provider용 `convert_to_llm`에만 쓰이는지 실행으로 확인한다. [hooks.py:405–415](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/hooks.py#L405-L415) · [core.py:5438–5463](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/core.py#L5438-L5463) · [loop.py:320–337](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/loop.py#L320-L337)

**시험할 정책.** 각 요청에서 일반 prompt·두 큐·도구 결과·재개 이력의 이미지 발생 건을 순서대로 센다. 같은 파일이 두 메시지에 남으면 두 장이다. 최신 이미지부터 raw 합계 8 MiB·20장 이내로 유지하되 provider별 더 낮은 크기·개수·치수·토큰·전체 요청 한도를 적용한다. 오래된 초과 이미지만 같은 위치의 text 자리표시로 바꾼다(예: `[Earlier image omitted from this request due to the image limit.]`). 이번 제출은 v1 축소를 마친 이미지 전체로 판정한다. 변환 뒤에도 넘으면 전부 보존하고 전송을 차단한다. 원래 JSONL의 bytes, 큐 접수 영수증 및 사용자 transcript는 이 변환으로 변경하지 않는다.

| A-0 시험                 | 통과 증거                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 호출마다 변환, 원본 불변 | 고정 coding bridge와 파일 세션에서 모델 요청마다 raw bytes·장수·메시지 순서를 독립 캡처한다. 교체 자리표시는 해당 HTTP payload에만 있고 native 메모리 이력·JSONL·load/fork에는 원본 MIME·digest가 남는지 비교한다. 정상적으로 추가된 새 턴과 기존 entry 변조를 구분한다.                                                                                                                                                                                          |
| 출처와 경계              | 일반 전송 + steer/follow-up + 이미지 반환 tool + resume를 한 fixture에 넣고, raw 8 MiB와 20/21장 경계를 각각 넘긴다. 이후 reducer가 추가·교체한 이미지, tool-result 역할과 call ID, 비이미지 텍스트가 올바른지 본다. 출력 이벤트의 stdout 크기도 따로 측정한다.                                                                                                                                                                                                   |
| provider 거절 뒤 복구    | 과거 이미지 개수/크기로 HTTP 거절을 재현한 뒤, **같은 파일 세션에서 다음 명시적 입력**으로 오래된 이미지만 제외하고 성공하는지 확인한다. 새 큐 쓰기 자동 재발행이 없어야 한다. 인증 장애 등 이미지 예산 이외의 거절은 별도로 보고한다.                                                                                                                                                                                                                            |
| 사용자 안내              | H1 v1은 `notifications: []`이다. Studio가 표준 턴 변화·재연결 때 현재 binding의 읽기 전용 `_aelix/session/input/image-state`를 조회해 해당 모델 요청의 제외 장수·사유를 읽고 ‘이전 이미지 N장은 이번 모델 요청에서 제외됨’을 표시한다. 원본 삭제·철회·모델 열람 완료를 뜻하지 않는다. [acp_relay.rs:67–82](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-ai-agent/src/protocol/acp_relay.rs#L67-L82) |

**판정.** 네 항목을 입증하면 bridge 훅 방식을 채택한다. 원본 변조, tool/resume 누락, 거절 뒤 회복 실패 또는 누락 안내를 해결하지 못하면 H-1 이전에 **고정 상한 대안**을 선택한다. 이 경우 같은 native 세션의 `보관 + 미정산 예약 + 후보`가 **실제 보관 이미지 합계 8,388,608 B 이하이고 20장 이하**일 때만 픽셀을 받는다. 일반 전송(기존 경로는 파일당 5 MiB까지 가능)·도구·확장·resume 이미지도 모두 차감한다. 최대 크기 파일 약 두 장으로 남은 바이트가 작아질 수 있고, 작은 이미지 20장으로도 한도에 닿음을 UI에서 알린다. 턴 종료·Stop·재연결로 초기화하지 않는다. 도구 결과를 포함해 신뢰할 집계를 얻거나 제한을 집행할 수 없는 세션은 픽셀을 차단한다.

고정 상한에 닿으면 **수동 compact**, 경로만 전송, 새 대화를 안내한다. `compaction_end`를 관측한 뒤 실제 활성 이력을 다시 세어 요약에서 빠진 이미지 분량만 돌려준다. 이벤트만으로 공간을 확보했다고 표시하지 않는다. 물리적으로 남은 과거 JSONL 전체와 모델이 다시 읽는 활성 분기를 구별하고, load/fork 시 복원된 분기로 다시 계산한다. API가 이미 거절하는 이력이면 경로만 전송해도 해결되지 않을 수 있다. D01 범위에서 대안도 안전하게 입증되지 않으면 해당 조합의 픽셀 지원은 보류하고 N-1에 필요한 계약을 적는다. [session.py:703–707](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L703-L707) · [core.py:5438–5463](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/core.py#L5438-L5463)

### v1 자동 축소 · S-1a worker와 S-1b 화면 연결

**위치.** Electron desktop과 로그인 WebUI의 RunningInput 모듈이 같은 dedicated worker를 쓴다. 원본을 읽어 변환본을 별도 업로드한 뒤, 변환본의 `ChatFileRef`만 기존 byte grant에 넘긴다. 사용자가 고른 경로·파일·칩, 일반 전송, ‘경로만 보내기’는 계속 원본을 가리킨다.

| 후보                       | 근거와 비용                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Studio renderer · 채택** | 브라우저의 `createImageBitmap`, `OffscreenCanvas` 2D, `convertToBlob`을 두 표면에서 공유한다. 변환본을 보내기 전에 동일 bytes로 썸네일·크기를 만들 수 있다. Host 파일을 WebUI로 읽고 변환본을 다시 업로드하는 전송 비용이 있으므로 입력 바이트와 시간을 제한한다. 기존 multipart 업로드는 Electron backend와 same-origin WebUI를 지원하고 `AbortSignal`을 받는다. [FileService.ts:18–64](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/FileService.ts#L18-L64) · [chatFile.ts:30–46](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/common/types/chatFile.ts#L30-L46)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ACP/Python                 | 고정 macOS qualification 환경의 격리 Python에서 native는 **Pillow 11.3.0**, adapter는 `PIL`·`cv2`·`pyvips`·`imageio`·`wand`를 찾지 못했다. 번들 recipe는 native와 adapter 패키지를 다른 디렉터리에 복사하며 ACP launcher는 `adapter-site`를 선택한다. ACP의 선언된 필수 의존성도 비어 있다. Pillow가 번들 어딘가에 있다는 이유로 ACP가 이를 import할 수 있다고 가정할 수 없다. 신규 wheel이나 native-site 차용은 다섯 target의 의존성·license·격리 검증을 늘린다. [native-requirements.lock:587–592](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/scripts/studio-preview/packaging/native-requirements.lock#L587-L592) · [bundle.py:140–147](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/scripts/studio-preview/packaging/bundle.py#L140-L147) · [launch.py:296–305](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/scripts/studio-preview/packaging/launch.py#L296-L305) · [pyproject.toml:5–12](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/pyproject.toml#L5-L12) |
| Host                       | 결정 1·4대로 owner 확인, 범용 파일 읽기/업로드, RAM byte grant만 맡는다. 크기 조정·색 처리·이미지 코덱을 Host에 넣으면 D12·D17 예외가 커진다. ACP는 받은 결과의 MIME·치수·길이·digest와 모델/턴 예산을 계속 독립 검증한다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**S-1a의 처리 순서.** 아래 작업 예산과 품질 값은 초기 구현값이다. 파일당 3,750,000 B, 제출당 4장·6 MiB, 최종 native 줄 8 MiB는 결정 2·5의 필수 상한이다.

1. **전송과 미리보기를 따로 판정한다.** 모델·모드·권한·4장 한도를 확인한다. 정적 PNG 또는 EXIF 방향이 없거나 1인 JPEG가 모든 전송 한도에 맞으면 기존 ref의 bytes를 보낸다. **이 무변환 경로는 원본 EXIF/GPS 등 메타데이터도 그대로 전달한다.** JPEG 방향 2–8은 전송 한도 안이어도 변환기를 거쳐 회전·반사를 픽셀에 한 번 반영한다. 방향만 바꿀 때는 예산 안에서 표시 치수를 유지한다. 재인코딩한 파일에는 원본 EXIF/GPS를 복사하지 않는다. 썸네일 유무는 전송 판정에 쓰지 않는다.
2. **원본을 제한해서 읽는다.** 확보된 File/Blob을 우선 사용한다. ref만 남으면 owner 확인 metadata와 인증된 `/api/fs/stream`을 쓴다. worker가 임의 경로나 URL을 열지 않는다. 변환용 원본은 실제 수신량으로 16 MiB를 제한한다. 같은 Blob에서 PNG IHDR·청크 또는 JPEG SOF·EXIF를 파싱해 형식·길이·치수와 안전한 픽셀 수 연산을 확인한다. 원본이 바뀌거나 손상·불명확하면 중단하고 ref를 담은 stream query·응답은 진단에서 생략한다. [routes.rs:523–578](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-file/src/routes.rs#L523-L578) · [static-server.ts:132–158](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/web-host/src/static-server.ts#L132-L158)
3. **디코드 경로를 고른다.**
   - 전체 래스터를 여는 경로는 16,777,216픽셀 이하, 각 변 16,384 px 이하다. 변환해야 하는 큰 PNG·긴 스크롤 캡처가 이 범위를 넘으면 ‘이 PNG는 안전한 변환 크기를 초과합니다’와 한도·경로 선택을 표시한다. 반면 전송 한도 안인 파일의 썸네일만 얻으려고 큰 래스터를 열지 않는다. 동일 digest의 안전한 preview가 없거나 생성이 실패하면 **아이콘 + 표시 방향 기준 W×H**로 대체하고 픽셀 전송을 계속한다. 기존 composer `FilePreview`는 `getImageBase64`로 가져온 원본을 주 renderer 이미지 요소에 준다. 60 px 칩이 보인다는 사실은 작은 비트맵이 확보됐다는 근거가 아니다. receipt용으로 이 경로를 다시 호출하지 않는다. [FilePreview.tsx:64–94](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/components/media/FilePreview.tsx#L64-L94) · [FilePreview.tsx:112–125](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/components/media/FilePreview.tsx#L112-L125)
   - **큰 JPEG는 원본 픽셀 수만으로 거절하지 않는다.** 표시 목표 치수를 `createImageBitmap(blob,{resizeWidth,resizeHeight,resizeQuality:'high',imageOrientation:'from-image'})`에 전달한다. 큰 원본에 이 Blob 경로를 쓰려면 해당 엔진·입력 유형의 중간 래스터까지 예산 내라는 근거가 있어야 한다. 아래에서 측정한 Chromium 138/145에서는 대신 worker의 **WebCodecs `ImageDecoder`**에 부호화 축 기준 `desiredWidth/desiredHeight`를 먼저 지정하고, 축소된 VideoFrame에서 목표 bitmap/canvas를 만든다. EXIF 5–8은 부호화 축과 표시 축의 가로·세로를 교환한다. 실제 프레임 치수·방향을 확인해 중복 회전이나 불필요한 확대를 피한다. 디코더·frame·bitmap을 닫고 해당 경로가 미지원·미검증이면 대형 전체 래스터를 열지 않는다. [WebCodecs ImageDecoder](https://www.w3.org/TR/webcodecs/#imagedecoder-interface) · [Chromium 138 Blob decoder](https://github.com/chromium/chromium/blob/138.0.7204.251/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_factories.cc#L387-L450) · [Chromium 145 Blob decoder](https://github.com/chromium/chromium/blob/145.0.7632.6/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_factories.cc#L411-L475) · [WebCodecs 목표 크기 전달](https://github.com/chromium/chromium/blob/138.0.7204.251/third_party/blink/renderer/modules/webcodecs/image_decoder_core.cc#L448-L455) · [JPEG 디코드 배율](https://github.com/chromium/chromium/blob/138.0.7204.251/third_party/blink/renderer/platform/image-decoders/jpeg/jpeg_image_decoder.cc#L942-L962)
   - **방향·색·형식.** 검증된 경로에서 EXIF를 한 번 적용하고 sRGB·alpha 2D canvas에 그린다. 변환본을 다시 디코딩해 방향·색·MIME을 확인한다. 넓은 색역은 sRGB에서 달라질 수 있다. 투명/반투명·스크린샷은 정적 PNG로, JPEG는 JPEG로 인코딩한다. GIF·APNG·WebP·SVG·HEIC·AVIF·BMP는 v1 경로 전송 대상이다. 애니메이션 첫 장만 보내지 않는다. [HTML Standard · ImageBitmap](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap) · [Canvas 직렬화](https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file)
4. **크기·품질을 제한된 횟수만 시도한다.** 첫 긴 변은 `min(원본 표시 긴 변, 2048)`이다. 다음은 직전 긴 변의 75%(반올림)로 줄이고, 2048 px에서 시작하면 1536 → 1152 → 864 px 순으로 최대 네 치수를 시도한다. 작은 원본도 확대 없이 같은 비율로 줄인다. 두 변은 최소 1 px로 둔다. 매번 같은 방향 정규화 bitmap 또는 같은 원본의 축소 디코드 프레임에서 그린다. PNG는 각 치수에서 1회(quality 인수 없음), JPEG는 같은 치수에서 품질 `0.85 → 0.75 → 0.65` 순서다. 최종 Blob의 실제 MIME과 헤더가 요청 형식인지 확인한다. 브라우저가 JPEG 요청에 PNG를 반환하면 성공으로 처리하지 않는다. 파일별 목표는 3,750,000 B와 남은 묶음 예산 중 작은 값이다. 묶음 예산은 전송본 raw 합계 6 MiB 및 현재 모델의 더 낮은 한도에서 시작해, 예상 native JSON 본문의 실제 escape·고정 설명·ID·개행과 파일별 base64 padding 공간을 제외한 전송 가능량으로 낮춘다. 합계 초과 시 작은 적합 파일을 먼저 고정하고, 나머지 파일에 잔여 예산을 균등 배분한다(동률은 원래 선택 순서). 원래 순서 전체가 6 MiB와 **예상 줄 길이**에 맞는 첫 결과를 선택한다. 불가능하면 초안 전부를 보존한다. RGBA 16 MP는 64 MiB, 2048² 출력 표면 하나는 16 MiB다. 한 renderer에서 디코드·인코딩은 한 장씩, 소유한 Blob·픽셀 버퍼의 계획 예산은 **160 MiB**로 두고 source/destination·인코더 임시 사본을 포함한 실제 RSS는 기기별 측정으로 검증한다.
5. **코덱 시간과 네트워크 시간을 따로 잰다.** 5초/장·15초/제출에는 worker의 SHA-256 계산(원본 및 파생본), 디코드·인코드·재시도 시간을 합산한다. 무변환 파일은 한 번만 해시한다. 순수 JS 경로는 해시 대상과 처리한 bytes/전체를 표시하고 청크 사이에 취소를 확인한다. 단일 Web Crypto digest는 시작·완료만 표시한다. 다운로드와 업로드에는 이 시계를 쓰지 않는다(16 MiB를 10 Mbps로 받는 데만 약 13.4초). 네트워크는 연결/첫 응답 대기와 전송 중 **무진행 30초**를 단계별로 적용한다. 데이터 진척 시 무진행 타이머를 갱신하고 마지막 업로드 바이트를 보낸 뒤에는 응답 대기를 따로 잰다. 다운로드·업로드 단계, 진행 bytes/전체 또는 크기 미상의 진행량, 취소 동작을 표시한다. 취소·Stop·초안/턴 교체 시 fetch/XHR를 abort하고 worker를 종료하며 늦은 결과를 폐기한다. timeout·실패는 원본 초안·칩 보존과 명시적 경로 선택으로 처리한다. H1 쓰기 발행 후에는 기존 lookup 계약을 따른다.
6. **파생 업로드와 멱등성.** 아래 origin별 worker 해시 경로로 **선택 원본과 실제 출력 Blob 각각**의 SHA-256을 계산한다. 무변환이면 같은 bytes를 한 번만 해시한다. 한 제출 동안 선택 순서·원본 digest·변환 recipe 버전별로 출력 Blob·digest·치수·bytes를 한 번만 고정한다. 실제 출력으로 만든 새 File을 불투명한 임시 이름으로 기존 multipart 경로에 업로드한다. 대화 ID, desktop 자격과 로그인 WebUI의 cookie·Origin·필요한 CSRF를 확인한 전송을 사용해 `{kind:'upload',path}`를 얻는다. 같은 prepareId는 같은 ref를 재사용한다. grant 길이·digest가 renderer의 출력과 일치할 때만 제출한다. ACP는 순서 있는 불변 grant/전송 digest와 실제 본문·모드·turn을 지문에 묶는다. **원본 hash만으로 중복을 판정하지 않는다.** 같은 requestId/다른 출력은 충돌이다. 브라우저별 재인코딩 결과가 다르므로 lookup 때 다시 인코딩·업로드·큐 쓰기를 하지 않는다. 파일 변경이나 새 파생본은 명시적 새 제출이다. [FileService.ts:88–121](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/FileService.ts#L88-L121) · [routes.rs:661–675](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-file/src/routes.rs#L661-L675) · [service.rs:925–953](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-file/src/service.rs#L925-L953)
7. **원본과 임시 파일 수명.** 파생 upload ref는 사용자 초안의 원본 칩을 교체하지 않는다. ‘경로만 보내기’는 원본 ref로 새로 실행한다. 기존 관리 업로드는 Host 임시 파일이고 H-1 승인 사본은 RAM이다. XHR abort·응답 유실로 Host에 이미 만들어진 파일까지 지워졌다고 간주하지 않는다. S-1a는 성공한 파생 ref의 보관/해제를 기존 관리 업로드 수명과 대조하고 유실·중단 시 quota와 정리 범위를 검증한다. 응답이 불명확한 업로드를 자동 반복하거나 원본 경로를 삭제하지 않는다.

**국소 확인.** macOS에서 Electron 37.10.3(Chromium 138)과 headless Chromium 145의 실제 worker/OffscreenCanvas를 루프백으로 확인했다. EXIF 6 JPEG는 회전 후 1536×3072에서 1024×2048로 인코딩됐고 원본 Artist 표식이 사라졌다. P3 샘플 RGB(128,100,90)는 sRGB canvas에서 (133,99,88)로 관측됐으며 PNG를 다시 디코딩해 투명도 샘플 0·128과 해당 P3 fixture의 sRGB (133,99,88)을 각각 확인했다. 2프레임 GIF를 일부러 디코드하면 첫 프레임만 그려졌다. 무작위 픽셀 PNG 9,450,492 B는 2048 px에서 오히려 커졌고 1152×864에서 두 환경 모두 **약 3.3 MB**로 파일 한도를 통과했다. 이 검사는 합성 파일의 브라우저 API 동작을 확인한 것으로, 앱의 업로드/취소 전체 경로, Windows·Linux·다른 WebUI 브라우저의 메모리와 색 처리는 S-1a/S-1b 수용 항목이다.

**48 MP JPEG 확인.** macOS에서 같은 8064×6048 baseline JPEG(13,005,289 B)를 새 renderer마다 worker로 읽었다. 입력 Blob 준비 직후부터 2048×1536 JPEG 인코딩 완료까지 OS renderer 프로세스의 물리 메모리 고수위 증가량을 비교했다. Blob resize 옵션 경로는 Electron 37.10.3에서 **260.6 MiB**, headless Chromium 145에서 **260.5 MiB**였다. 두 버전의 Blink는 목표 치수 없이 먼저 프레임을 디코드한 뒤 bitmap 옵션을 적용한다. WebCodecs가 먼저 낸 프레임은 **2016×1512**, 같은 최종 출력 치수에서 증가량은 각각 **61.5 MiB·52.1 MiB**였다. 이는 한 baseline fixture의 관측이다. progressive JPEG·GPU/다른 프로세스·다른 브라우저는 160 MiB 예산을 별도 검증한다.

**WebUI 지원 범위.** 기존 안내는 ‘modern web browser’와 Chrome·Firefox·Safari·Edge를 명시하며 버전 하한은 제시하지 않는다. S-1a는 **현재 안정판 Chromium/Chrome, Edge, Safari, Firefox**와 번들 Electron을 대상으로 한다. dedicated worker 안에서 `createImageBitmap`·OffscreenCanvas 2D·sRGB·PNG/JPEG 인코딩 및 실제 반환 MIME, EXIF 1–8 비대칭 표식의 치수·네 모서리를 검사한다. API 존재·UA만으로 통과시키지 않는다. 큰 JPEG는 secure context의 `ImageDecoder.isTypeSupported('image/jpeg')` 등 선택 경로의 기능과 메모리 검증도 필요하다. 미지원 또는 동작 fixture 실패 시 **변환이 필요한 픽셀만 차단**하고 초안·경로 선택을 유지한다. 무변환으로 안전한 입력은 계속 허용한다. [webui.md:16–23](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/docs/guides/webui.md#L16-L23) · [webui.md:480–489](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/docs/guides/webui.md#L480-L489)

**일반 HTTP LAN WebUI.** 문서의 `http://YOUR_IP_ADDRESS:3000`은 localhost와 달리 비보안 컨텍스트다. worker 안에서 필요한 기능을 각각 검사한다. [WebUI 접속 예](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/docs/guides/webui.md#L465-L470) · [Web Crypto API · Crypto](https://w3c.github.io/webcrypto/#crypto-interface)

| §10의 용도                 | worker에서 사용할 경로                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 원본·전송본·preview 무결성 | `crypto.subtle.digest`를 사용할 수 있으면 SHA-256으로 계산한다. 없으면 기존 **`@aws-crypto/sha256-js@5.2.0`**의 `Sha256`에 Blob의 원시 바이트를 `Uint8Array` 청크로 `update`하고 `digestSync()`로 같은 32바이트를 얻는다. 두 경로 모두 소문자 hex로 비교한다. 전송본과 grant의 digest 불일치는 제출을 차단한다. 무변환 PNG/JPEG도 원본 digest와 grant가 일치하면 그대로 보낸다. preview만 없거나 일치하지 않으면 아이콘 + W×H를 쓴다.                                                                                                                                                     |
| ID 발급                    | `crypto.randomUUID()`도 secure-context 전용이다. Studio에서 prepareId나 불투명한 업로드 이름을 만들 때는 기존 `createRequestId()`처럼 HTTP에서도 제공되는 `crypto.getRandomValues`를 사용한다. 쓰기 requestId는 같은 클릭의 UUIDv7을 유지하고, readerId는 ACP에서 발급한다. 안전한 난수원이 없으면 제출을 보류한다. [transport.ts:84–95](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/transport.ts#L84-L95)                                                                        |
| 이미지 처리                | 같은 origin의 dedicated worker, File/Blob 읽기, `createImageBitmap`, `OffscreenCanvas` 2D·sRGB·`convertToBlob`, 취소 가능한 fetch/XHR와 object URL은 기능별로 검사한다. 해시 fallback과 해당 코덱 검사를 통과한 일반 축소는 HTTP에서도 진행한다. 160 MiB 예산을 맞추려면 secure-context 전용 `ImageDecoder`가 필요한 큰 JPEG는 그 API 없이 전체 디코드하지 않는다. 이때는 **‘현재 HTTP 연결에서는 이 큰 JPEG를 안전하게 축소할 수 없습니다. HTTPS로 다시 열거나 원본 경로만 보내세요.’**를 표시하고 초안을 보존한다. 보안 컨텍스트에서도 코덱이 없으면 브라우저 기능 미지원으로 안내한다. |

**S-1a 의존성.** 현재 `@aws-crypto/sha256-js@5.2.0`은 `@aws-sdk/client-bedrock`과 `@aws-sdk/nested-clients`가 가져오는 전이 의존성이다. worker를 소유한 `@aionui/desktop`은 S-1a 구현 PR에서 `packages/desktop/package.json`의 `dependencies`에 `"@aws-crypto/sha256-js": "5.2.0"`을 직접 선언하고 `import { Sha256 } from '@aws-crypto/sha256-js'`로 사용한다. 기존 잠금 버전의 코드를 재사용한다. 해당 manifest와 `bun.lock`의 workspace 의존 관계 갱신은 AGENTS.md에 따라 다른 세션과 직렬화한다. [desktop/package.json:1–10](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/package.json#L1-L10) · [bun.lock:290–292](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/bun.lock#L290-L292)

**기존 소량 입력 확인.** 매니페스트·lockfile 변경 없이 만든 Vite 시험 번들을 Chromium 145에서 `http://studio94.test`(loopback으로만 매핑, worker의 `isSecureContext === false`)와 `http://localhost` 대조군에서 실행했다. 비보안 origin에서는 `subtle`·`randomUUID`·`ImageDecoder`가 없었고 난수 생성·2D JPEG 인코딩은 동작했다. 원본 75,516 B와 출력 814 B 모두 JS SHA-256이 독립 해시 검사를 통과했고, localhost에서는 Web Crypto와도 일치했다. 실제 LAN 로그인·제품 번들 수용은 아래에 남긴다. [package.json:78–85](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/package.json#L78-L85) · [bun.lock:256–264](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/bun.lock#L256-L264)

### 승인·인수·쓰기 계약

**권한과 책임.** 보호된 브라우저의 Origin·CSRF/owner, desktop의 기존 자격, 현재 단독 대화와 live 내장 ACP 연결·binding을 Host가 확인한다. 기존 resolver는 핸들이 아닌 경로 문자열을 반환한다. 일반 전송과 동일하게 Project는 owner의 PE·root, Upload는 관리 임시 root, Local은 canonical 일반 파일 조건을 쓴다. Host는 해석된 경로를 열어 길이를 제한해 읽고 크기·파일 정체성 변화 여부를 확인한다. 별도 OS별 열린 핸들 containment 검사나 picker 출처 요건은 추가하지 않는다. 같은 OS 사용자의 도구를 격리하는 새 sandbox도 아니다. 승인 뒤에는 고정한 RAM bytes만 제공하며 원본 교체·삭제로 바뀌지 않는다. [chat_files.rs:63–128](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-project/src/chat_files.rs#L63-L128) · [acp_extension.rs:194–249](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-conversation/src/acp_extension.rs#L194-L249)

**발견.** Host의 범용 byte-source offer와 H1 offer를 모두 본 ACP만 initialize에 `*-images`와 읽기 전용 `input/image-state`를 광고한다. 새 Host 기능 비트는 Studio의 보호된 발견 결과에도 전달한다. 연결의 고정 메서드 목록과 현재 세션의 모델·남은 예산·사용 가능 사유는 별개다. 후자는 ACP 상태 조회와 쓰기 직전 검사에서 얻는다. 구형 조합은 기존 H1+A1의 선택 모드가 광고된 경우에만 경로 전송, 그렇지 않으면 idle 일반 전송을 제공한다. [acp_relay.rs:298–355](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-ai-agent/src/protocol/acp_relay.rs#L298-L355) · [session_relay.py:26–55](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/runtime/session_relay.py#L26-L55)

아래는 새 계약의 예시다. 원본 PNG가 축소된 경우의 wire와 해당 수락에 결합하는 renderer 메모리 상태를 함께 보인다. ID·경로·digest·data는 축약했다. `authorize`는 대화에 묶인 HTTP 준비 요청, `submit`은 기존 H1 외곽 형식, `read`·`finish`는 같은 ACP 연결의 역방향 요청이다.

```json
{
  "authorize": {
    "route": "POST /api/conversations/{id}/byte-grants",
    "body": {
      "prepareId": "p1",
      "bindingId": "b1",
      "refs": [{ "kind": "upload", "path": "<managed-derivative>" }]
    },
    "result": { "grants": [{ "id": "g1", "byteLength": 3309295, "sha256": "<digest>" }], "expiresInMs": 60000 }
  },
  "submit": {
    "bindingId": "b1",
    "method": "_aelix/session/input/steer-images",
    "payload": { "turnId": "t1", "requestId": "019b0000-0000-7000-8000-000000000094", "message": "", "grants": ["g1"] }
  },
  "read": {
    "jsonrpc": "2.0",
    "id": "acp-r1",
    "method": "_aelix/host/bytes/read",
    "params": { "sessionId": "s1", "bindingId": "b1", "ref": "g1", "readerId": "r1", "offset": 0, "maxBytes": 147264 }
  },
  "readResult": {
    "jsonrpc": "2.0",
    "id": "acp-r1",
    "result": { "offset": 0, "byteLength": 3309295, "sha256": "<digest>", "eof": false, "data": "<base64 chunk>" }
  },
  "finish": {
    "jsonrpc": "2.0",
    "id": "acp-r2",
    "method": "_aelix/host/bytes/read",
    "params": { "sessionId": "s1", "bindingId": "b1", "ref": "g1", "readerId": "r1", "offset": 3309295, "finish": true }
  },
  "finishResult": { "jsonrpc": "2.0", "id": "acp-r2", "result": { "released": true } },
  "receipt": {
    "accepted": true,
    "delivery": "native-queue",
    "turnId": "t1",
    "inputKind": "pixels",
    "captionAdded": true
  },
  "rendererNotice": {
    "requestId": "019b0000-0000-7000-8000-000000000094",
    "status": "queued",
    "images": [
      {
        "downscaled": true,
        "original": { "width": 2048, "height": 1536, "bytes": 9450492 },
        "sent": { "width": 1152, "height": 864, "bytes": 3309295, "sha256": "<digest>" }
      }
    ]
  }
}
```

1. **Studio 준비.** 클릭 시 초안·binding·turn·mode·원래 UUIDv7을 고정한다. composer의 ref 중복 제거·선택 순서를 재사용한다. 픽셀 파일의 최종 전송 ref(원본 또는 파생 upload)만 승인 대상으로 삼고, 일반 파일·`@@`는 #92의 기존 formatter가 text로 조립한다. slash 원문과 팀 제외, 부분 제출 금지를 유지한다. [messageFiles.ts:13–36](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/utils/file/messageFiles.ts#L13-L36) · [references.ts:47–78](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/references.ts#L47-L78) · [decideSend.ts:30–64](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/decideSend.ts#L30-L64)
2. **멱등 승인과 인수.** 같은 prepareId와 같은 대상은 준비 중이면 합류하고, 응답 유실 뒤 재준비해도 원래 grant·digest·만료시각을 반환한다. 입력 충돌은 거절한다. grant는 추측 불가능한 ID이며 owner·인증 세대·대화·연결·binding 범위에서만 유효하다. 한 reader가 인수하며 동일 reader의 마지막 offset 재조회는 동일 bytes를 돌려준다. 길이·digest·EOF를 ACP가 검증하고 finish ACK까지 마지막 청크를 보관한다. 중복 finish는 완료 표식으로 응답한다. 미사용 60초·인수 30초·완료 표식 10분, 준비 1건/binding·2건/owner·4건/Host, RAM 사본 총 32 MiB를 운영값으로 제안한다. 실패·권한 회수·binding 교체·종료·만료 시 회수한다. 원본 파일은 지우지 않는다.
3. **동일 연결의 역요청.** H1 HTTP 전체 요청은 64 KiB, ACP→Host H1 확장 결과는 256 KiB, 내장 Host 공통 stdio는 32 MiB, Host→ACP stdin은 약 16 MiB다. 청크는 별도 HTTP 요청이 아니다. Host→ACP의 byte read 응답은 JSON 전체 192 KiB(개행 제외) 안에 맞추며 ID/metadata가 길면 raw 청크를 줄인다. 1개씩 읽어 역압력을 유지한다. Rust Host는 §1의 `_aelix/*` 명명 규칙을 따르는 `_aelix/host/bytes/read` 하나만 협상된 내장 연결에 등록한다. 기존 역방향 `_aelix/session/*` 차단은 유지한다. Stop·permission이 청크 사이에 진행되어야 한다. [acp_extension_routes.rs:62–107](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-conversation/src/acp_extension_routes.rs#L62-L107) · [acp_relay.rs:17–38](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-ai-agent/src/protocol/acp_relay.rs#L17-L38) · [acp_relay.rs:492–559](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-ai-agent/src/protocol/acp_relay.rs#L492-L559) · [server.py:567–605](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/server.py#L567-L605)
4. **픽셀과 고정 설명.** ACP가 **무변환과 변환본 모두** bounded PNG/JPEG 헤더, 실제 길이·digest·MIME·치수·모델 능력을 독립 검사한다. PNG는 첫 IDAT까지 청크 구조를 확인해 그 전에 acTL이 있으면 APNG로 거절한다. 잘림·불명확한 구조도 거절한다. Host는 전체 디코드를 수행하지 않는다. 유효 이미지가 있고 조립한 `message`가 비거나 공백이면 ACP가 정확히 **`The user attached one or more images.`** 를 native RPC text로 넣는다. 사용자 텍스트·인용·DOM·기존 참조 본문이 있으면 그대로 보낸다. 임의의 경로·파일명을 설명으로 만들지 않는다. 기존 텍스트 전용 A1 계약도 그대로다. native는 선행 text block을 만들고 Anthropic 변환기는 이를 그대로 전달하므로 ACP 삽입이 빈 블록을 피한다. [\_anthropic_transforms.py:115–124](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/_anthropic_transforms.py#L115-L124) · [session_relay.py:138–145](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/runtime/session_relay.py#L138-L145)
5. **큐 쓰기.** ACP가 원래 requestId의 슬롯을 byte 인수 전에 예약하고, 버전·모드·turnId·원래 본문·고정 설명 정책 버전·순서 있는 불변 grant ID(각각 승인된 최종 전송본 digest에 결합)를 지문에 넣는다. 동일 지문은 결과를 공유하고 다른 이미지/모드는 충돌이다. ACP가 request ID·명령·고정 설명·escape된 message·각 이미지의 MIME/base64·구분 개행을 포함한 **실제 native JSONL bytes를 한 번 직렬화**한다. 그 버퍼가 8,388,608 B 이하여야 하며 재직렬화 없이 같은 버퍼를 쓴다. 초과면 native 쓰기 0회, 명시적 경로 선택이다. 직전에 binding·모델·Stop 세대·활성 turnId도 확인한다. 최종 확인과 첫 stdin write 사이에 await를 두지 않는다. native가 실제로 줄을 다 읽고 enqueue할 때까지는 경합이 남는다. enqueue 후 hook 오류도 가능하다. [session.py:622–639](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L622-L639) · [session_relay.py:131–179](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/runtime/session_relay.py#L131-L179)
6. **접수·취소·유실.** 쓰기 전 명시적 거절은 미발행이다. H1 handoff 뒤 HTTP 취소, stdin 단절, 120초 timeout, 응답 유실은 결과 불명이다. 원래 binding·requestId의 읽기 전용 lookup(600초, binding별 256개)만 사용하며 자동 재발행하지 않는다. 늦은 drain은 다음 명시적 prompt에 들어갈 수 있다. Stop은 개별 이미지 철회를 보증하지 않는다. 같은 binding·turn의 접수만 제출분을 정리하고 도중 편집/추가한 초안은 보존한다. [README.md:52–57](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/docs/host-32/README.md#L52-L57) · [README.md:68–81](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/docs/host-32/README.md#L68-L81) · [README.md:107–115](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/docs/host-32/README.md#L107-L115) · [useRunningInput.ts:259–294](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/pages/conversation/runtime/RunningInput/useRunningInput.ts#L259-L294)

### 모델 예산과 실제 전송 한도

- **바이트 단위.** 한 장 3,750,000 B는 base64 **5,000,000 B**다. provider/gateway의 5 MB를 5 MiB로 해석하지 않는다. 직접 Claude API의 문서상 한도가 더 커도, #94는 Bedrock·Google Cloud의 Claude 및 구별할 수 없는 gateway에 맞춰 이미지당 base64 5,000,000 B를 공통 한도로 쓴다. 세션/요청 원본 8 MiB 윈도우는 base64 약 10.67 MiB다. Bedrock InvokeModel 전체 body 25,000,000 B에서는 약 13.8 MB가 다른 내용에 남는다. 구형 20 MB inline 경로라면 여유가 더 적다. OpenAI·Gemini 등도 실제 배포 endpoint의 byte·개수·해상도·토큰 한도가 더 낮으면 그것을 적용한다. ‘이미지 지원’ 광고만으로 허용하지 않는다. [Claude Vision](https://platform.claude.com/docs/en/build-with-claude/vision#request-limits) · [Bedrock InvokeModel](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html) · [OpenAI 이미지 입력](https://developers.openai.com/api/docs/guides/images-vision) · [Google 입력 방식](https://ai.google.dev/gemini-api/docs/file-input-methods#method-comparison)
- **6 MiB는 변환 후 전송 파일의 base64 전 합계 상한이다.** 이미지의 base64 길이는 `Σ 4 × ceil(파일 bytes / 3)`이다. 전송 파일 합계 정확히 6 MiB는 base64만으로 8 MiB를 채우므로 JSON 필드·escape된 text·고정 설명·개행을 더하면 전송할 수 없다. UI는 ‘파일당 3,750,000 B · 최대 4장 · 전송본 합계 6,291,456 B · 전송 줄 8,388,608 B’와 선택 원본량·변환 후 전송량·실제/예상 직렬화량을 보여 준다. ACP의 **실제 UTF-8 줄(개행 포함)** 검사가 최종 판정이다. 초과 시 줄여야 할 양과 경로 선택을 안내하며 한 제출을 여러 큐 쓰기로 나누지 않는다.
- **전체 요청.** 모델 문맥에는 이전 user와 tool 결과가 함께 실린다. 바이트뿐 아니라 이미지 발생 횟수, 모델 입력 창, 시스템 지시·도구 정의·기존 텍스트를 포함한 전체 HTTP body를 검사한다. 제안하는 윈도우·고정 상한 모두 최대 **20장**을 적용해 많은 이미지에서 더 엄격해지는 provider별 치수 규칙을 피한다. 모델 변경·reducer 이후에는 최종 provider payload도 재검사한다. 고정 token 추정값(이미지당 1,372 등)만으로 byte 예산을 판단하지 않는다. [\_token_estimate.py:124–133](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-ai/src/aelix_ai/providers/_token_estimate.py#L124-L133) · [core.py:5733–5745](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/harness/core.py#L5733-L5745)
- **두 방향의 장애.** 현재 실행의 `agent_end`에 user 이미지뿐 아니라 tool 결과도 섞인다. 모델용 윈도우에 맞아도 native stdout 이벤트가 16 MiB를 넘으면 고정 ACP는 RPC 스트림과 세션을 닫는다. A-1은 실제 이미지 tool fixture에서 이벤트를 안전하게 제한/구조 처리하고 전체 세션 생존·미정산 결과를 검증해야 한다. 반대 방향에서는 ACP의 큰 줄 뒤로 Stop이 밀릴 수 있다. **8 MiB 줄 상한을 유지**하며 Windows 파이프 적체·큰 줄 직후 Stop을 100회 이상 재어 macOS/Linux와 비교한다. p95 1초·최대 2초 이하는 시험 목표 제안이다. 측정 뒤 N-3 및 한도 재검토를 결정한다. [loop.py:267–283](https://github.com/handochan/aelix-ai/blob/83714045439478b17ab0c61248dc5c414435927a/packages/aelix-agent-core/src/aelix_agent_core/loop.py#L267-L283) · [session.py:665–700](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L665-L700)

### 화면 상태·진단·수용

| 상황                   | 사용자에게 표시할 사실                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 준비·검증 실패         | `preparing`은 로컬 준비·축소·다운로드/업로드 중이다. 쓰기를 발행해 답을 기다릴 때는 기존 `pending`을 쓴다. 모델이 text-only이면 시각 입력을 지원하는 모델로 변경하도록 제안하고, 바뀐 모델/턴에서 다시 확인한다. 축소 실패·잔여 초과·미지원은 원본과 초안을 보존하고 명시적 ‘경로만 보내기’를 제공한다. GIF·APNG·WebP·SVG·**HEIC·AVIF·BMP**에는 ‘이 형식은 경로로만 보낼 수 있습니다’를 표시한다. A1 모드도 없으면 idle 일반 전송을 기다린다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 현재 턴의 접수(queued) | wire의 `accepted:true, delivery:"native-queue"`가 #92의 `status:"queued"`다. ‘이미지 픽셀이 steer/follow-up 큐에 접수됨’과 **제출한 각 이미지의 썸네일**을 같은 안내에 표시한다. 파생본이면 **‘축소됨(원본 → 전송 크기)’**로 표시 방향 기준 가로×세로와 실제 B 수의 전후 값을 함께 적고, 전송 digest로 만든 썸네일을 쓴다. 원본 통과에는 축소 표시를 붙이지 않는다. 방향만 정규화했으면 그 사실과 원본/전송 치수를 구분한다. 바뀔 수 있는 원본 경로를 늦게 다시 읽지 않고 제출 스냅샷의 digest와 일치하는 허가된 preview를 사용한다. 메모리 preview를 receipt의 원래 binding·turn·requestId에 묶고 닫기/대화 전환 때 해제한다. 미리보기가 없거나 실패·해제됐으면 아이콘 + W×H를 표시한다. 썸네일 실패만으로 보내기를 막거나 접수된 입력을 다시 보내지 않는다. [types.ts:7–15](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/types.ts#L7-L15) · [index.ts:36–43](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/renderer/services/runtime/RunningInput/index.ts#L36-L43) ‘경로만’ 접수 상태와 구분한다. |
| 소비(consumed)         | #94는 native ACK까지만 관측한다. #865에서 개별 입력의 소비·턴과 최종 내용이 연결된 뒤에만 ‘소비됨’을 표시한다. 시간 경과·다음 assistant 응답·접수 썸네일로 소비를 추정하지 않는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 빈 텍스트와 픽셀       | `captionAdded:true`이면 ‘모델에 보낼 입력에 Studio가 고정 영문 설명을 추가했습니다’와 실제 문구를 확인할 수 있게 한다. 큐 ACK만으로 모델 수신을 단정하지 않는다. 사용자 입력란과 transcript에 자동 설명을 사용자 발언으로 추가하지 않는다. 이후 투영이 필요할 때는 출처 표식으로 숨기거나 ‘Studio 자동 설명’으로 구분한다. 사용자가 우연히 같은 문장을 입력한 경우는 숨기지 않는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 유실·늦은 접수·재열기  | 불명 상태에는 ‘결과 확인’을 제공한다. 늦은 ACK는 원래 턴에만 붙이고 Stop 후 처리 여부는 미확인으로 남긴다. **접수 안내의 썸네일은 세션 이력 행이 아니다.** 재열기 뒤 대기·접수 상태 복원과 영구 이미지 기록/재생은 별도 카드다. #94는 로컬 notice를 복원하기 위해 입력이나 파생 파일을 다시 보내지 않는다. 기존 ACP는 recorded history를 우선 재생하고, 없을 때만 큰 `get_messages` 한 줄에 의존한다. 이 fallback 정비를 B2 전체의 선행 조건으로 두지 않는다. [server.py:136–145](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/server.py#L136-L145) · [server.py:347–357](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/server.py#L347-L357) · [acp_relay.rs:595–620](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-ai-agent/src/protocol/acp_relay.rs#L595-L620)                                                                                                                                                                                                                                  |

**H-1 병합 수용 조건.** 실제 Rust SDK에서 바깥 H1 요청을 처리하는 동안 안쪽 byte read가 끝나고 Stop·permission이 청크 사이에 진행돼야 한다. 성공·거절·timeout·연결 교체·마지막 청크/finish 응답 유실 fixture를 실행한다. **최대 약 196 KB인 청크 응답의 base64 픽셀 표식이 SDK 최고 trace 수준에서도 0건**이어야 한다. 경로·이름·본문·pixel bytes·base64/data URL·digest·grant 비밀도 Host 로그, stderr, HTTP trace, renderer console, crash breadcrumb에서 원문·escaped 표식 모두 0건이어야 한다. 실패하면 H-1을 통과시키지 않는다. native 환경에서 `ANTHROPIC_LOG`·`OPENAI_LOG` 등 SDK debug 설정을 제거하고 httpx/httpcore wire logging도 끈다. 진단에는 고정 코드·단계·개수·크기/지연 구간만 남긴다. [routes.rs:377–387](https://github.com/handochan/aelix-studio-host/blob/8f55032a0c45b86193ab2207743ffb52a8df6563/crates/aionui-file/src/routes.rs#L377-L387) · [session.py:653–663](https://github.com/handochan/aelix-acp/blob/369df47844d0b702e45808b0de7b2e2b05dedcd5/src/aelix_acp/session.py#L653-L663)

**통합 수용.** Electron·로그인 WebUI에서 일반 전송과 두 큐를 비교한다. PNG/JPEG 교차, 이미지 단독 caption, 사용자가 같은 영문 문구를 직접 입력한 경우, 참조 혼합, 한도 경계±1, model 변경, 늦은 ACK·Stop·조회와 썸네일 수명을 검사한다. 무변환 입력은 원본과, 축소 입력은 최종 파생 Blob과 provider의 디코딩 bytes를 각각 대조한다. 재개 후 모델 문맥을 확인하고 추가 사용자 행·중복 write가 없는지 확인한다. macOS·Windows·Linux의 전송 지연·RSS는 실제 Host/ACP 조합으로 기록한다.

**S-1a 출시 빌드·코덱 수용** (A-0과 병행, H-1/A-1 선행 없음)

- renderer의 첫 `new Worker(new URL(..., import.meta.url), {type:'module'})`가 실제 production build에 자산으로 들어가고 배포된 상대 경로·MIME·CSP로 실행되는지 검사한다. Electron의 **custom-protocol origin과 실제 packaged composer 경로**(고정판은 `loadFile`), web-host 정적 서버에서 각각 worker를 기동해 fixture 변환·응답까지 확인한다. dev 서버만으로 통과시키지 않는다. Analytics의 격리된 guest 권한을 넓히지 않는다. [electron.vite.config.ts:157–165](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/electron.vite.config.ts#L157-L165) · [index.ts:588–606](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/desktop/src/index.ts#L588-L606) · [static-server.ts:282–301](https://github.com/handochan/aelix-studio/blob/7ecb20dcde1d1562c9c8d14f2da2a34eaafadaff/packages/web-host/src/static-server.ts#L282-L301)
- **SHA-256 최악 크기 측정.** Desktop Electron과 실제 HTTP LAN WebUI 클라이언트 양쪽에서 출시 worker의 순수 JS 경로를 선택해 ① 16 MiB(16,777,216 B) 변환 원본과 실제 파생본, ② 3,750,000 B 무변환 파일을 측정한다. 독립 SHA-256과 비교하고 장치·브라우저, 해시 단계별 경과 시간·처리량, 해시를 포함한 장당/제출당 시간을 기록한다. 진행 bytes 갱신, 도중 취소, 5초/장·15초/제출의 기존 예산에 따른 통과 또는 시간 초과 시 초안 보존을 검증한다. 앞선 75,516 B/814 B 시험은 정확성 근거이며 이 성능 측정은 S-1a에 남는다.
- **비보안 origin 회귀.** 로그인 WebUI를 실제 LAN IP의 HTTP로 열어 window와 worker 모두 `isSecureContext === false`임을 확인한다(localhost·보안 예외 플래그 제외). 완성 번들로 무변환 이미지와 일반 canvas 축소 각각의 원본/전송본 SHA-256을 고정 벡터·Host grant·ACP 인수 bytes와 대조한다(Host/ACP 연동 전에는 fixture 사용). digest 결합 preview와 아이콘 대체, UUIDv7 생성·동일 키 재시도, 전송본과 다른 grant digest에서 쓰기 0회를 검사한다. `ImageDecoder`가 필요한 대형 JPEG는 비보안 연결 안내·명시적 경로 선택·native 쓰기 0회여야 한다. HTTPS/localhost 대조군에서도 동일 bytes의 digest가 일치해야 한다.
- **Safari와 Firefox 안정판 각각**에서 JPEG EXIF 1–8을 비대칭 네 모서리 fixture로 읽고 재인코딩·재디코딩 후 예상 치수·회전·반사를 검증한다. Electron·Chrome·Edge에도 같은 표를 적용한다. 이중 회전, P3→sRGB 허용 오차, PNG alpha, JPEG 대신 PNG가 반환되는 경우, 기능 미지원 fallback을 검사한다. 무변환 bytes의 EXIF/GPS 보존과 방향 2–8 정규화본의 EXIF/GPS 표식 제거도 대조한다. 로컬 Playwright Firefox 및 WebKit에서 EXIF 1–8 모서리를 확인한 것은 보조 근거이며 실제 Safari·안정판 배포 수용은 별도다.
- 48 MP baseline/progressive JPEG, 긴 스크롤 PNG, 잘린 헤더, acTL이 첫 IDAT 전에 있는 APNG를 포함한다. 원본·파생본의 크기와 피크를 기록한다. 전송 한도 안의 고압축 **8000×8000 정적 PNG**는 전체 preview 디코드 시 약 244 MiB다. 안전한 preview가 없어도 receipt용 추가 전체 디코드는 **0회**, 전송 준비는 성공하며 대체값은 아이콘 + 8000×8000이어야 한다. 같은 급의 **변환이 필요한** PNG가 디코드 한도를 넘으면 원본 유지·경로 선택이어야 한다.
- 기존 upload/Local/Project ref와 파생 upload로 여러 파일 및 예상/실제 JSONL 경계 −1/경계/+1을 검사한다. 제한된 대역폭의 다운로드+업로드가 15초를 넘겨도 진행 중이면 코덱 timeout으로 실패하지 않아야 한다. 별도로 무진행·응답 유실·사용자 취소·Stop·worker 종료를 주입하고 temp ref 범위·메모리 해제·초안 보존을 확인한다.

**S-1b 통합 수용** (S-1a + H-1 + A-1 뒤). `preparing → pending → queued`와 거절/결과 불명을 실제 Host·ACP에 연결한다. 위 무변환 PNG의 native write 1회와 아이콘 + W×H, 변환 실패 시 쓰기 0회, 같은 클릭의 출력 digest·requestId 및 원본/전송 bytes, ACK 뒤 전후 크기·썸네일 또는 대체 아이콘을 확인한다. 실제 직렬화한 줄(비ASCII·escape·자동 캡션·개행 포함), 모델/턴 변경, 명시적 원본 경로 선택, 근거 없는 소비 표시 0건, 재열기 후 notice 재발행 0건도 검증한다.

### 카드 순서와 후속 Issue 초안

| 순서 · 소유               | 실행 단위                                                                                     | 의존성과 종료 조건                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A-0 · ACP/번들 bridge** | native `context` hook 슬라이딩 윈도우 스파이크                                                | **H-1보다 먼저** 네 가지 판정 근거를 제출한다. 성공 시 윈도우, 실패 시 일반 전송을 포함하는 8 MiB·20장 고정 상한 및 수동 compact 복구의 집행 가능성을 확인한다. |
| **S-1a · Studio worker**  | worker 번들/로더, 변환·파생 업로드·fixture                                                    | A-0과 병행 착수한다. 기존 파일 API·모의 grant로 개발하며 H-1/A-1 의존성이 없다. Electron custom protocol·packaged UI와 web-host 정적 배포에서 로드를 검증한다.  |
| **H-1 · Host**            | 범용 byte grant, 멱등 준비, RAM 사본, 실제 Rust ACP 역요청                                    | A-0 정책 판정 뒤 착수. grant 수명·권한·청크·Stop 경합 및 **SDK trace 무노출** 관문을 통과한다.                                                                  |
| **A-1 · ACP**             | 선택된 예산 정책, capability/상태, 두 이미지 메서드, 고정 설명·영수증·lookup                  | A-0 결과와 합의된 H-1 fixture로 개발하고 H-1 branch와 실연결한다. stdout 초과·모델 거절·쓰기 전후 timeout·재개 경계를 확인한다.                                 |
| **S-1b · Studio UI**      | preparing·수락·결과 불명 상태, 실제 전송 크기·썸네일 또는 아이콘, 모델/경로 선택, 윈도우 통지 | S-1a + H-1 + A-1 뒤 Claude가 composer에 연결한다. 각 OS와 두 화면의 수용 뒤 별도 승인으로 Host release·Studio pin을 통합한다.                                   |

독립 후속 카드는 H-2(일반/실행 중 전송 공통 Local·Upload 출처 강화), A-2(기존 대형 native-history fallback), **ACP/Studio 재열기 카드**(대기·접수 상태 복원 및 소비 출처를 확인한 이미지·caption provenance의 이력 기록·재생)다. 접수 notice만으로 영구 이력 행을 합성하지 않는다. [구조화 파일·resource #872](https://github.com/handochan/aelix-ai/issues/872) · [소비·저장·철회 관찰 #865](https://github.com/handochan/aelix-ai/issues/865)

**aelix-ai Issue 초안(미등록)**

- **N-1 · 이력 이미지 보관·투영·예산 관찰.** A-0 결과를 첨부하고 요청용 context와 원본 세션을 분리한다. 일반·큐·도구 이미지의 bytes/장수, 거절 뒤 복구, compact·fork·load·withdraw의 관찰 계약을 정의한다. D01 안에서 고정 상한도 집행할 수 없는 조합은 후속 native pin의 필요성을 별도 판단한다.
- **N-2 · 이미지가 있는 빈 텍스트의 native 처리.** 일반 `prompt`와 `steer/follow_up`에서 빈 text block을 생략할 수 있는지 provider·저장·재개 호환으로 검증한다. 현행 B2는 ACP 자동 설명으로 지원한다. 새 native 지원이 생기면 고정 설명 정책을 재검토한다.
- **N-3 · stdin JSONL 줄 조립과 Stop 지연.** 조각마다 누적 버퍼 전체에서 개행을 다시 찾는 비용을 줄이고 byte 상한·Unicode·초과 후 회복을 정의한다. Windows 실측을 포함해 8 MiB 줄 뒤 Stop ACK를 검증하고 Studio 한도 재검토 근거로 삼는다.

### 리뷰 반영

1차 리뷰에서 범용 Host 바이트 제공, 권한 동등성, 누적 provider 비용, 실제 스파이크의 증거 경계를 반영했다. 2차 리뷰의 5개 should-fix와 2개 nit는 파일·제출·줄의 정확한 수치, A-0 선행과 20장 제한·수동 compact, 일반 resolver 동등성 및 **H-1 trace 무노출 수용 조건**으로 반영했다. 이미지 단독 전송과 접수 썸네일은 사용자 결정에 따라 확정했으며, 최신 결정에 따라 자동 축소는 v1의 S-1a(worker)·S-1b(UI) 범위이고 재열기 상태 복원은 별도다. 최종 델타 리뷰의 5개 should-fix·5개 nit를 반영했다. Blob resize 옵션만으로 큰 JPEG의 중간 메모리를 제한할 수 있다는 가정은 소스와 실측으로 정정했다. A-0 정책 판정과 플랫폼 수용은 열려 있다. [Studio #94 결정 기록](https://github.com/handochan/aelix-studio/issues/94#issuecomment-7059578337)

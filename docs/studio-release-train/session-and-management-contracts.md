# Studio / ACP / native 계약 제안

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

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
typed 경로로 보낸다. busy 세션에 새 prompt를 보내는 것과 steering mode selector를
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

# Claude / Codex 설계 검토 종합

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 2026-10-25 Asia/Seoul. 구현·출시 승인 문서가 아니다.

## 1. 실제 검토 경로와 결론

사용자가 관련 소스·설계 문서의 전달을 명시적으로 허용한 뒤 Claude Code CLI
2.1.310을 `--model claude-opus-5-5 --effort max`로 실행했다. Read/Glob/Grep만
허용했고, 모델 응답은 해당 모델로 정상 완료했다. effort는 요청 인자이며 응답이
독립적으로 증명하는 필드는 아니다. 원본 실행 메타데이터·Claude 보고서·부모가 작성한
Codex 감사 종합은 이전 로컬 감사 자료에 보관했다. 이동본에는 [출처 요약](evidence.json)과
아래 판단을 공유한다. 원본 보고서나 새 제품 수용 증거가 이 저장소에 게시됐다는 뜻은 아니다.
두 Codex 감사는 native TUI/세션 계약과 Studio/패키징 경계를 나눠 소스·원격 상태를
확인하고 초안을 재검토했다. 이번 이식의 독립 문서 검토는 원래 제품 설계 검토와 별개다.

**권장 방향은 유지한다.** Aion의 화면/설치 기반은 활용하고 Aelix가 실행 의미·
인증·프로필·세션의 정본을 소유한다. ACP는 범용 어댑터로 남기며, 전역 관리용
작은 stdio helper와 실행 중 세션 경로를 분리한다. 공개 beta.2를 기준으로 기능별
가능성을 검증한다. 이후 사용자 명확화로 Preview 본체/wheel 무수정과 기존 Aion UI
재사용을 기준으로 고정했다(7절). main snapshot을 package metadata만 보고 공개 beta.2라고 부르지 않는다.

## 2. beta.2의 미노출과 기술적 제약을 구분

아래는 beta.2 태그 `1093cc2578e70500c91fe0a8d340b7db2528c8de`의 **소스 기반 구현 후보**다.
새 helper/adapter/UI와 실제 공개 wheel 수용이 필요하며 현재 제품 동작의 보증이 아니다.

| 항목                          | 본체 무수정 경로                                                              | 남는 비용/제약                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 첫 API key 등록               | LLM 없는 helper → 명시적 native 경로의 AuthStorage.set_api_key                | 현재 endpoint/UI 없음. 비밀 비기록·auth source·idle restart 후 effective 검증                                                                                                           |
| OAuth 신규 인가               | AuthStorage.login의 URL/input/select/progress/cancel 콜백을 UI로 연결         | provider별 desktop/remote browser callback·refresh/logout 실검증. 모든 provider의 device/manual 지원을 가정하지 않음                                                                    |
| fork/clone                    | JsonlSessionRepo.fork로 새 UUID/parent 생성, 또는 classic RPC 조합            | 직접 repo 경로는 live session_before_fork hook/veto와 같지 않음. RPC 왕복은 부모 harness/복귀 veto·tool/config 보존을 검사                                                              |
| Team MCP 시작 연결            | private per-actor AELIX_MCP_CONFIG → native startup                           | adapter 거부는 현재 정책/미구현. native schema의 transport/header 지원, 사용자 MCP 조합, 실제 팀 도구·정리 검증. hot 교체와 구분                                                        |
| permission posture            | native startup flag + idle restart, native UI binding 후보                    | live setter와 다름. headless Ask fallback·중복 승인·실제 정책·세션 grant 검증 없이는 approval bridge 제거 불가                                                                          |
| 임의 extension command/dialog | live harness/runtime을 소유하는 SDK host라면 CommandDispatchService 연결 후보 | stock beta.2 RPC/일반 extension bridge의 범용 execute endpoint는 확인 못함. get_commands는 실행 API가 아님. 새 SDK runner의 lifecycle 비용은 별도이며 Preview core backport는 현재 제외 |
| 같은 파일 CLI/Studio 이어쓰기 | 공통 writer 계약에 참여하는 runtime/CLI 필요                                  | 공개 beta.2 legacy CLI는 session lock을 모름. ACP/helper만 바꿔 안전성을 보장할 수 없음                                                                                                 |
| 양방향 live viewer            | 공통 observation publisher + snapshot/watch/cursor                            | 파일 tail의 완료 기록 갱신과 token/tool/approval delta는 다름. main의 ReadOnlySessionStorage도 현재 open-time snapshot                                                                  |

공개 beta.2의 API key bootstrap을 native backport 필수라고 쓰거나 MCP/fork 전체를
불가능으로 분류한 해석은 채택하지 않았다. 반대로 import 가능한 내부 심볼을 모두
안정된 공개 ExtensionAPI라고 부르지도 않는다. bridge/helper의 심볼·버전·의미를
pin하고 wheel별 compatibility를 검증한다.

## 3. 채택한 보완과 D05의 조정

| 검토 항목                      | 통합 설계 반영                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 모델 없는 전역 관리            | Studio 소유 stdio helper로 auth/profile/package/catalog 처리. native sessionless API가 생기면 얇은 중계로 축소                                         |
| live session 경로              | 기존 Aion 감독자→ACP 유지. custom request/dialog·busy delivery·context/child metadata·stable ID는 각각 host probe. 필요한 forwarding patch는 별도 판단 |
| 인증 root 불일치 위험          | AuthStorage 기본 XDG 경로에 의존하지 않고 CLI get_agent_dir 해석 결과를 명시적으로 전달                                                                |
| profile 이름/역할 혼동         | ACP Coding/Analytics launch preset과 native AgentProfile identity 구분. 같은 프로필의 CLI/Studio 역할 prompt를 동일 resolver로 구성                    |
| presentation과 model 발화 혼합 | status·artifact를 typed event/ref로 전달, source/hash/producer와 durable card 복원. 승인 diff를 실제 변경에 연결                                       |
| 저장소 동시 갱신               | session writer와 auth/settings/profile store lock을 분리. revision·atomic publish·cache 갱신·Windows 두 실제 프로세스 검사                             |
| 확장 설치의 실제 적용          | signed bundle 불변, writable runtime generation, launcher binding, 실패 rollback, active/session pin이 참조하는 세대 보존                              |
| 앱 rollback의 데이터 손실      | binary/generation·Studio projection·CLI 공유 원본을 분리. 공유 root의 예전 snapshot을 자동 복원하지 않음                                               |
| 36개 명령 밖의 TUI 기능        | busy queue·steer/follow-up·! / !!·이미지/첨부·retry·thought·diff·dialog 등을 N01–N11로 별도 gate                                                       |
| 설치 경쟁력                    | final artifact의 크기/파일 수/시간을 OS·환경과 함께 측정. 기존 설치 timeout 기록을 현재 성공으로 해석하지 않음                                         |

Claude의 전역 Host Service 제안은 채택하되, 그것만으로 모든 세션 전용 통로까지
해결된다는 해석은 채택하지 않았다. 기존 관리 facade 안에서 경로를 둘로 나누고,
두 감독자가 같은 worker를 소유하지 않도록 한다. 표준 selector는 [ACP configOptions](https://agentclientprotocol.com/protocol/v1/session-config-options)를
우선하고, custom wire는 [ACP extensibility](https://agentclientprotocol.com/protocol/v1/extensibility)의
namespaced capability/메서드 경계를 따른다. 이는 구형 AionCore 지원 확인을 대체하지 않는다.

## 4. 원문에서 그대로 채택하지 않은 항목

1. **Preview 제한의 자동 승인:** Claude는 공개 wheel 유지와 여러 제한 공지를 권했다.
   범용 command/dialog·고급 permission·같은 파일 handoff 등 사용자의 초기 요구는
   당시 D01/D02의 blocker/결정으로 남겼다. 이후 사용자가 명확히 한 UI 재사용·clear
   제외·Ask/Yolo 설계는 7절을 따른다. 그 밖의 제한을 공지만으로 승인된 것으로 보지 않는다.
2. **부모 ACP와 native child의 lock 중복 보유:** 실제 writer인 native worker가 lock을
   갖도록 한다. 명시적인 handle 이양 없이 부모가 먼저 잡고 자식도 잡는 설계는 제외한다.
3. **검증되지 않은 CLI 예시:** 원문의 `aelix --fork <path>`를 제품 안내에 복사하지 않는다.
   beta.2의 fork entry ID와 session 지정 인자를 실제 parser/실행으로 확인해야 한다.
4. **overlay 단일 해법 강제:** writable generation은 채택하되 overlay/managed venv는
   packaging spike 뒤 고른다. 서명/패키지 정책을 검증 없이 확정하지 않는다.
5. **새 버전명·시간/용량 목표의 확정:** 원문의 postN/ACP 0.2·0.3/몇 분·몇 조작 등은
   reviewer의 예시/목표다. 출시 버전·일정·달성 수치로 채택하지 않았다.
6. **상태 추정:** 원문이 인용한 `1555b92`/다른 CI 기록과 Grep 기반 Git 추정은 현재
   baseline을 바꾸지 않는다. 부모의 Git/API 재확인과 exact artifact 증거가 우선한다.
   2026-10-25 00:11 KST 재확인에서 네 repo main/열린 PR head는 초기 값과 같았다.
7. **외부 통신 표현:** 원문 첫머리의 외부 통신을 바꾸지 않았다는 설명은 제품/저장소
   변경 없음으로 읽는다. 이 검토 호출 자체는 사용자가 허용한 Anthropic 전송이다.

## 5. 다음 구현을 위한 우선순위

1. W00: 공개 beta.2 wheel identity/import 계약과 TUI P baseline 고정. helper auth,
   fork/hook, startup MCP, permission startup, host custom forwarding 가능성을 짧게 검증.
2. D01/D02/D11: beta.2 본체 무수정에서 기존 Aion 표면의 native binding과 Ask/Yolo를
   구현한다. legacy CLI의 같은 파일 writer 보장은 별도 제약으로 남기며 강제 upgrade를 전제하지 않는다.
3. W01/W02 공통 identity/lock/revision/wire를 직렬로 정한 뒤 W03–W07의 UI/기능 작업.
4. Preview는 P gate를 final 설치 artifact에서, 첫 Beta는 실제 beta.3·Analytics Beta
   bytes로 공동 train에서 검증. 앱 update feed는 dependency 게시/검증 뒤 연다.

세부 작업 ID와 수용 조건은 [delivery-plan.md](delivery-plan.md), 단계의 정본은
[tui-coverage.md](tui-coverage.md)를 따른다. 이번 결과는 소스/원격/문서 검토이며
새 real-model·OS installer·폐쇄망·사용자 데이터 수용을 수행한 결과가 아니다.

최종 교차 검토에서 중대한 책임 충돌/사실 오류 보고는 없었다. 추가로 공유 config
안전성 G14를 mutation을 제공하는 Preview에도 적용하고, clone은 선택된 branch의
root→leaf 이력이라는 문구를 보완했다. 문서 재검토를 제품 실행 검증으로 세지 않는다.

## 6. 독립 검토 이후 추가된 사용자 요구 — 공식 홈페이지

2026-10-25 사용자가 Studio Beta 출시 시 Aelix 홈페이지에도 Studio 소개 등을
반영하도록 요구했다. 승인된 제품 요구에 추가하고 W11(홈페이지/문서 준비),
G17(실제 공개 확인), 공동 출시 순서에 반영했다. 앱 artifact 게시 뒤 홈페이지의
소개·다운로드·시작 안내를 검증하고 update feed/공동 발표를 연다.
이 추가 항목을 앞선 Claude/Codex 독립 검토가 이미 검증했다고 주장하지 않는다.

## 7. 사용자 명확화 — 본체 무수정 / Ask·Yolo / UI 재사용

2026-10-25 사용자가 기존 beta.2 사용자의 호환성을 위해 본체 변경을 제한하고,
Ask/Yolo 두 모드와 기존 Aion UI의 context·settings·fork/import/clone 표면 재사용을
제안했다. 모든 슬래시 명령 전수 복제를 요구하지 않으며 clear 신규 구현은 제외한다.
D01/D02를 이 기준으로 갱신하고 Ask/Yolo는 D11의 미구현 설계안으로 기록했다.

추가 소스 확인에서 beta.2 native yolo flag와 guardrail/permission prepend, 현재 ACP의
Ask-only capability 조건·Yolo policy 분기를 확인했다. 관리/승인 bridge는 유지하며
native launch posture와 adapter policy를 함께 맞추는 경로를 제안했다.
Aion의 context/config/fork 화면은 재사용하지만 현재 ACP fork capability/handler와
native history binding은 추가해야 한다. Aion의 새 대화용 clone은 ACP session ID를
지우므로 이력 복제로 세지 않는다. import도 실제 native JSONL 등록 경로를 확인한다.

소스 재확인 결과 16 MiB는 현재 ACP reader/wire 경계이며, native get_messages는
전체 이력 aggregate를 반환한다. 이전의 native 저장 자체의 16 MiB 한도로 읽힐 수
있는 문구를 active 설계에서 구분했다. raw 독립 검토 원문은 수정하지 않았다.

기능별 제약/추가 구현/재사용 경로는 [beta2-public-surface.md](beta2-public-surface.md),
36개 참고 항목의 UI mapping은 [tui-coverage.md](tui-coverage.md)를 따른다.
이 명확화에 대해 Claude를 재호출하거나 제품 구현/실행 수용을 수행하지 않았다.

이후 사용자는 기존 Aion UI 표면 연결 우선 원칙을 Preview부터 **첫 Beta까지**로
명확히 했다. D02/W03–W06과 Plus Alpha도 기존 화면/selector/설정/sidebar/preview에
native 기능을 연결하는 방식으로 정리하고, 새 전용 UI는 필수 공백의 최소 보완으로 한정했다.
큰 화면 교체는 Beta 이후 단계에서 검토한다.

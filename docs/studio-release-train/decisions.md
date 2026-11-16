# 판단·대안·오너 검토 항목

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 2026-10-24 작성, 2026-10-25 검토 완료, 2026-10-30 사용자 결정 반영(D03·D04·D06 상태, D12·D13 추가), 2026-11-16 방향 개편 반영(D14–D20 추가).
아래 항목은 구현/릴리스 승인이 아니다. "사용자 확정"은 제품 방향 결정이며, 구현·병합·출시 승인은 각 Issue와 저장소 규칙을 따른다.
요구를 줄이거나 runtime 기준을 바꾸는 결정은 명시적으로 채택되기 전까지 blocker다.

| ID  | 판단 대상                          | 권장안                                                                                                                                                                                                                                                                                     | 대안/비용                                                                                                                                                                                                                                                                | 상태                                                       |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| D01 | beta.2 기준                        | 공개 beta.2 wheel 무수정. Studio/ACP/별도 확장/helper에서 연결. 실제 wheel의 import/CLI/schema compatibility 확인                                                                                                                                                                          | Preview용 core backport와 강제 CLI upgrade는 제외. 남는 제약은 beta2-public-surface.md에 명시. main을 b2로 포장하지 않음                                                                                                                                                 | 2026-10-25 사용자 기준 확정                                |
| D02 | Preview/첫 Beta의 UI·기능 커버리지 | 첫 Beta까지 기존 Aion context 표시·설정창·selector·분기/가져오기/복제·sidebar·preview/browser에 native 기능 연결을 최대한 우선. clear 재구현 제외                                                                                                                                          | 명령 36개는 참고 inventory이며 전수 신규 구현 gate가 아님. 새 표면은 기존 UI로 충족할 수 없는 필수 작업의 최소 범위. UI 재사용과 native 기능 미연결은 구분                                                                                                               | 첫 Beta까지 UI 재사용 우선은 사용자 기준 확정              |
| D03 | 기존 CLI 연결                      | native 설정·인증·원본 세션 재사용. user 선택과 runtime/schema 호환성 확인, 같은 파일은 협조하는 writer 한 명만                                                                                                                                                                             | export/import 사본 중심은 단순하지만 같은 세션이 아님. legacy beta.2는 viewer/copy branch 또는 호환 CLI upgrade                                                                                                                                                          | 최소선 확정(2026-10-29–30, 아래 기록), 나머지 제안         |
| D04 | 확장 설치 위치                     | 사용자 managed runtime generation. bundled source/ABI/lock에 연결, 검증 후 전환·rollback                                                                                                                                                                                                   | 검증된 overlay도 후보. signed bundle 수정/시스템 CLI 임의 업데이트는 제외                                                                                                                                                                                                | 설치·관리 UI 첫 Beta 필수(10-29 확정). 위치는 spike 후 ADR |
| D05 | 초기 관리 통로                     | 두 경로: 세션 제어는 기존 Aion host→ACP, 전역 관리는 Studio 소유 stdio native helper. 세션 감독자는 기존 host 한 곳                                                                                                                                                                        | helper는 LLM bootstrap 의존을 없애지만 프로세스/호환 심볼 관리 비용이 있음. 커스텀 live command/dialog·metadata forwarding은 별도 host probe 후 bounded host 변경(D12) 여부 판단. helper로 live worker를 우회 제어하지 않음                                              | 권장 설계, host spike 필요                                 |
| D06 | Team과 native 위임                 | 첫 Beta까지 Aion Team UX와 Aelix child run을 명확히 구분. 공통 run identity/가시성을 먼저 만들기                                                                                                                                                                                           | 처음부터 Aion orchestrator 전체 교체는 출시 범위를 크게 늘림. Team 생성만 하고 실제 도구 미연결은 gate 실패                                                                                                                                                              | 서브에이전트 기능 첫 Beta 필수(10-29 확정), Team 요구 유지 |
| D07 | upstream 추적                      | main 감지/평가와 stable/선별 commit adoption을 분리. 모듈 소유권 map·별도 upgrade branch·실제 regression                                                                                                                                                                                   | 매 main 자동 merge/사용자 자동 업데이트는 제품 정책/세션 schema 충돌 위험. 장기 upstream 고정도 보안/호환 수정 누락                                                                                                                                                      | 제안                                                       |
| D08 | 공동 Beta 출시                     | exact wheel·installer/image·manifest를 동결한 하나의 release train. 홈페이지 Studio 소개·다운로드·시작 안내의 실제 공개 확인 후 Studio update feed를 마지막으로 열기                                                                                                                       | 패키지 저장소와 홈페이지의 원자 공개는 보장 불가. 일부 공개 실패 시 staged rollout 중지/forward fix 정책 필요                                                                                                                                                            | 홈페이지 반영은 사용자 확정 요구, 게시 순서는 제안         |
| D09 | 자의적 TUI 위젯                    | native 표준 UI 요청은 동등 동작, arbitrary terminal widget은 capability와 adapter를 요구                                                                                                                                                                                                   | 모든 Python TUI widget의 자동 웹 변환은 일반적으로 보장 불가. terminal fallback을 core 기능 수용으로 세지 않음                                                                                                                                                           | 예외 목록 오너 검토                                        |
| D10 | 공유 store와 rollback              | native auth/settings/profile scope lock·atomic revision·cache 갱신. 앱/runtime rollback과 공유 원본 복원을 분리                                                                                                                                                                            | session lock만으로는 config 동시 갱신을 막지 못함. 공유 root snapshot 자동 복원은 새 CLI 기록/credential 삭제를 되돌릴 수 있음                                                                                                                                           | 공유 mutation P/B blocker, W01/G14/G16                     |
| D11 | Preview permission                 | Ask/Yolo 두 모드를 목표로 기존 bridge 유지. native beta.2의 --permission-mode와 ACP 승인 정책을 일치시키며 모드 전환은 우선 idle restart로 구현                                                                                                                                            | 현재 adapter는 Ask만 광고. Yolo는 추가 구현/검증 필요. permission/guardrail/관리 bridge 전체를 끄는 방식은 선택하지 않음                                                                                                                                                 | 사용자 제안을 반영한 설계안, 미구현                        |
| D12 | Studio host(AionCore) 소유         | Studio 소유 저장소 `aelix-studio-host`로 관리한다. iOfficeAI/AionCore를 clone해 upstream 이력과 Apache-2.0 고지를 보존한다. 사용자 노출 정체성·외부 접속 기본값·필요한 host 동작만 바꾸고 내부 crate·모듈·DB/API 형식은 upstream과 최소 차이로 둔다. Studio는 고정한 host release를 받는다 | 무수정 유지는 CLI 턴 동기화·자식 제어·외부 접속 기본값·보안 수정을 막는다. patch 파일 방식(Studio PR #18·#23·#25)은 리뷰·테스트·이력이 약하다. 내부 이름까지 바꾸면 upstream 보안 수정 반영 비용만 커진다. 비용은 Rust 27개 crate·약 44만 줄의 의존성·보안 갱신 책임이다 | 2026-10-30 사용자 확정, 저장소 생성                        |
| D13 | 첫 공개 릴리스                     | aelix-ai beta.3·Analytics 첫 Beta와 함께 내는 공동 Beta가 Studio의 첫 공개 릴리스다. beta.2 Preview는 내부 검증 빌드로 두고 공개 배포·update feed를 열지 않는다                                                                                                                            | Preview를 공개하면 Preview→Beta migration과 두 버전 지원이 생긴다. P열 gate는 내부 검증 기준으로 남긴다                                                                                                                                                                  | 2026-10-29 사용자 확정                                     |

## 사용자 결정 기록 (2026-10-29–30)

- **첫 공개 릴리스(D13, 10-29):** 공동 Beta다. Preview는 내부 검증용이다.
- **첫 Beta 필수 재확인(10-29):** 아래 항목은 범위를 줄이지 않는다. native 지원이 부족하면
  단계를 나누고 aelix-ai에 요청한다. 빼려면 사용자 승인이 필요하다.
  - 서브에이전트(native 위임) 기능 (G13, D06). 진행 표시·취소·결과는 현재 native(#604)로 가능하고,
    이어서 시키기는 aelix-ai #610 병합 뒤, 자식 기록·승인·자식별 제어는 #612 판정에 달려 있다.
    자식 기록·승인·자식별 제어(S3)는 2026-11-16 결정으로 조건부가 됐다. 아래 "방향 개편"을 따른다.
  - CLI와 Studio 양쪽의 세션 보유자 표시와 동기화 (G05, D03)
  - CLI에 확장을 쉽게 설치하는 UI, 현재 CLI에 설치된 확장의 목록·제거·비활성화 (G06·G07).
    설치 위치는 D04 ADR로 정한다.
  - 오프라인 패키지 반입을 포함한 폐쇄망 사용 (G12)
- **CLI·Studio 세션(D03·G05, 10-29–30):** 목표는 B열 그대로 양쪽 live 보기다.
  - live 보기가 불가하면 최소선은 다음과 같다(10-29). 그 근거는 Studio #30에 남긴다. 양쪽에 세션을 쓰는 쪽을 표시한다
    ("CLI에서 실행 중", CLI에서는 "Studio에서 열려 있음"). 쓰지 않는 쪽은 보기 전용으로 사용하고,
    세션이 idle일 때 내용을 동기화한다. 잠금이 풀리면 상대가 만든 턴을 반영한 뒤 이어 쓴다.
  - idle 중 잠금 해제가 복잡하면 CLI는 세션이 끝날 때까지 잠가도 된다(10-30).
  - Studio가 잠금을 놓는 시점은 [Studio #30](https://github.com/handochan/aelix-studio/issues/30)에서 정한다.
- **host 소유(D12, 10-30):** `aelix-studio-host`는 다음 원칙으로 운영한다.
  1. 동작을 소유한 계층에서 고친다. 실행·세션 규칙은 aelix-ai, 프로토콜 변환은 aelix-acp(표준 ACP 우선),
     화면은 renderer, host 동작(DB·세션 불러오기·프로세스·외부 접속)은 host에서 고친다.
  2. 변경은 patch 파일이 아니라 host 저장소의 일반 commit·리뷰·테스트로 남긴다.
  3. 범용 버그 수정은 upstream에도 PR로 제안한다. 다만 출시 일정을 거기에 기대지 않는다.
  4. native wheel은 Studio에서 수정하지 않는다(D01). native 변경은 aelix-ai에서 한다.

## 방향 개편 (2026-11-16)

2026-11-16에 "AionUi 포크를 계속할지, Aelix 앱을 따로 만들지"를 검토했다. 사용자는 검토에서 낸 권고를
채택했다("권고대로 프로젝트 방향을 전면 개편"). 확인한 수치와 근거는
[Studio #42](https://github.com/handochan/aelix-studio/issues/42)에 있다.
아래 표의 "결정"은 권고에 적힌 대로 옮긴 것이다. 그것을 어떻게 실행할지는 표 다음의 "실행 제안"에 따로 적었다.
실행 제안은 사용자 확정이 아니다. 구현·병합·출시 승인은 각 Issue와 저장소 규칙을 따른다.

| ID  | 판단 대상               | 결정                                                                                                                                                                 | 대안/비용                                                                                                                                                                                                                                          | 상태                                      |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| D14 | 포크 유지 여부          | 첫 Beta까지 AionUi 포크와 `aelix-studio-host`를 유지한다. 독립 Aelix 앱은 Beta 뒤에 다시 검토한다. 재검토 조건은 아래에 적는다                                       | 새로 만들어도 native 계약, 5개 target 설치, 폐쇄망, Provider·권한 작업은 그대로 남는다. 채팅·미리보기·Team·WebUI 로그인·번역은 다시 만들어야 한다. 대신 host 약 44만 줄의 유지 비용과 네 층 경유는 없어진다                                        | 2026-11-16 사용자 확정                    |
| D15 | 구현 순서               | aelix-ai 쪽 판정을 먼저 끝낸다. 지금 시작할 수 있는 기능 카드를 구현 슬롯에 넣는다                                                                                   | 10-30부터 11-16까지 구현 슬롯은 host 정리 작업에 쓰였다. Beta 기능 카드 8개(Studio #6·#7·#10·#11·#24·#30·#31·#32)는 시작하지 못했다                                                                                                                | 2026-11-16 사용자 확정                    |
| D16 | 여러 저장소에 걸친 기능 | 기능 하나를 저장소를 가로질러 한 번에 만든다. 계약을 예시 JSON으로 먼저 고정하고, 개발 중에는 branch SHA로 묶고, host release는 통합 시점에만 낸다                   | 층마다 카드·리뷰·release·pin을 따로 거치면 기능 하나에 주기가 네 번 든다. 예시가 틀리면 여러 층을 함께 고쳐야 한다                                                                                                                                 | 2026-11-16 사용자 확정                    |
| D17 | host와 기능 경로        | host를 기능 경로에서 뺀다. host가 Aelix 전용 ACP 확장 메시지를 해석 없이 넘겨서, 새 기능은 ACP와 renderer만 바꾸면 되게 한다. 전역 관리는 D05의 helper 경로로 보낸다 | 그 통로는 아직 없다(아래 확인 기록). 만들려면 host 변경이 한 번 필요하다. host가 자기 DB와 맞춰야 하는 기능(세션 불러오기 동기화, host #4 범위 1)은 이 방식으로 빠지지 않는다                                                                      | 2026-11-16 사용자 확정. 통로는 host #32   |
| D18 | host 보안 공지          | 새 보안 공지 검사를 PR gate에서 주간 점검으로 옮긴다. 공지는 Beta 직전에 한 번에 고친다                                                                              | PR gate에 두면 공지가 나온 날 관련 없는 PR이 모두 멈춘다(11-02부터 11-16까지 6건). 옮기면 새 공지를 최대 일주일 늦게 안다                                                                                                                          | 2026-11-16 사용자 확정. 실행은 host #30   |
| D19 | 검증 등급               | 검증 수준을 위험도에 맞춘다. nit는 기록만 한다. 5개 target 설치와 kernel 수준 외부 접속 감사는 출시 후보에서만 돌린다                                                | 모든 PR에 전체 검증을 돌리면 화면만 바꾼 PR도 설치·감사 주기를 기다린다. 줄이면 설치·외부 접속 회귀를 출시 후보에서야 발견한다                                                                                                                     | 2026-11-16 사용자 확정. 실행은 Studio #43 |
| D20 | 새 Aelix 화면의 경계    | 서브에이전트 패널, 확장 관리, 세션 보유자 표시 같은 새 Aelix 화면은 Aion 대화 저장소에 묶지 않고 독립 모듈로 만든다                                                  | 기존 저장소에 직접 묶으면 빨리 붙지만 upstream 변경과 충돌하고 독립 앱으로 옮길 수 없다. 기존 표면 재사용 우선(D02)은 그대로이고, 기존 표면으로 채울 수 없는 화면에 적용한다. [delivery-plan.md](delivery-plan.md) 5절의 대체 단계와 같은 방향이다 | 2026-11-16 사용자 확정                    |

### 실행 제안 (조정 세션 작성, 사용자 확정 아님)

각 항목은 해당 카드의 PR을 병합할 때 사용자가 확정한다.

- **D15:** 보안 공지가 아닌 host 정리 카드(host #29)도 Beta 전 묶음에 둔다. 착수 순서를 정한 것이고 범위는 그대로다.
- **D16:** Studio pin도 host release와 함께 통합 시점에 올린다.
- **D18(host #30):** PR과 push에는 lockfile로 결과가 정해지는 검사(license·ban·source)를 남긴다. `Cargo.lock`이나
  `deny.toml`을 바꾸는 PR은 공지 검사도 받는다. release는 공지 검사를 통과해야 한다.
- **D19(Studio #43):** 출시 후보 외에 설치·runtime·외부 접속 경로를 바꾼 PR, `full-verify` label, main 정기 실행에서도
  전체 검증을 돌린다. 결정보다 검증이 많다. 2026-11-16에 이 차이를 사용자에게 알렸고, 사용자는 #43의 push를 승인했다.
- **D19 적용 시점:** 진행 중인 host #20·#21·#23은 이미 받은 사용자 판정대로 끝낸다. 사용자가 고치라고 한 nit는 고친다.

### 기록

- **독립 앱 재검토 조건(D14):** Beta 뒤에 다음 중 하나가 확인되면 다시 검토한다.
  1. Team·channel·cron 같은 Aion 표면을 사용자가 실제로 쓰지 않는다.
  2. host DB를 거쳐서는 CLI·Studio 양쪽 live 보기(G05 목표)를 만들 수 없다.
  3. host 유지 비용이 기능 개발 시간을 계속 넘는다.
- **바꾸지 않는 것:** 첫 Beta 필수 항목(G05·G06·G07·G12, D03·D04), native wheel 무수정(D01), 기존 표면 재사용 우선(D02),
  host 소유 원칙(D12), 독립 리뷰 1회, 병합·release의 사용자 승인. G13(D06)은 아래 S3 결정만 바뀐다.
  D05의 상태(권장 설계)도 그대로다.
- **aelix-ai 계약(11-16 사용자 결정):** aelix-ai #623(control-v1 계약 고정), #624(리소스 켜기/끄기 노출),
  #655(저장 메시지 ID·순서, R9)는 beta.3 필수다. Batch는 aelix-ai 실행 계획에서 정한다.
  남은 판정은 #612 분할(R4), 세션 잠금 보유자 정보(R7), 확장 관리 API(R8)다.
- **서브에이전트 S3(G13·D06, 11-16 사용자 결정):** 첫 Beta는 S1·S2(진행 표시·취소·결과·이어서 시키기)를 확정한다.
  S3(자식 기록 펼쳐 보기, 자식 승인, 자식별 중지·steer, 재접속 재생)는 aelix-ai #612가 beta.3에 들어오면
  첫 Beta에 포함한다. 들어오지 못하면 다음 릴리스로 넘긴다. #612는 aelix-ai에서 "beta.3 보장 안 함"으로 남는다.
- **D17 확인 기록(11-16):** host main `396eb44`에 `ext_request`·`ext_notify` 함수는 있지만 부르는 코드가 없다.
  - 통로 없이 되는 것: 표준 ACP 메서드와 tool call `_meta`. 서브에이전트 진행(`_meta["aelix/subagents"]`)은
    host PR #15의 `_meta` 저장으로 전달된다.
  - 통로가 필요한 것: Studio #24의 실행 중 입력(steer·follow-up). 예전 #16 forwarding은 Studio #28에서 걷어냈다.
    S3의 자식 제어도 필요하다. aelix-ai #612는 이를 `aelix_control` 확장으로 낸다.
- **`blocked` 표시 점검(11-16):** Studio #6·#10·#11·#32는 본문에 적힌 선행이 모두 끝나 있었다. #31은 본문의 host #4
  가운데 이 카드가 쓰는 `_meta` 저장(범위 2·3)이 병합돼 있었다. 그런데 착수해 보니 번들 runtime이 native `agent`
  도구를 등록하지 못했다([readiness.md](readiness.md)). 선행 Issue가 닫힌 것과 실제 번들에서 도는 것은 따로 확인한다.
- **Studio #31의 번들 의존성(11-16 사용자 결정):** native `agent` 도구(`aelix_agents/tool.py`)가 `rich.cells`를
  import하는데 `rich`는 `tui` extra에만 있다. 두 가지를 다 한다. Studio 번들에 `rich`를 추가한다. 범위는 `rich`와
  그것이 새로 끌어오는 패키지까지이고 다른 의존성 버전은 올리지 않는다. aelix-ai에는 버그로 등록한다(aelix-ai #797).

## 결정을 섞지 말 것

- 작은 kernel 정체성은 Studio 기능을 전부 kernel로 옮긴다는 뜻이 아니다. 기존
  공개 서비스·built-in extension·control API와 별도 host layer를 먼저 활용한다.
- host 소유(D12)도 Studio 기능을 host로 옮긴다는 뜻이 아니다. host 수정은 host가 소유한
  동작에 한정하고, native 의미론을 host나 renderer에서 복제하지 않는다.
- Provider UI와 native 인증 정본은 첫 설치의 기능 문제다. 기업 IdP SSO를 미룬다고
  Provider OAuth/키 등록까지 CLI로 미루는 근거가 되지 않는다.
- 빌드 target, CI target, 실제 설치 수용 target을 구분한다. 한 target의 미통과를
  문서에서 삭제하여 지원하는 것처럼 보이지 않게 한다.
- native child transcript가 있다는 사실과 재개 가능한 child authority/실행 identity,
  exactly-once tool effect는 별개의 보장이다.
- 개발 wheel/hash 기반 성공은 실제 공개 beta.3 wheel 및 Studio 배포 artifact 수용을 대체하지 않는다.
- 공개 beta.2 wheel을 그대로 쓸 수 있다는 판단은 현재 미노출 기능이 이미 구현됐다는 뜻이 아니다.
  [검토 종합](review-synthesis.md)의 API 후보·hook/lifecycle 비용·실제 blocker를 구분한다.

## Preview blocker를 해소하는 절차

1. D01의 공개 beta.2 무수정 기준에서 P 여정의 source/호환 API 경로를 검토한다.
2. 각 blocker는 `native 공통 계약 필요 / adapter 구현 / host UI 필요 / 검증만 미실행`으로 나눈다.
3. Studio/ACP/별도 확장과 helper의 변경을 분리하고 native wheel hash 불변을 검증한다.
4. 이미 정한 UI 재사용·clear 제외와, 아직 결정되지 않은 실제 기능 제한을 구분해 구현 이슈를 확정한다.
5. 승인되지 않은 제한은 release exception으로 적지 않는다.

이 문서는 자동으로 core backport, upstream merge, 새 GitHub Project 생성,
앱 설치 또는 공개 배포를 수행하도록 승인하지 않는다. host 저장소는 D12에 따라
2026-10-30 사용자 승인으로 만들었다.

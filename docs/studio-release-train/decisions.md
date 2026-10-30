# 판단·대안·오너 검토 항목

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 2026-10-24 작성, 2026-10-25 검토 완료, 2026-10-30 사용자 결정 반영(D03·D04·D06 상태, D12·D13 추가).
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

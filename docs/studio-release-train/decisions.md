# 판단·대안·오너 검토 항목

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 2026-10-24 작성, 2026-10-25 검토 완료. 아래 항목은 구현/릴리스 승인이 아니다.
요구를 줄이거나 runtime 기준을 바꾸는 결정은 명시적으로 채택되기 전까지 blocker다.

| ID  | 판단 대상                          | 권장안                                                                                                                                                               | 대안/비용                                                                                                                                                                                                          | 상태                                               |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| D01 | beta.2 기준                        | 공개 beta.2 wheel 무수정. Studio/ACP/별도 확장/helper에서 연결. 실제 wheel의 import/CLI/schema compatibility 확인                                                    | Preview용 core backport와 강제 CLI upgrade는 제외. 남는 제약은 beta2-public-surface.md에 명시. main을 b2로 포장하지 않음                                                                                           | 2026-10-25 사용자 기준 확정                        |
| D02 | Preview/첫 Beta의 UI·기능 커버리지 | 첫 Beta까지 기존 Aion context 표시·설정창·selector·분기/가져오기/복제·sidebar·preview/browser에 native 기능 연결을 최대한 우선. clear 재구현 제외                    | 명령 36개는 참고 inventory이며 전수 신규 구현 gate가 아님. 새 표면은 기존 UI로 충족할 수 없는 필수 작업의 최소 범위. UI 재사용과 native 기능 미연결은 구분                                                         | 첫 Beta까지 UI 재사용 우선은 사용자 기준 확정      |
| D03 | 기존 CLI 연결                      | native 설정·인증·원본 세션 재사용. user 선택과 runtime/schema 호환성 확인, 같은 파일은 협조하는 writer 한 명만                                                       | export/import 사본 중심은 단순하지만 같은 세션이 아님. legacy beta.2는 viewer/copy branch 또는 호환 CLI upgrade                                                                                                    | 제안                                               |
| D04 | 확장 설치 위치                     | 사용자 managed runtime generation. bundled source/ABI/lock에 연결, 검증 후 전환·rollback                                                                             | 검증된 overlay도 후보. signed bundle 수정/시스템 CLI 임의 업데이트는 제외                                                                                                                                          | 작은 packaging spike 후 ADR                        |
| D05 | 초기 관리 통로                     | 두 경로: 세션 제어는 기존 Aion host→ACP, 전역 관리는 Studio 소유 stdio native helper. 세션 감독자는 기존 host 한 곳                                                  | helper는 LLM bootstrap 의존을 없애지만 프로세스/호환 심볼 관리 비용이 있음. 커스텀 live command/dialog·metadata forwarding은 별도 host probe 후 bounded patch 여부 판단. helper로 live worker를 우회 제어하지 않음 | 권장 설계, host spike 필요                         |
| D06 | Team과 native 위임                 | 첫 Beta까지 Aion Team UX와 Aelix child run을 명확히 구분. 공통 run identity/가시성을 먼저 만들기                                                                     | 처음부터 Aion orchestrator 전체 교체는 출시 범위를 크게 늘림. Team 생성만 하고 실제 도구 미연결은 gate 실패                                                                                                        | 제안, 기존 Team 요구 유지                          |
| D07 | upstream 추적                      | main 감지/평가와 stable/선별 commit adoption을 분리. 모듈 소유권 map·별도 upgrade branch·실제 regression                                                             | 매 main 자동 merge/사용자 자동 업데이트는 제품 정책/세션 schema 충돌 위험. 장기 upstream 고정도 보안/호환 수정 누락                                                                                                | 제안                                               |
| D08 | 공동 Beta 출시                     | exact wheel·installer/image·manifest를 동결한 하나의 release train. 홈페이지 Studio 소개·다운로드·시작 안내의 실제 공개 확인 후 Studio update feed를 마지막으로 열기 | 패키지 저장소와 홈페이지의 원자 공개는 보장 불가. 일부 공개 실패 시 staged rollout 중지/forward fix 정책 필요                                                                                                      | 홈페이지 반영은 사용자 확정 요구, 게시 순서는 제안 |
| D09 | 자의적 TUI 위젯                    | native 표준 UI 요청은 동등 동작, arbitrary terminal widget은 capability와 adapter를 요구                                                                             | 모든 Python TUI widget의 자동 웹 변환은 일반적으로 보장 불가. terminal fallback을 core 기능 수용으로 세지 않음                                                                                                     | 예외 목록 오너 검토                                |
| D10 | 공유 store와 rollback              | native auth/settings/profile scope lock·atomic revision·cache 갱신. 앱/runtime rollback과 공유 원본 복원을 분리                                                      | session lock만으로는 config 동시 갱신을 막지 못함. 공유 root snapshot 자동 복원은 새 CLI 기록/credential 삭제를 되돌릴 수 있음                                                                                     | 공유 mutation P/B blocker, W01/G14/G16             |
| D11 | Preview permission                 | Ask/Yolo 두 모드를 목표로 기존 bridge 유지. native beta.2의 --permission-mode와 ACP 승인 정책을 일치시키며 모드 전환은 우선 idle restart로 구현                      | 현재 adapter는 Ask만 광고. Yolo는 추가 구현/검증 필요. permission/guardrail/관리 bridge 전체를 끄는 방식은 선택하지 않음                                                                                           | 사용자 제안을 반영한 설계안, 미구현                |

## 결정을 섞지 말 것

- 작은 kernel 정체성은 Studio 기능을 전부 kernel로 옮긴다는 뜻이 아니다. 기존
  공개 서비스·built-in extension·control API와 별도 host layer를 먼저 활용한다.
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

이 문서는 자동으로 core backport, AionCore fork, upstream merge, 새 GitHub
Project 생성, 앱 설치 또는 공개 배포를 수행하도록 승인하지 않는다.

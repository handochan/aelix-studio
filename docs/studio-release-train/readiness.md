# Studio 개발 착수 안내

## Beta 우선 착수 순서 (2026-10-30)

D13에 따라 Studio의 첫 공개 릴리스는 공동 Beta다. 이 절이 현재 착수 기준이다. 아래 "Preview 준비 기록"부터
"준비 시작 시점의 source와 기존 작업"까지는 2026-10-25 기록이고, 마지막 "실행자의 시작·정지 체크포인트"는
계속 적용한다. 판단은 [decisions.md](decisions.md)의 D03·D12·D13과 사용자 결정 기록을 따른다.

| 단계 | 실행 Issue                                                                                                                                                                                                                                                                                                                                                                                                         | 선행 / 비고                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 0    | [Studio #27 결정 기록](https://github.com/handochan/aelix-studio/issues/27), [aelix-ai #623 control-v1 freeze](https://github.com/handochan/aelix-ai/issues/623), [aelix-ai #624 B6 선택 저장 노출](https://github.com/handochan/aelix-ai/issues/624)                                                                                                                                                              | #624는 aelix-ai B6 착수 전에 판정                      |
| 1    | [host #1 기준선](https://github.com/handochan/aelix-studio-host/issues/1) ∥ [ACP #20 PR #1 재정렬](https://github.com/handochan/aelix-acp/issues/20) → [host #2 정체성·외부 접속](https://github.com/handochan/aelix-studio-host/issues/2) ∥ [host #3 권한 복원](https://github.com/handochan/aelix-studio-host/issues/3) → [host #4 세션 동기화·`_meta`](https://github.com/handochan/aelix-studio-host/issues/4) | Studio #14는 host #2와 함께                            |
| 2    | [Studio #28 Beta 기준선](https://github.com/handochan/aelix-studio/issues/28) → [Studio #29 runtime-controls 이전](https://github.com/handochan/aelix-studio/issues/29) ∥ [Studio #8 내부 검증 빌드](https://github.com/handochan/aelix-studio/issues/8)                                                                                                                                                           | host composition 변경은 직렬. #29는 Codex 담당 확인 뒤 |
| 3    | Studio #24 ∥ #30 → #31 ∥ #32 → #7 ∥ #6 → #10 ∥ #11 → #26 ∥ #15                                                                                                                                                                                                                                                                                                                                                     | 동시 구현 최대 2개. #7은 aelix-ai B6 뒤                |
| 4    | 최종 beta.3·Analytics wheel로 [Studio #9](https://github.com/handochan/aelix-studio/issues/9) 재검증 → 공동 출시                                                                                                                                                                                                                                                                                                   | #623이 beta.3에 들어가면 freeze 확인                   |

보류: aelix-ai #612 분할(R4), 세션 잠금 보유자·상태 조회(R7), 확장 관리 API(R8)는 사용자 판정 전이다.
#623·#624의 beta.3 포함과 Batch도 aelix-ai 오너 판정을 기다린다.
서브에이전트의 자식 기록·승인·자식별 제어(S3)는 첫 Beta 요구(G13)에 남아 있고, R4 판정 뒤 카드로 만든다.

## Preview 준비 기록 (2026-10-25)

2026-10-25 준비 기준. 실제 상태와 담당은 [Project 9](https://github.com/users/handochan/projects/9) 및
Issue/PR·CI를 다시 확인한다. 이 준비는 제품 코드·native wheel·dependency·출시를 변경하지 않는다.
공통 설계는 이 Studio 문서 묶음에 두고 [ACP 진입 안내](https://github.com/handochan/aelix-acp/blob/main/docs/studio-preview.md)에서 참조한다.
원래 ACP 로컬 설계는 과거 감사 자료로 보존한다. 별도 정본으로 갱신하지 않는다.

## 확정 요구와 아직 검증할 설계

- Preview는 공개 Aelix beta.2 wheel 무수정이다. main을 b2 version string으로 포장하거나 기존 CLI의 private upgrade를 강제하지 않는다.
- 첫 Beta까지 기존 Aion selector·설정·sidebar·세션·preview/browser 표면을 최대한 재사용한다. 모든 slash 명령 복제와 신규 `/clear` 구현은 제외한다.
- Ask/Yolo, 모델/추론·context·compact·Stop, native 세션·프로필·리소스 연결을 실제 사용자 흐름으로 검증한다.
- macOS/Windows/Linux 5 build target·인증된 단일 운영자 WebUI/mobile browser·차단 네트워크·Analytics·Team 요구를 유지한다.
- 첫 Beta는 공개 beta.3·Analytics 첫 Beta와 공동 출시하고 홈페이지 소개·지원 OS 다운로드·시작 안내의 실제 공개 확인을 포함한다.
- helper 배치·추가 wire/schema·writable generation·upstream 교체 방법은 [decisions.md](decisions.md)의 제안 상태다. source spike/ADR로 정하며 출시 제한을 임의로 승인하지 않는다.

## Preview 첫 실행 순서 (2026-10-25 기록)

공통 기준선은 한 명이 직렬로 정한다. 아직 선행이 끝나지 않은 Studio 카드를 Ready로 표시하지 않는다.
기준선/공통 계약 이후에만 독립 구현을 최대 두 개씩 배정한다.

| 순서 | 실행 Issue                                                                                   | 담당 / Ready 조건                        | 결과를 받는 곳                                                                                        |
| ---- | -------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | [ACP #6 공개 beta.2 wheel·ACP 호환 기준선](https://github.com/handochan/aelix-acp/issues/6)  | Codex. 준비 문서의 두 main 반영 후 Ready | 네 native wheel/version/hash, import/CLI/wire, 실제 native smoke, candidate 재사용 범위·known limits  |
| 2    | [Studio #4 공개 runtime·ACP 기준선 통합](https://github.com/handochan/aelix-studio/issues/4) | Claude. ACP #6 결과 수용 후 Ready        | exact ACP pin·AionCore pairing·bootstrap/runtime-controls/upstream-policy 채택/보완/제외와 host smoke |
| 3    | [ACP #7 전역 관리·live host 공통 계약](https://github.com/handochan/aelix-acp/issues/7)      | 위 두 기준선 후 배정                     | W01/W02 책임·request/cancel·auth root·busy/unsupported·공유 mutation 한계와 실제 host probe           |

공유 manifest/lockfile/host composition/native dispatcher는 여러 실행자가 동시에 변경하지 않는다.
준비 Issue [Studio #3](https://github.com/handochan/aelix-studio/issues/3)와
[ACP #4](https://github.com/handochan/aelix-acp/issues/4)는 문서/보드 공유만 수용한다.
제품 baseline Issue와 준비 완료를 구분한다.

## 후속 Backlog와 수용 연결

기존 초안은 같은 Project 카드에서 실제 Issue로 전환했다. 다음 카드는 선행과 검증을 확정한 뒤 Ready로 옮긴다.
여러 repo가 실제로 수정될 때만 실행 Issue를 더 나누고 연결한다.

| Issue                                                                                       | 계획 / 선행                                 | 완료 근거                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| [ACP #5 Ask/Yolo](https://github.com/handochan/aelix-acp/issues/5)                          | W03; Studio #4·ACP #7                       | Ask 거절, Yolo prompt 생략, native 거부·Stop 유지, idle restart 후 실제 상태   |
| [Studio #5 Provider·기존 설정창](https://github.com/handochan/aelix-studio/issues/5)        | W02/W03; Studio #4·ACP #7                   | 신규/기존 CLI auth root·첫 응답·잘못된 키/취소, 비밀 비기록                    |
| [Studio #6 native 세션·이력·분기](https://github.com/handochan/aelix-studio/issues/6)       | W04; Studio #4·ACP #7                       | 실제 native history/context·원본 보존·분기 cut·재개, legacy 한계 공개          |
| [Studio #7 프로필·도구·스킬·확장](https://github.com/handochan/aelix-studio/issues/7)       | W05; Studio #4·ACP #7                       | native loaded/selected/effective, off 실제 반영, writable generation·실패 복구 |
| [Studio #10 Analytics 콘텐츠·미리보기](https://github.com/handochan/aelix-studio/issues/10) | W06; 기준선·관리 통로                       | 상대 CSS/JS/이미지·다중 페이지·차트/Report·path/origin·mobile                  |
| [Studio #11 실제 Aion Team](https://github.com/handochan/aelix-studio/issues/11)            | W07; 기준선·관리 통로                       | leader/teammate 실제 turn/tool·승인·거부·취소·재접속, native child와 구분      |
| [Studio #8 Preview 설치·사용 흐름](https://github.com/handochan/aelix-studio/issues/8)      | W08; 위 기능 결과·W10 provenance            | G01–G12/G14/G15 및 final artifact·OS·WebUI/mobile·폐쇄망 수용                  |
| [Studio #9 공동 Beta·홈페이지](https://github.com/handochan/aelix-studio/issues/9)          | W09/W11; Preview·공개 beta.3/Analytics Beta | 추가 G13/G16/G17, migration/update/rollback·홈페이지 공개 확인                 |

W00–W11과 G01–G17의 세부 기준은 [delivery-plan.md](delivery-plan.md), 사용자 작업은
[tui-coverage.md](tui-coverage.md), 지원 제약은 [beta2-public-surface.md](beta2-public-surface.md)를 따른다.
W10 upstream 검토는 Studio #4에서 기존 policy 후보를 대조하고 필요한 실행 Issue로 분리한다.
홈페이지 구현은 Beta 착수 시 `aelix-ai/site`의 실제 실행 Issue에 연결한다. 이번 준비는 core repo를 수정하지 않는다.

## 준비 시작 시점의 source와 기존 작업

아래는 준비 시작 기준이며 다음 실행자는 최신 원격 main/열린 PR/claim을 다시 확인한다.
문서 안 과거 소스 감사의 '현재/미구현'은 당시 후보 관측이다. 현행 구현 상태를 자동 갱신한 표가 아니다.

| 저장소         | 준비 시작 main                                                      | 별도 후보와 처리                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP            | `04ff18edb04148f5f490c50d1f1fb3c3475b3c5b`                          | PR #1 `8deb482bcd53261762979cf0e6ce1302dcc821c1`·기존 beta2 dirty 변경은 보존. #6에서 공개 wheel 호환을 대조                                                                |
| Studio         | `060504a4e43e287bd5112a7a9ab0ea2478aa4813`                          | bootstrap/runtime-controls `3a8763cfd56acd52024b4a0634acaca7cedb48e4`·dirty 변경과 upstream-policy `36920e76467a4b8751e557b995fa2f63a7833f92`를 보존. #4에서 선별 통합 계획 |
| native Preview | 공개 `v0.1.0-beta.2` tag `1093cc2578e70500c91fe0a8d340b7db2528c8de` | tag/source 감사와 배포 wheel byte/hash·actual install 검증은 별도. #6이 네 wheel을 확인                                                                                     |

bootstrap/과거 branch CI green은 현재 main이나 새 dirty 후보의 CI를 증명하지 않는다.
기존 작업을 reset/stash/덮어쓰기하지 않는다. 제품 작업은 해당 Issue용 새 worktree에서 최신 main을
기준으로 만들고 필요한 후보 diff만 검토한다. 공개 beta.2를 패치하는 우회는 범위 밖이다.

## 실행자의 시작·정지 체크포인트

1. root AGENTS/CLAUDE, [운영 모델](operating-model.md), Project README·실제 Ready/담당·선행 PR/CI를 확인한다.
2. Issue에 실행 세션·기준 SHA·branch/worktree·완료 조건·관련 검증을 기록하고 In progress로 옮긴다.
3. 다른 세션의 독립 리뷰 한 번과 영향받는 재검증을 수행한다. Studio push는 `just push`를 사용한다.
4. 정지/완료 시 현재 SHA/PR, 검증·미실행, 다음 행동, 막힘을 남긴다. 계약/출시 범위 변경만 needs-decision이며 일반 구현 선택은 agent가 처리한다.

실제 배정 전 제품 구현 worktree를 미리 점유하지 않는다. 준비 branch/worktree는 준비 Issue 전용이다.
지침 파일 자체는 push·병합·배포의 권한을 새로 부여하지 않는다.
문서 검증, 소스 테스트, 실제 wheel/Provider, host UI, installer/field 수용은 별도다.
main push CI가 없는 Studio의 문서 변경은 최종 PR CI·필수 local gate·검토 tree와 main 동일성을 기록한다.

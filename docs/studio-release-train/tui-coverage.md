# TUI → Studio 기능 커버리지와 수용 기준

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

상태: Proposed · 기준일 2026-10-24. native beta.2 태그의 36개 기본 명령을
[기존 소스 감사](evidence.json)와
대조했다. beta.3 feature freeze 때 새 명령·설정·extension UI hook을 다시 추출한다.
이 목록은 명령 이름 수가 아닌 실제 사용자 작업을 검증하기 위한 참고 inventory다.
2026-10-25 사용자 기준으로 명령 전수 복제를 요구하지 않는다. Aion의 기존 UI를
첫 Beta까지 최대한 재사용하고 native 결과가 필요한 작업만 binding한다.
새 전용 표면은 기존 UI로 충족할 수 없는 필수 기능의 최소 범위이며 `/clear` 신규 구현은 제외한다.

P = 첫 Preview의 필수 핵심 여정, B = 첫 Beta까지 필요한 기능 baseline.
P-conditional = 실제 기능 수준이 아직 정해지지 않은 초기 요구. 예외 승인 없이
B로 미뤘다고 간주하지 않는다. D01은 공개 beta.2 무수정으로 고정했고, D02에는
UI 재사용/clear 제외를 기록했다. 상세 stage의 정본은 이 파일이며 P/B 목표와 현재
구현을 혼동하지 않는다. 호환 제약과 Ask/Yolo는 [별도 정리](beta2-public-surface.md)를 따른다.

현재 상태는 읽기 전용 코드 감사이며 설치 앱 수용 결과가 아니다.
`코드 있음`에는 현재 미커밋 beta2 adapter 구현도 포함한다.
표준 config selector 외 전용 관리 화면은 대체로 Studio host/UI 작업이 남는다.

## 1. 출시를 가르는 핵심 시나리오

| ID  | 사용자 작업                                                             | P gate                                                                          | B gate                                                       | 현재 확인한 공백                                                                  |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| J01 | 깨끗한 머신 설치→Provider/API key 또는 지원 OAuth/내부 endpoint→첫 답변 | 필수                                                                            | 필수 + upgrade                                               | Aion Provider UI와 native AuthStorage가 미연결                                    |
| J02 | 기존 CLI 설정·Provider·세션을 발견해 사용                               | P: 완료된 native 기록의 자동 갱신. full delta/동일 파일 handoff는 P-conditional | 공통 session/lock/live delta viewer 필수                     | ACP DB만으로 외부 CLI catalog/owner를 알 수 없음                                  |
| J03 | 같은 세션에서 모델·추론 변경→다음 응답→복구                             | 필수                                                                            | 필수                                                         | beta2 bridge 코드 있음. effective state와 UI 검증은 구분                          |
| J04 | 텍스트·추론 streaming, Stop, Ask/Yolo                                   | P 필수. Ask/Yolo는 본체 무수정 adapter 연결 목표                                | 공개 beta.3에서 지원/광고하는 permission posture/표준 dialog | 현재 adapter Ask-only. native yolo flag+bridge policy/idle restart 구현·검증 필요 |
| J05 | context 양/모델 한도 확인→compact→이력 유지                             | 필수                                                                            | 자동 압축·긴 이력·복구까지                                   | 현재 context는 JSON 수준, aggregate/history paging 갭                             |
| J06 | Aion UI의 분기/복제/새 대화/재개·lineage를 native 세션에 연결           | P 필수. /clear 별도 구현 제외                                                   | 공통 CLI 연결·광고한 분기 cut 수용                           | beta2 branch 미노출. Aion HEAD fork와 TUI before(entry)는 다르며 UI 의미를 명시   |
| J07 | 프로필 만들기→tools/skills/extensions 선택→실행                         | 필수                                                                            | CRUD·revision·재개 일관성                                    | parser/save/use 코드, Studio form과 변경 충돌 UX 필요                             |
| J08 | 확장 설치/on-off→실제 도구·prompt 반영→실패 복구                        | 필수                                                                            | update/remove/rollback·offline 반입                          | writable runtime과 effective inventory 검증 필요                                  |
| J09 | Coding 결과 diff·파일·HTML/이미지/문서 확인                             | 필수                                                                            | 상대 자산·다중 페이지·모바일·재개                            | 파일 ref/path를 끝까지 보존하는 제품 검증 필요                                    |
| J10 | Analytics init/import/query/run/record→Workspace 근거 확인              | experimental 상태라도 사용 가능                                                 | 공식 Analytics Beta 전체 수용                                | 합성 실행과 실데이터/사용자 수용은 별도                                           |
| J11 | leader/teammate의 실제 메시지·도구·승인·중단                            | 필수                                                                            | native child와 구분·재접속 상태                              | team creation/attach만으로 통과 아님                                              |
| J12 | 인증된 WebUI·mobile browser·차단 네트워크                               | 기존 출시 범위 유지                                                             | 신규 설치/업데이트/복구                                      | 단일 운영자와 기업 다중 사용자/SSO를 구분                                         |

P0 핵심 여정은 100% 통과하고, 36개 참고 항목 전부에 대해 UI 연결/재사용/제외와
현재 상태를 명시한다. 모든 슬래시 명령을 구현한다는 뜻이나 현재 달성률이 아니다.
핵심 작업을 "CLI에서 하세요"로 보내는 것은 Studio 커버리지로 세지 않는다.

## 2. beta.2 기본 명령 36개

| ID  | TUI 참고 명령 | Studio에서 제공할 작업/의미                                                      | 목표                         | 현재 adapter/host 상태                                                                                              | 연결/재사용할 표면                  |
| --- | ------------- | -------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| T01 | help          | 지원 명령·도구·관리 진입점·현재 제약 표시                                        | P/B                          | 목록 기반 코드 있음                                                                                                 | 기존 도움말·명령 검색               |
| T02 | hotkeys       | 웹/desktop 단축키 도움말, 핵심 작업의 검색 가능한 접근                           | B                            | host client action, 실제 화면 별도                                                                                  | 단축키 도움말/설정                  |
| T03 | model         | registry 기반 모델 선택, effective 확인, 세션 유지                               | P/B                          | beta2 public bridge 코드 있음                                                                                       | 기존 모델 picker                    |
| T04 | login         | native Provider 인증 등록, OAuth 진행/취소                                       | P/B                          | beta2 모델 없는 AuthStorage helper 후보 있음. 현재 endpoint/UI 미구현; control-v1만이 유일한 경로는 아님            | Provider 설정창 + native auth       |
| T05 | trust         | 실제 project trust와 적용 범위 조회/변경                                         | B                            | native control 경로·Studio 승인/재시작 필요                                                                         | 프로젝트 신뢰/설정 표면             |
| T06 | logout        | native 인증 제거, held registry 갱신                                             | P/B                          | beta2 관리 helper/native API와 idle restart 후보; UI·cache 갱신 검증 필요                                           | Provider 설정창 + native logout     |
| T07 | clear         | 별도 슬래시/보기 초기화 재구현 제외. context/원본 삭제로 대체하지 않음           | 사용자 제외                  | 기존 host action은 선택 사항이며 출시 필수 구현으로 세지 않음                                                       | 신규 구현 제외                      |
| T08 | compact       | instruction, 진행/취소/완료/후 context 관찰                                      | P/B                          | RPC 연결, UI/복구 수용 필요                                                                                         | compact 버튼/기존 명령 메뉴         |
| T09 | cost          | 실제 native 비용, unknown/부분 알려짐 표시                                       | P/B                          | stats cost만으로 completeness를 알 수 없음. native wire 갭과 UI 연결 필요                                           | usage/cost 표시                     |
| T10 | stats         | 토큰·메시지·작업 상태·비용의 출처/시점 표시                                      | P/B                          | 통계 출력                                                                                                           | 기존 usage/status                   |
| T11 | session       | native session ID/path/owner/profile/runtime 정보                                | P/B                          | ACP 범위 정보, 외부 CLI 전체 연결 미구현                                                                            | 세션 목록/상세                      |
| T12 | name          | rename 후 CLI/Studio 목록·재개에 반영                                            | P/B                          | RPC 기반, catalog 동기화 필요                                                                                       | 대화 제목 편집                      |
| T13 | thinking      | 현재 모델이 지원하는 단계만 선택·관찰·저장                                       | P/B                          | beta2 setter/복구 코드 있음                                                                                         | 기존 reasoning selector             |
| T14 | tools         | source/loaded/selected/effective 목록, 빈 선택도 유효                            | P/B                          | native bridge, 관리 UI 필요                                                                                         | 도구 관리 패널                      |
| T15 | skills        | 실제 loading/context 참여 on-off, 명령 목록과 구분                               | P/B                          | managed snapshot/restart, 전체 inventory 제한                                                                       | 스킬 관리 패널                      |
| T16 | agents        | native profile list/create/use, 위임은 별도 동작                                 | P/B                          | beta2 list/show/save/use, update/delete/run 갭                                                                      | agent/profile 카드·설정             |
| T17 | hooks         | 설정/진단 표면에서 적용 hook·출처·오류 표시                                      | B                            | 현재 beta2 미노출. 별도 native inventory/helper 또는 공개 beta.3 capability 검증                                    | 설정/진단 패널                      |
| T18 | mcp           | native 서버/도구 상태·설정·인증·실패·재시작                                      | B; 팀에 필요한 부분은 P      | 현재 client mcpServers 거부. beta2 AELIX_MCP_CONFIG startup 변환 후보, transport/header 호환·팀 실제 도구 검증 필요 | MCP 설정창 + native startup         |
| T19 | extension     | 설치·검증·on-off·update/remove·reload·오류                                       | P/B                          | CLI/선택/restart 코드, writable runtime/UI 필요                                                                     | 설정의 확장 관리 패널               |
| T20 | context       | 기존 Aion context 표시에서 실제 context/window/percent·freshness 제공            | P/B, 별도 명령 불필요        | ContextUsageIndicator/acp_context_usage 경로 있음. 실제 native 값 공급/host 통과 검증 필요                          | 기존 ContextUsageIndicator          |
| T21 | mode          | **steering delivery mode**, permission과 구분                                    | P/B                          | 표준 config, Studio selector 연결                                                                                   | 기존 RuntimeSettings                |
| T22 | permissions   | 기존 mode selector에서 Ask/Yolo, 추가 모드는 공개 runtime capability에 따라 확장 | P Ask/Yolo 목표; B 지원 모드 | 현재 adapter Ask-only. native --permission-mode yolo와 bridge 자동 승인/idle restart 연결 필요                      | 기존 mode selector/승인 카드        |
| T23 | settings      | 기존 설정창/RuntimeSettings에서 native schema·scope·effective 값 변경            | P 핵심/B 제품 지원 범위      | UI는 재사용. Aion Provider DB와 native 설정 저장소는 달라 backend binding 필요                                      | 기존 설정창/RuntimeSettings         |
| T24 | scoped-models | 모델 scope/순환 대상 관리, native 결과 반영                                      | B                            | beta2 미노출                                                                                                        | 모델 설정/picker                    |
| T25 | statusline    | TUI 장식 복제 대신 context/model/usage 상태 영역                                 | B                            | native 상태 원천과 Studio 표현을 구분                                                                               | 기존 status 영역                    |
| T26 | expand        | reasoning/tool 그룹 펼치기와 상세 보기                                           | P/B                          | renderer 기능은 있으나 host action 연결 별도                                                                        | 기존 메시지 펼치기                  |
| T27 | export        | 원본 session export, 결과 파일 접근·다운로드                                     | P/B                          | RPC export, host 파일 UX 필요                                                                                       | 내보내기/파일 다운로드              |
| T28 | copy          | 마지막 답변·코드·선택 내용을 OS/browser clipboard로                              | P/B                          | adapter text 반환과 실제 clipboard를 구분                                                                           | 기존 복사 버튼/clipboard            |
| T29 | resume        | CLI/Studio 공통 catalog에서 선택, owner 확인 후 재개                             | P/B                          | 현재 ACP 등록 세션만, native discover/watch 필요                                                                    | 기존 sidebar + native catalog       |
| T30 | new           | 새 native session/context 생성, 기존 세션 보존                                   | P/B                          | host 생성/navigation, 원본 계속 유지                                                                                | 기존 새 대화/navigation             |
| T31 | import        | 형식·원천 확인, 원본 보존하며 native identity로 등록/변환                        | B; CLI 연결은 P              | host client action만 있음                                                                                           | 파일 선택/가져오기 + native binding |
| T32 | fork          | 기존 Aion fork 표면의 실제 HEAD/cut 의미로 native branch 생성·부모 보존          | P/B, 별도 명령 불필요        | 현재 ACP session/fork capability/handler 없음. beta2 repo/RPC 경로 연결 필요. TUI before(entry)는 별도 옵션         | 기존 fork 버튼/navigation           |
| T33 | clone         | 이력 복제라면 선택 branch root→leaf를 새 native identity로 복제                  | P/B, 별도 명령 불필요        | Aion 설정 복제/new conversation은 ACP session ID를 지워 새 context가 됨. native 이력 clone binding은 추가 필요      | 분기/복제 UI + native history       |
| T34 | tree          | native parent/branch lineage 보기                                                | P/B                          | 현재 fork 후보 목록이라 동등하지 않음                                                                               | 기존 lineage 배지/부모 링크         |
| T35 | quit          | 세션 실행 종료와 앱/탭 닫기 정책 구분, lock 해제                                 | P/B                          | native close 있음, pending/child UX 필요                                                                            | 기존 종료/세션 해제                 |
| T36 | reload        | native 자원 재로딩, 적용 generation/오류/활성 도구 확인                          | P/B                          | beta2 child restart, source 기반 capability 필요                                                                    | 기존 runtime restart/관리 버튼      |

`/clear` 별도 구현은 제외하고 새 대화·삭제·보기 동작과 혼동하지 않는다.
TUI fork는 `before(user entry)`, Aion ACP HEAD fork/clone은 `at(leaf)`로 구분하며
제공하는 표면의 실제 transcript cut·native identity·부모 보존을 검사한다.
clone은 다른 branch entry까지 포함하는 원본 JSONL 파일의 byte copy가 아니다.
native beta.3 신규 기능도 freeze 때 UI 연결/지원/제외를 기록한다. 명령 개수로 Beta 동등을 선언하지 않는다.

## 3. 명령 외 baseline — 같은 수준으로 gate에 포함

| ID  | 기능/의미                                                       | stage                | 담당과 현재 공백                                                                            | 수용                                                                                |
| --- | --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| N01 | 실행 중 steer/follow-up 전달·큐·취소                            | P/B                  | native/ACP/host. selector만으로 충족 안 됨; 현재 busy prompt 거부와 별도 delivery 연결 필요 | 여러 queued message 순서·다음 실행 반영·중단 시 제거, G03/G15                       |
| N02 | `!command` context bash / `!!command` transient bash            | P-conditional(D02)/B | native user_bash 서비스+Studio 입력 dispatcher. 현재 `/` 외 입력이 모델로 갈 수 있음        | 모델 미호출, hook/정책/출처·context 포함/제외·취소 검사, G15                        |
| N03 | 이미지·첨부·paste·긴 입력                                       | P/B                  | native prompt capability/ACP content/host 파일 입력                                         | 지원 모델 실제 이미지 전달, unsupported fallback 명시, frame/파일 경계, G01/G08/G15 |
| N04 | 자동 retry/compaction·backoff·idle/cancel                       | P/B                  | native 상태+host render                                                                     | provider attempt 종료와 전체 turn 종료 구분, 재시도 중 cancel, G03                  |
| N05 | 실제 reasoning delta와 model capability                         | P/B                  | native event/ACP/UI                                                                         | 지원 Provider에서 thought fold/expand·재접속, 미공개 추론 생성 금지, G03            |
| N06 | tool 부분 결과·diff·바이너리/이미지·파일 위치                   | P/B                  | native metadata/ACP/presentation                                                            | 실제 result·오류·경로·재개 표시, G03/G08                                            |
| N07 | 표준 input/select/confirm/editor·OAuth 취소·notification/status | P 핵심/B 전체        | native UI SPI/host client action                                                            | client 미지원·취소·만료·새 세션 전환·secret 비기록, G01/G03                         |
| N08 | cwd·trust·AGENTS/context·skill/template prompt                  | P/B                  | native resolver/Studio state                                                                | 실제 prompt 포함·중복 주입 방지·신뢰 거부, G02/G06                                  |
| N09 | loaded/selected/effective/grant 및 출처                         | P/B                  | native + metadata/UI                                                                        | empty selection·unknown resource·parent/operator ceiling, G06                       |
| N10 | tool detail/card/usage·child 상태의 재개                        | P 기본/B child 포함  | durable native record/host snapshot                                                         | schema 없는 요약은 한계 표시, child는 G13, 큰 이력 G04                              |
| N11 | keyboard/search/navigation/mobile/accessibility                 | P 핵심/B 전체        | Studio renderer                                                                             | 긴 목록 검색·focus·가상 키보드·승인 카드, G10/G11                                   |

터미널 전용 커스텀 widget은 픽셀 일치가 아닌 capability 범위를 명시한다.
기본 native 업무 작업은 동등 UI/명령으로 제공하고, 확장별 임의 widget의 전면 자동
변환은 별도 extension presentation 계약이다. fallback은 커버리지와 구분해 기록한다.

Preview J02의 완료 기록 자동 갱신은 idle file snapshot이 아니다. 실행 중 CLI가
완료 기록을 append하면 watcher가 갱신하고 freshness/last observed cursor를 표시한다.
실행 중 token/thought/tool/approval delta까지의 live streaming은 공통 observation
publisher가 필요하므로 P-conditional이며 B 필수다. 제안 SLO는 정상 로컬 환경에서
관찰 가능한 변화 후 2초 이내 갱신이다. 이 수치는 측정값이 아니며 환경·부하와 함께 수용한다.
Beta에서 live 보기가 불가하면 [D03](decisions.md)의 최소선(양쪽 보유자 표시·idle 동기화)을 따르고,
그 근거를 [Studio #30](https://github.com/handochan/aelix-studio/issues/30)에 남긴다.

## 4. 측정 기록의 단위

기능 한 줄마다 다음을 저장한다: requirement ID, runtime/artifact hashes, platform,
desktop/WebUI/mobile browser, provider/model/reasoning 설정, 호출 결과, effective state,
persisted record, restart 결과, 증거 경로, accepted/failed/not_run.

실제 모델·합성 fixture·패키지 빌드·네트워크 차단·고객 데이터·오너 UI 수용을
하나의 pass로 합치지 않는다. blocked/unknown 값을 false/0/성공으로 바꾸지 않는다.
현재 계획을 검증했다고 보이게 하기 위한 새 구현 모사 테스트를 추가하지 않는다.

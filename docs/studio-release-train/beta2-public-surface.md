# 공개 beta.2 무수정과 Aion UI 재사용 범위

> 2026-10-24–25 소스 감사에서 작성한 설계다. 이 문서의 현재/미구현 표시는 당시 후보 기준이며, 현행 main·실행 Issue·착수 순서는 [readiness.md](readiness.md)에서 확인한다. 기술 제안과 제품 실행 수용은 구분한다.

2026-10-25 사용자 기준 반영. 설계/소스 확인이며 새 제품 구현·실행 검증 결과가 아니다.
Preview는 공개 beta.2 wheel을 수정하지 않는다. Studio·ACP·별도 확장/helper에서
연결하고, 명령어 수 대신 실제 사용자 작업과 native 반영을 기준으로 수용한다.
기존 Aion UI 재사용 우선 원칙은 **첫 Beta까지** 적용한다. 공개 beta.3 기능을
연결할 때도 같은 selector/설정/세션/preview 표면을 우선하고 필요한 최소 표면만 추가한다.

## 1. 본체를 수정하지 않을 때 남는 제약

| 구분                                             | 현재 공개 beta.2 + stock CLI RPC에서 보장할 수 없는 것                                                                                                | 가능한 범위/대안                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 기존 CLI와 같은 파일의 writer 보장               | 기존 CLI가 공통 session lock을 모른다. ACP 사설 lease로 외부 CLI 쓰기를 차단할 수 없음                                                                | 원본 읽기·완료 기록 갱신·안정된 snapshot에서 새 UUID로 복제 분기. 같은 파일 인계의 전면 보장은 별도 계약에 참여하는 공개 runtime/CLI에서 검증                               |
| 양쪽 실행 중 전체 live 보기                      | stock CLI가 Studio로 token/thought/tool/approval delta를 내보내는 공통 observation publisher가 없음                                                   | 기록된 JSONL을 읽어 갱신. Studio가 직접 소유한 대화의 stream과 독립 CLI를 관찰하는 stream은 구분. 별도 확장 설치가 필요한 관찰 경로는 추가 호환 기능                        |
| 임의 확장 명령/커스텀 TUI 전체                   | stock RPC/일반 bridge에는 모든 확장의 live handler를 실행하는 범용 endpoint가 확인되지 않음. arbitrary TUI widget 자동 웹 변환도 없음                 | 알려진 명령·skill/template과 지원 dialog를 선별 연결. SDK host runner를 새로 소유하면 무수정 wheel로도 경로는 있으나 별도 lifecycle 구현이므로 초기 작은 bridge와 같지 않음 |
| 모든 native permission의 동일 프로세스 live 전환 | beta.2에는 control-v1 permissions/set이 없음                                                                                                          | Ask/Yolo는 아래처럼 native startup + ACP policy로 구현 가능. Plan/Edit/Auto도 native 시작 flag는 있으므로 기능 전체가 불가능한 것은 아니나 완전한 live 동등성은 별도        |
| legacy와 공유 config 동시 mutation의 전면 보장   | session lock과 auth/settings/profile 동시 갱신은 별개. beta.2 auth POSIX flock은 있으나 Windows/atomic rename/stale cache/revision 전체 계약은 미완료 | native store/API 재사용, helper 내부 직렬화, cache 갱신/idle restart. 비협조 CLI와의 안전한 동시 변경은 지원 완료로 주장하지 않음                                           |
| 모든 native 내부 정보의 완전한 복원              | cost completeness·일부 tool details·child 실행/승인/복구 identity가 현재 wire/이력에 충분히 실리지 않음                                               | 있는 정보를 표시하고 unknown/partial을 명시. structured replay/child 제어는 별도 adapter·native capability 확인과 수용 필요                                                 |

이는 현재 구현의 모든 공백을 본체 제약으로 돌린 목록이 아니다. 모델/추론 변경,
Provider 신규 등록, 프로필·tool/skill/extension 관리, fork/clone·import, MCP startup,
Analytics 미리보기, Ask/Yolo는 **Studio/ACP/helper 추가 구현 후보**다. native beta.2에
위임 확장도 존재하므로 현재 ACP의 delegation 거부를 native 기능 부재로 해석하지 않는다.
child의 실제 승인/authority/취소/재접속 계약은 별도 검증한다.

긴 세션은 독립 수용 항목이다. 현재 **ACP** subprocess reader/wire에는 16 MiB 경계가
있고 native get_messages는 전체 배열을 한 응답으로 반환한다. 이를 native HTML 한도나
native JSONL 저장 자체의 16 MiB 상한으로 표현하지 않는다. adapter reader·부분 처리·
파일 기반 paging 후보를 검토하되 native aggregate 구성의 메모리 비용까지 해결됐다고 주장하지 않는다.

## 2. Ask/Yolo 두 모드 — 본체 무수정 구현안

beta.2 CLI는 이미 `--permission-mode default|plan|auto-accept-edits|auto|yolo`를
받는다. 현재 ACP가 Ask만 노출하는 것은 adapter의 capability 조건이다.

| 모드 | native 시작            | ACP 승인 bridge                                         | 유지할 것                                                            |
| ---- | ---------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Ask  | 명시적 default posture | 현재처럼 Studio 승인/거절 카드로 연결                   | native guardrail·tool 선택·다른 확장의 거부·취소/채널 오류 처리      |
| Yolo | 명시적 yolo posture    | 승인 질문 없이 allow. 도구 실행 이벤트/관리 채널은 유지 | 같은 native guardrail·tool 선택·다른 확장의 거부·취소/채널 오류 처리 |

초기 전환은 idle 상태에서 선택→설정 저장→동일 세션 worker restart→effective 상태
확인으로 맞춘다. stock RPC에 없는 원자적 live posture 전환을 약속하지 않는다.
명시한 launch posture와 adapter policy가 일치하는지 확인하고 복구 실패를 silent Yolo로 처리하지 않는다.

**permission 확장을 제거할 필요가 없다.** native launcher는 GuardrailExtension과
PermissionExtension을 prepend하고, Yolo 분기는 승인 prompt만 건너뛴다.
`--no-extensions`는 이 두 built-in gate를 제거하는 옵션이 아니다. 현재 ACP의 bridge는
permission뿐 아니라 controls 설치·ready 검증에도 쓰이므로 통째로 끄지 않는다.
Yolo의 의미는 승인 질문 생략이며 off 상태의 tool/skill/extension을 다시 활성화하는 권한이 아니다.

구현 후 Ask의 실제 거절, Yolo의 client prompt 생략, native 거부 유지, idle 전환/재개,
Stop·관리 채널 오류를 실제 공개 wheel과 Aion host에서 검증한다. 현재 완료된 기능이 아니다.

## 3. 기존 Aion 표면과 실제 binding

| 사용자 작업                        | 재사용할 표면                                | 필요한 연결/현재 확인                                                                                                                                          |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| context/stats/cost                 | 기존 ContextUsageIndicator·usage/status      | AcpSendBox/useAcpMessage가 acp_context_usage를 처리. native 실제 context/한도/비용 의미를 공급하며 별도 /context 복제 불필요                                   |
| model/thinking/permission/settings | 기존 selector·RuntimeSettings·설정창         | configOptions를 native setter에 연결. 전역 Provider/settings는 Aion DB와 native store가 다르므로 화면 재사용과 저장 정본 연결을 함께 수행                      |
| clear                              | 기존 화면 동작 그대로                        | 별도 /clear command·client action·보기 초기화 기능을 신규 구현할 요구에서 제외. context 초기화나 transcript 삭제로 대체하지 않음                               |
| fork/이력 복제                     | 기존 메시지 fork 버튼·lineage·navigation     | Aion ACP fork는 backend capability에 의존하며 현재는 HEAD 분기 표면. 현재 ACP는 session/fork를 광고/처리하지 않으므로 native beta.2 분기 API와 연결 필요       |
| 새 대화/설정 복제                  | 기존 새 대화/clone 표면                      | 현재 ChatConversation의 createWithConversation은 ACP session ID를 지워 새 context를 시작. 이 경로만으로 native 이력 복제 지원이라 세지 않음                    |
| import                             | 기존 파일 선택/가져오기 표면이 있으면 재사용 | native JSONL/source identity를 실제로 등록/변환하고 원본 보존. assistant/skill/MCP 가져오기와 native 세션 가져오기를 구분. 세션 import의 host 통로는 별도 확인 |
| 프로필/도구/스킬/확장              | 기존 agent·tool·skill·설정 구성 요소         | native 프로필·effective inventory·실제 실행 generation에 연결. Aion에만 저장된 설정 성공으로 native 적용을 대신하지 않음                                       |

TUI `/fork`의 before(user entry)와 Aion HEAD fork/clone은 서로 다른 cut이다.
Studio가 Aion HEAD 동작을 제공하는 것은 허용하되 UI가 실제 의미를 정확히 표시한다.
모든 cut 옵션과 동일 이름의 슬래시 명령을 새로 만드는 것이 출시 조건은 아니다.
다만 과거 이력을 이어가는 분기/복제라면 실제 native context에 그 이력이 있어야 한다.

## 4. 확인한 소스 지점과 증거의 수준

- native beta.2 tag `1093cc2578e70500c91fe0a8d340b7db2528c8de`:
  coding-agent `cli/args.py` permission flag, `cli/entry.py` prepend와 held posture,
  `builtin/permission.py` Yolo/guardrail/headless 분기, `rpc/rpc_mode.py` 전체 get_messages,
  `session` 라이브러리 fork API 및 AuthStorage/helper 후보.
- 현재 ACP dirty tree: `runtime/controls.py`의 permission_modes 조건,
  `runtime/policy.py` Yolo allow, `session.py` approval/ready/startup,
  `server.py` sessionCapabilities/branch, `wire/transport.py` frame 경계.
- Studio 현재 작업 트리: `common/adapter/ipcBridge.ts` config/clone/fork/provider,
  `common/chat/forkConversation.ts`, `ChatConversation.tsx`,
  `platforms/acp/AcpSendBox.tsx`, `useAcpMessage.ts`.

본 문서의 기능 가능성은 소스 기반이다. 새 wheel 동작·실제 Aion host wire·설치 앱
수용을 수행하지 않았다. [커버리지 표](tui-coverage.md)의 36개 명령은 참고 inventory이며
각 행의 Studio 표면/제외/추가 연결을 추적한다. 본체 수정으로 blocker를 우회하지 않는다.

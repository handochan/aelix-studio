# Studio / ACP 로컬 개발 운영 진입점

공통 운영 기준은 [Project 9 README](https://github.com/users/handochan/projects/9)에 둔다.
정확한 ID는 `PVT_kwHOA-ATMs4BojoA`다. 이 문서는 로컬에서 같은 기준을 읽는 방법과
진입 파일을 설명한다. 실행 상태는 로컬 세션 기억보다 실제 Issue/Project/PR·CI를 확인한다.

## 작업 시작

```sh
gh project view 9 --owner handochan --format json --jq .readme
gh project item-list 9 --owner handochan --format json --limit 100
```

- 사용자 지시 범위를 먼저 읽고, 큐에서 선택할 때는 자신의 Agent에 배정된 Ready를 확인한다.
- Backlog draft는 아이디어/계획이다. 구현 전 실제 변경 repo의 Issue로 전환하고
  목표·범위/제외·완료 조건·검증·선행 작업을 정리한다.
- 실제 작업·PR·claim을 확인하고 Issue별 branch/worktree를 사용한다. 공통 계약을 먼저
  직렬로 정하고, 이후 독립 구현은 최대 두 개씩 진행한다.
- 구현과 다른 세션이 기본 한 번 리뷰한다. 시작·리뷰 제출·막힘·중단/완료 때만 갱신하고,
  인계에 현재 SHA/PR, 검증과 미실행, 다음 행동, 막힘을 남긴다.
- 같은 Issue가 기존 보드에도 있으면 Project별 Status를 별도로 맞춘다. 연결 기능과
  출시 완료는 실제 native/설치 앱 결과까지 확인한다.

단순 의존 대기는 `blocked`, 사용자 제품 판단은 `needs-decision`으로 구분한다.
일상적인 구현 선택은 agent가 한다. GitHub가 일시적으로 불가하면 확인하지 못한 상태를
명시하고 승인된 로컬 작업/검증의 근거를 보존한다. 동기화·선점·완료를 확인했다고 쓰지 않는다.

## 진입 파일과 적용 범위

- Codex: repository root `AGENTS.md`가 공통 운영 규칙과 repo 규칙을 연결한다.
- Claude Code: root `CLAUDE.md`의 `@AGENTS.md`로 같은 파일을 읽는다. 기존 import를 유지한다.
- ACP의 primary checkout과 현재 Codex worktree에도 같은 두 진입 파일을 둔다.
- Studio의 기존 코드 구조·i18n·검증·push 지침은 기존 AGENTS에 그대로 유지한다.
- Preview는 공개 beta.2 native wheel 무수정이며 첫 Beta까지 Aion 표면 재사용이 우선이다.
  설정/분기 UI의 존재와 실제 native 적용·이력 복원을 구분한다.

새 세션에서 시작하면 새 진입 파일을 기준으로 읽을 수 있다. 이미 열린 세션에서는
AGENTS/CLAUDE와 이 문서를 다시 읽는다. 지침 변경을 다른 머신/새 Git worktree/clone에도
공유하려면 해당 지침을 commit하고 필요한 대상에 전달한다.
지침 파일은 agent가 따를 작업 규약이며 별도 강제 hook이나 상시 동기화 서비스를 설치하지 않는다.

공식 동작 근거: [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[Claude Code instruction/import](https://code.claude.com/docs/en/memory).

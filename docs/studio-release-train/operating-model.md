# Studio / ACP 개발 운영 모델

공통 운영 기준의 정본은 [Project 9 README](https://github.com/users/handochan/projects/9)다.
정확한 ID는 `PVT_kwHOA-ATMs4BojoA`이며 core·ACP·Studio의 관련 Issue만 연결한다.
이 문서는 설계 묶음의 읽기 진입점이다. 보드 규칙과 다른 독립 정책을 만들지 않는다.

## 최소 운영

- Backlog → Ready → In progress → In review → Done. Release는 Preview/Beta/Later, Agent는 Codex/Claude다.
- 사용자는 Backlog에 제목 한 줄의 draft 아이디어를 추가할 수 있다. 실행 전 agent가 기존 작업과 중복을 확인하고 실제 변경 repo의 Issue로 전환해 범위·완료 조건·검증·선행을 보완한다.
- 사용자 또는 한 조정 세션이 Ready 순서와 Agent를 정한다. 초기 공통 계약은 직렬로 정하고 이후 독립 구현만 최대 두 개씩 진행한다.
- 하나의 Issue·실행자·branch/worktree를 사용한다. 같은 manifest/lockfile/공통 계약/host composition은 직렬로 변경한다.
- 다른 세션의 독립 리뷰 한 번과 영향받는 재검증을 한다. 착수·리뷰 제출·막힘·중단/완료 때만 상태를 갱신한다.
- `needs-decision`은 제품 범위·호환성·출시 선택, `blocked`는 실제 선행 조건이다. 일상적인 구현 선택은 agent가 처리한다.
- 연결/출시 Issue는 모든 완료 조건과 final artifact 수용이 끝나야 Done이다. 하나의 backend PR이나 CI green으로 전체 기능을 닫지 않는다.
- 기존 core Project 1·Analytics Project 7은 유지한다. 같은 Issue가 여러 보드에 있으면 checkpoint에서 각각의 Status를 확인한다.

## 다음 실행과 인계

[readiness.md](readiness.md)에서 실제 Issue와 source 기준·선행·보존할 후보를 확인한다.
원래 ACP 로컬 설계는 과거 자료이며 이후 공통 설계 변경은 이 Studio 묶음에 반영한다.
ACP는 [개발 진입 안내](https://github.com/handochan/aelix-acp/blob/main/docs/studio-preview.md)에서 같은 문서를 읽는다.

```text
현재: branch/worktree, 기준 SHA, 현재 SHA/PR
검증: 실행 결과·증거, 미실행
다음: 바로 할 행동
막힘/결정: 선행·해제 조건 또는 없음
```

권한과 repo별 검증 규칙은 root AGENTS를 따른다. 이 운영 문서나 Backlog 등록만으로
push·병합·배포의 새 권한이나 출시 범위 승인이 생기지 않는다. 새 동기화 서비스나 강제 hook은 추가하지 않는다.
기존 운영 진입점의 main 반영은 [Studio PR #2](https://github.com/handochan/aelix-studio/pull/2)와
[ACP PR #3](https://github.com/handochan/aelix-acp/pull/3)에서 확인할 수 있다.

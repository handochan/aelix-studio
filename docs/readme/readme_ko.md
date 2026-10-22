# Aelix Studio

**Aelix Coding을 위한 셀프 호스팅 데스크톱·웹 워크스페이스**입니다.
[AionUi](https://github.com/iOfficeAI/AionUi)를 기반으로 필요한 변경만 유지합니다.

[English](../../readme.md) · [개발·패키징](../aelix-studio/README.md) ·
[Windows 지원](../aelix-studio/windows.md) · [셀프 호스팅·외부 통신 검토](../aelix-studio/self-hosting.md)

## 포함 기능

- 공식 Aelix 브랜드, 독립 앱 ID `ai.aelix.studio`, 앱 데이터 및 Studio 업데이트 피드.
- Python **3.12.12**, Aelix **0.1.0b2**, ACP **0.1.0** 번들.
  설치된 배포본을 실행할 때 별도 Python·uv·pip 설치나 패키지 다운로드가 필요하지 않습니다.
- 데스크톱과 WebUI에서 Aelix Coding 기본 에이전트 등록. 기존 사용자 에이전트와 선택은 보존합니다.
- 도구 실행 전 명시적 승인. Windows는 토큰으로 인증하는 loopback TCP,
  macOS/Linux는 비공개 Unix 소켓을 사용합니다.
- 데스크톱은 로그인 없이 열립니다. WebUI는 해당 서버의 로컬 계정으로 인증하며 외부 계정은 필요하지 않습니다.
- 자동 업데이트 확인·Sentry 이벤트 및 로그 전송 비활성화.
  HTML 편집기는 로컬 번들을 사용하고 Markdown 외부 이미지는 링크를 눌러 열도록 처리합니다.
- WebUI는 비밀번호를 브라우저 저장소에 보관하지 않습니다. 로그인 상태 유지는 서버 세션으로 처리합니다.

모델 인증 정보는 운영자가 설정합니다. 외부 모델 제공자는 해당 네트워크에 연결해야 하며,
폐쇄망에서는 내부 모델 제공자를 사용해야 합니다. Analytics는 별도 선택 통합입니다.

## 지원 상태

| 대상            | 구현                                               | 검증 범위                                             |
| --------------- | -------------------------------------------------- | ----------------------------------------------------- |
| macOS arm64     | 네이티브 런타임·패키징                             | 기존 로컬 데스크톱 검증 및 후속 런타임 검증 기록 참고 |
| Windows x64     | 네이티브 빌드·권한 채널·설치 스크립트 수정·CI 구성 | Windows 실제 설치·UI 검증은 별도 필요                 |
| Linux arm64/x64 | 네이티브 런타임·WebUI·Docker 실행 경로             | 현재 검증 기록 참고                                   |
| Windows arm64   | Studio 번들 미지원                                 | 네이티브 의존성·설치 검증 필요                        |

[배포 구현 및 검증 기록](../aelix-studio/distribution-status.md)에서 실제 실행 결과와 미검증 범위를 구분합니다.
CI 파일 추가만으로 원격 CI 통과나 정식 배포가 완료되었다고 보지 않습니다.

## 실행

Node 22–24, Bun 1.4.4, 빌드용 Python 3.9+, uv 0.11.19를 사용합니다.
배포 대상 OS·아키텍처에서 빌드하세요.

```sh
bun install --frozen-lockfile
node scripts/prepareAioncore.js
bun run studio:runtime
bun run studio:dist
```

Studio 빌드 명령은 Windows와 POSIX의 Python 명령을 자동 선택합니다.

```sh
# WebUI: 런타임 준비 후 실행
bun run package
bun run webui:prod -- --no-build

# Docker: 연결 가능한 빌드 환경에서 이미지를 만든 뒤 폐쇄망으로 이관
docker build -t aelix-studio:local .
docker run --name aelix-studio -p 127.0.0.1:3000:3000 -v aelix-studio-data:/data aelix-studio:local
```

WebUI 초기 로그인 정보는 서버의 비공개 로그에서 확인합니다.
원격 공개 전 [운영·인증·외부 통신 경계](../aelix-studio/self-hosting.md)를 확인하세요.

## AionUi 버전 추적

기준 버전은 **v2.2.2**, SHA는 `6744099b279b991c17e31c243f0920477bd31cb6`이며
AionCore는 **v0.2.2**를 유지합니다. Studio 앱 버전·Aelix 런타임 버전과 별도로 관리합니다.

```sh
node scripts/aelix-studio/checkUpstream.mjs
node scripts/aelix-studio/checkUpstream.mjs --fail-on-drift
```

수동·PR 워크플로는 JSON 비교 보고서를 남기고 변경 발견 시 검토를 요구합니다.
자동 병합·런타임 자동 업데이트는 수행하지 않습니다.

기여 규칙은 [CONTRIBUTING.md](../../CONTRIBUTING.md), 라이선스는
[Apache-2.0](../../LICENSE), 원저작자 표시는 [NOTICE](../../NOTICE)를 참고하세요.

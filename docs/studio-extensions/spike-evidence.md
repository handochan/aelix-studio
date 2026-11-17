# D04 spike 실험 기록

[D04 ADR 초안](README.md)의 근거다. 2026-11-17의 실행 기록이고, 계속 갱신하는 문서가 아니다. 1–6절은 1차
실험, 7절은 첫 독립 리뷰 뒤의 2차 실험, 8절은 둘째 리뷰 뒤의 3차 실험이다. 1차의 세대 관리 절차(3절)와
2차 절차(7.6)에는 리뷰가 찾은 결함이 있었고, 다음 절에서 고쳐 다시 실행했다.

## 환경과 재료

- macOS (Darwin 25.6.0, arm64). Windows와 Linux에서는 실행하지 않았다.
- 번들: Studio #31 worktree에서 준비한 번들형 runtime(`runtime-s1`)의 사본이다. **main에서 만든 번들이
  아니다.** `manifest.json`의 recipe 해시는 branch `codex/studio-31-subagents`의 commit `7510beb38`
  (PR #45, 병합 전)의 파일과 같다. Python 3.12.15, native `e19ab55e17e871a40356fc9802f3f6669ca727de`(0.1.0b2),
  ACP `16d6555b08825d1d63c3b082de2b10a1152562c0`(0.2.0a1). 번들 Python에 pip 26.2.2와 `EXTERNALLY-MANAGED`
  표시가 있다. 번들에 들어가는 것 가운데 main `0665d6004`의 packaging 소스와 다른 것은 셋이다.
  - `launch.py`: `os.environ['PYTHONDONTWRITEBYTECODE'] = '1'`과 `sys.dont_write_bytecode = True` 네 줄이 더
    있다(sha256 `f02e60ac…`, main은 `803a4cd4…`).
  - `launch.cjs`: 어댑터를 띄울 때 `env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }` 한 줄이 더 있다
    (`b68d2f85…`, main은 `72478dc1…`).
  - `native-requirements.lock`: `rich==14.3.4`와 `wcwidth==0.9.4`가 더 있다(`eddf8567…`, main은 `53f67132…`).
  - `bundle.py`, `runtime.py`, `build.mjs`, `build-requirements.txt`는 main과 같다.
- 이 문서의 "번들 무변경"은 그 사본의 `checksums.json`과 같다는 뜻이다. 일부러 뺀 실행(1절 마지막 줄,
  7.5)을 빼면 실험 스크립트가 `PYTHONDONTWRITEBYTECODE=1`을 환경에 직접 줬다. 그래서 1–6절의 결과는
  launcher의 그 줄에 기대지 않는다. main의 launcher로 바꾼 실행은 7.5에 있다.
- 번들 무변경 확인: 실험 묶음이 끝날 때마다 사본의 모든 파일을 그 번들의 `checksums.json`과 대조했다.
  결과는 매번 7,668개 파일, 추가·누락·변경 0이었다. 번들을 일부러 바꾼 실험은 따로 만든 사본에서 했다.
- 실험용 확장(모두 순수 Python wheel, 빌드는 `uv build --wheel --no-config`):
  - `aelix-starter-ext` 0.1.0 / 0.2.0: native wheel에 들어 있는 예제(`examples/starter`). 명령 `/hello`를 등록한다.
  - `aelix-starter-ext` 0.3.0: 없는 모듈을 import하도록 고친 것. 설치는 되고 로드는 안 된다.
  - `studio32-depext` 0.1.0: 번들에 없는 `tabulate>=0.9,<1`에 의존한다.
  - `studio32-conflictext` 0.1.0: `packaging<24`에 의존한다. 번들에는 `packaging 26.3`이 있다.
- 격리: native와 pip을 실행할 때는 `HOME`과 `AELIX_CODING_AGENT_DIR`을 실험 디렉터리로 돌렸다. 실제
  `~/.aelix`와 사용자의 pip 설정은 읽지도 쓰지도 않았다. 실험에서 외부로 나간 것은 PyPI에 대한 익명 패키지
  조회뿐이다.
- 네트워크 차단: `sandbox-exec -p '(version 1)(allow default)(deny network*)'`. 내부 index 실험은 여기에
  `(allow network-outbound (remote ip "localhost:18732"))`만 더했다. 차단 상태에서 `curl https://pypi.org`가
  실패하는 것을 먼저 확인했다.
- 내부 index: wheel로 만든 PEP 503 디렉터리를 `python -m http.server --bind 127.0.0.1 18732`로 띄웠다.
- 세대 관리 절차는 시험용 Python 스크립트로 돌렸다(1차 약 350줄, 2차 약 600줄, 3차 약 700줄). 저장소에
  넣지 않았다. 3차 스크립트가 하는 일은 ADR 5.3–5.9에 적힌 순서와 같다. 다만 되돌리기와 lease의 잠금
  순서는 ADR 5.6의 설계와 다르다(잠금 밖에서 포인터를 읽는다).

아래 명령에서 `<번들>`은 번들 사본, `<세대>`는 세대 디렉터리, `<W>`는 실험용 wheel 디렉터리다.
`세대 실행`은 `<세대>/venv/bin/python -I -B -X utf8 <번들>/launch.py native`를 줄인 말이다.

## 1. 지금 번들에서

| 실행                                                                                                              | 관찰                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATH=/usr/bin:/bin <번들>/native/bin/aelix extension list`                                                       | `No extensions installed (via entry_points).` 종료 0                                                                                                                                                                                               |
| `PATH=/usr/bin:/bin <번들>/native/bin/aelix extension install <W>/aelix_starter_ext-0.1.0-py3-none-any.whl --yes` | `Error: cannot install '…' (source: path) — no usable package installer. This interpreter (…/python/bin/python3) has no pip, and no uv executable is on PATH.` 종료 2. 번들 무변경                                                                 |
| 같은 명령, `PATH`에 Homebrew `uv` 0.11.19 포함                                                                    | `→ /opt/homebrew/bin/uv pip install --python <번들>/python/bin/python3 <wheel>` 뒤 `error: The interpreter at bundle/python is externally managed … managed by uv and should not be modified.` `uv install failed (exit 2).` 종료 1. 번들 무변경   |
| `PYTHONPATH=/x PYTHONUSERBASE=/y <번들>/python/bin/python3 -I -S -B -X utf8 <번들>/launch.py helper -c <probe>`   | `sys.path` = `native-site`, `python312.zip`, `python3.12`, `lib-dynload`. `find_spec('pip')` 없음. native가 인정하는 설치 디렉터리 = `<번들>/python/lib/python3.12/site-packages`와 `/y/lib/python3.12/site-packages`. `native-site`는 목록에 없다 |
| 번들 사본의 `native-site`에 `aelix_starter`와 그 `dist-info`를 복사하고 `native/bin/aelix extension list`         | `aelix-starter [aelix-starter-ext 0.2.0] — REFUSED (untrusted sys.path provenance); not loaded`                                                                                                                                                    |
| `PYTHONDONTWRITEBYTECODE=1 <번들>/python/bin/python3 -I -B -m venv v1`                                            | 종료 0. 번들 무변경. venv 12MB. `pyvenv.cfg`의 `home = <번들>/python/bin`, `bin/python3`은 번들 Python을 가리키는 링크                                                                                                                             |
| 같은 명령에서 환경 변수만 뺌                                                                                      | 종료 0. 번들에 `python/lib/python3.12/__pycache__/*.pyc` 등 **166개 파일이 추가됐다**                                                                                                                                                              |

## 2. venv 세대를 직접 실행

| 실행                                                                                                                         | 관찰                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<세대>/venv/bin/python -I -S -B -X utf8 <번들>/launch.py helper -c <probe>` (`-S` 있음)                                     | `sys.prefix` = 번들 Python. `sys.path`에 세대 없음. pip 없음, 설치 도구 없음                                                                                                                                                                                                            |
| 같은 명령에서 `-S`만 뺌                                                                                                      | `sys.prefix` = 세대 venv. `sys.path` = `native-site`, 표준 라이브러리 3개, `<세대>/venv/lib/python3.12/site-packages`. 설치 도구 = pip. 인정하는 설치 디렉터리에 세대 `site-packages`가 들어간다                                                                                        |
| `세대 실행 extension install <W>/aelix_starter_ext-0.1.0-py3-none-any.whl --yes`                                             | `→ <세대>/venv/bin/python -P -m pip install <wheel>`, `Successfully installed aelix-starter-ext-0.1.0`, `Installed. Restart aelix …` 종료 0. `<agent dir>/settings.json`에 `{"spec": "<wheel 절대 경로>", "kind": "path", "name": "aelix-starter-ext"}`, `extension_pins.json` 생성     |
| `세대 실행 extension list` / `extension verify`                                                                              | `aelix-starter [aelix-starter-ext 0.1.0]` / `BOUND aelix-starter … verify: all 1 endpoint(s) BOUND.` 둘 다 종료 0                                                                                                                                                                       |
| `세대 실행 --offline status --json`                                                                                          | `discovered_extensions: [{"has_manifest": true, "name": "aelix-starter", "scope": "entry_point", "version": "0.1.0"}]`, `extension_errors: []`                                                                                                                                          |
| `세대 실행 --offline --mode rpc --no-session`에 `aelix_control` 요청                                                         | `extensions/list` → `[{"name": "aelix-starter", "distribution": "aelix-starter-ext", "version": "0.1.0", "entry": "aelix_starter:setup"}]`. `resources/list` → `extensions`에 `aelix-starter`(source = 세대의 `aelix_starter` 디렉터리), `commands: ["hello"]`. 모델 설정 없이 응답했다 |
| `세대 실행 --offline extension install <W>/studio32_depext-0.1.0-py3-none-any.whl --yes` (네트워크 열림, pip 환경 변수 없음) | `Collecting tabulate<1,>=0.9 … Downloading tabulate-0.10.0-py3-none-any.whl` 종료 0. **`--offline`인데 PyPI에서 받았다**                                                                                                                                                                |

## 3. 세대 관리 절차

1차 절차다. 리뷰 뒤에 바뀐 점: 후보 복제가 `site-packages`만 복사했다(7.6에서 `RECORD` 기준으로 바꿈),
검증이 `status --json`에 기댔다(7.1), 13–14번의 번들 교체 처리가 현재 세대의 링크를 먼저 고쳤다(7.6).
아래 관찰 자체는 그대로 유효하다.

각 줄은 "후보 세대 만들기 → native CLI 실행 → 검증 → 전환 또는 폐기"를 한 번 돈 것이다. 기본 환경은
`PYTHONPATH=<번들>/native-site`, `PIP_CONSTRAINT=<번들 배포판 목록>`, `PYTHONDONTWRITEBYTECODE=1`,
`PIP_DISABLE_PIP_VERSION_CHECK=1`, `AELIX_CODING_AGENT_DIR=<후보>/agent`다. 후보 만들기는 1.3–2.0초였다.

| #   | 네트워크   | native 명령과 추가 환경                                                                                          | 관찰                                                                                                                                                                                                                                        | 결과                    |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | 전부 차단  | `--offline extension install <W>/aelix_starter_ext-0.1.0-….whl --yes`, `PIP_NO_INDEX=1`                          | 종료 0. `status`: `aelix-starter 0.1.0` 로드                                                                                                                                                                                                | g1로 전환               |
| 2   | 전부 차단  | `--offline extension install <W>/studio32_depext-0.1.0-….whl --yes`, `PIP_NO_INDEX=1` (의존성 없음)              | `ERROR: No matching distribution found for tabulate<1,>=0.9`, `pip install failed (exit 1).` 종료 1. 같은 종류의 실패(의존성 없음, 전부 차단)를 따로 재 보니 2.3초였다                                                                      | 후보 폐기, g1 유지      |
| 3   | 전부 차단  | 같은 wheel, `PIP_NO_INDEX=1`, `PIP_FIND_LINKS=<wheel 두 개가 든 폴더>`                                           | `Looking in links: …`, `Successfully installed studio32-depext-0.1.0 tabulate-0.10.0` 종료 0                                                                                                                                                | g2로 전환               |
| 4   | 열림       | `extension install <W>/studio32_conflictext-0.1.0-….whl --yes`                                                   | `The conflict is caused by: studio32-conflictext 0.1.0 depends on packaging<24 / The user requested (constraint) packaging==26.3`, `ResolutionImpossible` 종료 1                                                                            | 후보 폐기               |
| 4a  | 열림       | 같은 명령, `PIP_CONSTRAINT`와 `PYTHONPATH` 없이                                                                  | `Successfully installed packaging-23.2 studio32-conflictext-0.1.0` 종료 **0**. 검증: `shadows bundled distributions: packaging 23.2 (bundle 26.3)`                                                                                          | 후보 폐기               |
| 4b  | 열림       | 같은 명령, `PIP_CONSTRAINT`만 없이                                                                               | `Not uninstalling packaging at <번들>/native-site, outside environment <후보>/venv` 뒤 `Successfully installed packaging-23.2 …` 종료 **0**. 검증이 같은 이유로 실패                                                                        | 후보 폐기               |
| 5   | 열림       | `extension remove studio32-depext --yes`                                                                         | `Successfully uninstalled studio32-depext-0.1.0` 종료 0. 세대에 `tabulate`가 남는다                                                                                                                                                         | g3로 전환               |
| 5a  | 열림       | `extension remove tabulate --yes`                                                                                | `Error: no installed extension provides 'tabulate' (via entry_points group 'aelix.extensions').` 종료 2                                                                                                                                     | 후보 폐기               |
| 6   | 열림       | `extension install git+file://<starter git 저장소> --yes`                                                        | `Installing build dependencies`(빌드 도구를 index에서 받음), `Successfully built aelix-starter-ext`, 종료 0. native: `git ref is not pinned to a commit SHA — NOT pinned`                                                                   | 전환                    |
| 7   | loopback만 | `extension install aelix-starter-ext --yes --index-url http://127.0.0.1:18732/simple/`, 이어서 `studio32-depext` | `Looking in indexes: http://127.0.0.1:18732/simple/`, `Successfully installed …` 종료 0. 기록은 `{"spec": "aelix-starter-ext", "kind": "pypi"}`이고 index 주소는 기록되지 않는다                                                            | g7, g8로 전환           |
| 8   | loopback만 | index에 0.2.0을 올린 뒤 `extension update aelix-starter-ext --yes`, `PIP_INDEX_URL=<같은 index>`                 | `→ … -m pip install --upgrade aelix-starter-ext`, `Successfully installed aelix-starter-ext-0.2.0` 종료 0. `status`: 0.2.0 로드                                                                                                             | g9로 전환               |
| 9   | —          | 현재 세대 표시를 이전 세대로 바꿈, 다시 한 번 바꿈                                                               | `status`: 0.1.0 로드 → 0.2.0 로드                                                                                                                                                                                                           | g8 → g9                 |
| 10  | 열림       | `extension update aelix-starter-ext --yes`, `PIP_INDEX_URL=http://127.0.0.1:18733/simple/` (듣는 프로세스 없음)  | `Requirement already satisfied: aelix-starter-ext … (0.2.0)`, `Connection refused` 재시도 5회, 종료 **0**                                                                                                                                   | 내용이 같은 세대로 전환 |
| 11  | loopback만 | index에 0.3.0(로드 안 됨)을 올린 뒤 `extension update aelix-starter-ext --yes`                                   | `Successfully installed aelix-starter-ext-0.3.0`, native 종료 **0**. 검증: `extension_errors: ["ExtensionLoadError(path='aelix-starter', error=\"No module named 'studio32_module_that_does_not_exist'\")"]`                                | 후보 폐기, 0.2.0 유지   |
| 12  | —          | 위 실행 전체가 끝난 뒤 사용자 agent dir(`$HOME/.aelix`) 확인                                                     | 디렉터리가 만들어지지 않았다. 설치 기록과 pin은 `<세대>/agent/`에만 있다. 세대 하나 12MB, 세대 10개 124MB                                                                                                                                   | —                       |
| 13  | —          | 번들을 새 경로에 다시 놓고 옛 번들을 지운 뒤 `세대 실행 extension list`                                          | `No such file or directory: '<세대>/venv/bin/python'`. `pyvenv.cfg`의 `home`·`executable`과 `bin/python3` 링크를 새 번들로 고친 뒤: `aelix-starter [aelix-starter-ext 0.2.0]`, `studio32-depext …`, `status` 오류 없음                      | 같은 세대 유지          |
| 14  | loopback만 | 번들 사본의 `native-site`에 `tabulate`를 넣고 `manifest.json`의 lock 해시를 바꾼 "새 번들"에 다시 묶음           | 검증 실패: `shadows bundled distributions: tabulate 0.10.0 (bundle 0.10.0)`. 빈 후보에 기록 두 건을 다시 설치: `Requirement already satisfied: tabulate … in <새 번들>/native-site`. 새 세대에는 `aelix_starter`와 `studio32_depext`만 있다 | 새 세대로 전환          |
| 15  | —          | 번들 사본의 `manifest.json`만 Python 3.13.1로 바꾸고 다시 묶기 시도                                              | `ABI changed darwin-arm64/3.12 -> darwin-arm64/3.13`. 실제 3.13으로 실행하지는 않았다                                                                                                                                                       | 다시 만들기 필요로 판정 |
| 16  | 전부 차단  | 세대 디렉터리와 반입 폴더를 `…/Application Support/스튜디오 데이터/…` 아래에 두고 1·3번과 같은 설치              | `PIP_CONSTRAINT`에 경로를 그대로 주면 `ERROR: Could not open constraint file: … '…/Application'`. `file://…/Application%20Support/%EC%8A%A4…`로 주면 `Successfully installed studio32-depext-0.1.0 tabulate-0.10.0`                         | URL일 때 전환           |

## 4. ACP 어댑터를 거쳐서

번들의 `launch.cjs`와 어댑터는 수정하지 않았다. 최소한의 ACP 클라이언트로 `initialize` → `session/new` →
`session/prompt`를 보냈고 승인 요청에는 모두 허용으로 답했다. `GEN`은
`--aelix <세대>/venv/bin/python --aelix-arg=-I --aelix-arg=-B --aelix-arg=-Xutf8 --aelix-arg=<번들>/launch.py --aelix-arg=native`다.

| 실행                                                                                            | prompt                             | 관찰                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node <번들>/launch.cjs`                                                                        | `/extension list`                  | `"text": "No extensions installed (via entry_points).\n"`                                                                                             |
| `node <번들>/launch.cjs GEN`                                                                    | `/extension list`, `/hello`        | 목록: `aelix-starter [aelix-starter-ext 0.1.0]`. `/hello`: `{"code": -32602, "message": "Unknown slash command: /hello"}`. 광고된 명령에 `hello` 없음 |
| `node <번들>/launch.cjs GEN --extension aelix_starter:setup`                                    | `/hello`                           | `hello from the aelix starter extension`. 광고된 명령에 `hello` 있음                                                                                  |
| `node <번들>/launch.cjs GEN --extension <세대>/venv/lib/python3.12/site-packages/aelix_starter` | `/hello`                           | 위와 같다                                                                                                                                             |
| `node <번들>/launch.cjs --extension aelix_starter:setup`                                        | `/hello`                           | 어댑터 stderr: `ExtensionLoadError(path='aelix_starter:setup', error="No module named 'aelix_starter'")`. `/hello`는 Unknown                          |
| `node <번들>/launch.cjs GEN`                                                                    | `/extension install <0.2.0 wheel>` | 승인 요청 `"install extension"` 뒤 `"exitCode": 0, "requiresReload": true`. 세대의 `aelix_starter_ext-0.1.0.dist-info`가 `0.2.0.dist-info`로 바뀌었다 |
| `node <번들>/launch.cjs`                                                                        | `/extension install <0.2.0 wheel>` | `{"code": -33002, "message": "Aelix extension manager failed", "data": {"kind": "turn_failed_after_dispatch", "retryable": false}}`                   |

## 5. overlay 디렉터리

번들 Python을 그대로 쓰고, `launch.py`를 감싸 디렉터리 하나를 `sys.path` 끝에 더하는 시험용 launcher로
실행했다. overlay는 `<base>/lib/python3.12/site-packages`에 뒀다.

| 실행                                                                                                                      | 관찰                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<번들>/python/bin/python3 -I -B -m pip install --no-compile --target <overlay> <0.1.0 wheel>` (native CLI를 거치지 않음) | 종료 0. overlay에 `aelix_starter`와 `dist-info`. 번들 무변경                                                                                                                                                                          |
| overlay를 더한 launcher로 `extension list` / `verify` / `status --json`                                                   | `REFUSED (untrusted sys.path provenance); not loaded` / `UNTRUSTED_PATH … resolves to <overlay>, which is OUTSIDE this interpreter's environment site directories` 종료 1 / 로드 없음, 오류 1건                                       |
| 위에 `PYTHONUSERBASE=<base>` 추가                                                                                         | `aelix-starter [aelix-starter-ext 0.1.0]` / `BOUND` 종료 0 / 로드됨                                                                                                                                                                   |
| launcher(`-S`)로 `extension install <wheel> --yes`, `PIP_TARGET=<overlay>`                                                | `no usable package installer` 종료 2                                                                                                                                                                                                  |
| launcher가 번들 Python의 pip도 `sys.path`에 더하게 하고 `extension install <0.2.0 wheel> --yes`, `PIP_TARGET=<overlay>`   | `Successfully installed aelix-starter-ext-0.2.0`, `WARNING: Target directory <overlay>/aelix_starter already exists. Specify --upgrade to force replacement.` 종료 **0**. overlay에 `0.1.0.dist-info`와 `0.2.0.dist-info`가 함께 있다 |
| 같은 launcher로 `extension remove aelix-starter --yes`                                                                    | `error: externally-managed-environment` 종료 1. `PYTHONPATH=<overlay>`를 더해도 같다. `PIP_BREAK_SYSTEM_PACKAGES=1`까지 주면 종료 0                                                                                                   |
| 제거 뒤 `extension list`                                                                                                  | overlay에 `aelix_starter_ext-0.1.0.dist-info`만 남았다. `aelix-starter [aelix-starter-ext 0.1.0] — manifest not bound (unproven); declarations inert`                                                                                 |

## 6. 사용자 CLI 쪽 확장

사용자 CLI 환경은 같은 agent dir을 쓰는 두 번째 venv로 대신했다. 실제 사용자의 `uv tool` 환경으로 실행한
것이 아니다.

| 실행                                                                                                                         | 관찰                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<agent dir>/extensions/`에 `hello_global.py`와 `needs_tabulate.py`를 두고 `<번들>/native/bin/aelix --offline status --json` | 로드: `hello_global.py`(scope `global`). 오류 1건. RPC `resources/list`로 보면 `extensionErrors: [{"source": "…/needs_tabulate.py", "message": "No module named 'tabulate'"}]`, `commands: ["hello-global"]`이고 `extensions/list`는 `[]`다 |
| 같은 상태에서 `node <번들>/launch.cjs`, prompt `/hello-global`                                                               | `Unknown slash command: /hello-global`                                                                                                                                                                                                      |
| 두 번째 환경에서 `extension install <0.1.0 wheel> --yes`                                                                     | 종료 0. 공유 `settings.json`에 기록이 생겼다                                                                                                                                                                                                |
| `<번들>/native/bin/aelix extension list`                                                                                     | `No extensions installed (via entry_points).`                                                                                                                                                                                               |
| `<번들>/native/bin/aelix extension source list`                                                                              | `[catalog] https://handochan.github.io/aelix-marketplace/catalog.json (built-in default — present)`, `[path] <wheel> (installed as aelix-starter-ext)`                                                                                      |
| agent dir을 공유하는 빈 세대에서 `extension update --yes` (이름 없음)                                                        | `Upgrade extension from path: <wheel>`, `Successfully installed aelix-starter-ext-0.1.0`. 그 세대의 `extension list`에 `aelix-starter`가 생겼다                                                                                             |
| 그 세대에서 `extension install <depext wheel> --yes` 뒤 두 번째 환경에서 `extension source list` / `list`                    | 기록 목록에 `studio32_depext` 줄이 생겼다. `extension list`는 `aelix-starter`뿐이다                                                                                                                                                         |

## 7. 2차 실험 (독립 리뷰 반영)

리뷰의 지적 아홉 건을 각각 다시 실행해 확인한 뒤, 고친 절차를 실행했다. 추가로 만든 실험용 wheel:

- `studio32-lazyok` / `studio32-lazybroken` / `studio32-setupfail`: manifest의 활성화 조건이 `on_command`뿐이다.
  차례로 정상, import할 때 없는 모듈을 찾음, `setup()`이 예외를 냄.
- `studio32-sitecust`(`sitecustomize.py`를 싣는다), `studio32-pthext`(`.pth`를 싣는다), `studio32-shadow`
  (`packaging/__init__.py`를 싣는다), `studio32-scriptext`(console script `studio32-aux`와 `site-packages` 밖의
  data 파일 `share/studio32/info.txt`를 싣는다).
- `studio32-directext`: `Requires-Dist: studio32-directlib @ http://127.0.0.1:18741/…whl`.

`대화 형태`는 `<번들>/python/bin/python3 -I -S -B -X utf8 <시험용 launcher> <번들> native …`를 줄인 말이다.
시험용 launcher는 환경 변수로 받은 세대 `site-packages`를 `sys.path` 끝에 더한 뒤 번들의 `launch.py`를
실행한다. 번들의 launcher는 고치지 않았다.

### 7.1 지연 활성화와 검증 방법

세 pack을 한 세대에 설치했다. 설치 종료 코드는 셋 다 0이었다.

| 실행                                                                                                   | 관찰                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `세대 실행 extension verify`                                                                           | `verify: all 3 endpoint(s) BOUND.` 종료 0                                                                                                                                                                                                                                             |
| `세대 실행 --offline status --json`                                                                    | `discovered_extensions`에 셋 다 있고 `extension_errors: []`                                                                                                                                                                                                                           |
| `세대 실행 --offline --mode rpc --no-session`(entry point 경로)에서 `resources/list`, 이어서 명령 실행 | 시작 때 `extensionErrors: []`. `/studio32-lazybroken-cmd` → `activating plugin 'studio32-lazybroken' failed: No module named 'studio32_module_that_does_not_exist'`. `/studio32-setupfail-cmd` → `activating plugin 'studio32-setupfail' failed: setup() of studio32-setupfail fails` |
| 같은 명령에 `--no-extensions -e studio32_lazybroken:setup` (ACP가 쓰는 경로)                           | `extensions: []`, `extensionErrors: [{"source": "studio32_lazybroken:setup", "message": "No module named 'studio32_module_that_does_not_exist'"}]`                                                                                                                                    |
| 같은 명령에 `--no-extensions -e studio32_setupfail:setup`                                              | `extensionErrors: [{"source": "studio32_setupfail:setup", "message": "setup() of studio32-setupfail fails"}]`                                                                                                                                                                         |
| 같은 명령에 `--no-extensions -e studio32_lazyok:setup`                                                 | `extensions: ["studio32_lazyok:setup"]`, `extensionErrors: []`, `commands: ["studio32-lazyok-cmd"]`                                                                                                                                                                                   |
| 세대 interpreter에서 `importlib.metadata`로 `aelix.extensions` entry point를 하나씩 `load()`           | `studio32-lazybroken IMPORT FAILED: ModuleNotFoundError`, `studio32-lazyok import ok`, `studio32-setupfail import ok`                                                                                                                                                                 |

### 7.2 시작 코드

세대에 `packaging 23.2`를 설치했다(번들은 26.3). 같은 probe를 두 형태로 실행했다.

| 세대의 상태                                        | venv interpreter, `-I -B` (`site` 켜짐)                        | 번들 interpreter, `-I -S -B`, 세대를 launcher가 추가        |
| -------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| 시작 파일 없음                                     | `packaging 26.3 from BUNDLE`                                   | `packaging 26.3 from BUNDLE`                                |
| `sitecustomize.py`(`import packaging`), `.pth` 0개 | `packaging 23.2 from GENERATION`, `sitecustomize loaded: True` | `packaging 26.3 from BUNDLE`, `sitecustomize loaded: False` |
| `.pth` 한 줄(`import os; os.environ[…] = "yes"`)   | `pth code ran: yes`                                            | `pth code ran: no`                                          |

세 경우 모두 `sys.path[0]`은 `native-site`였다.

### 7.3 pip과 접속

요청을 기록하는 HTTP 서버를 `127.0.0.1:18741`에 띄웠다. 네트워크는 열어 둔 상태다.

| 실행                                                                                                                                                  | 관찰                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `세대 실행 --offline extension install studio32_directext-….whl --yes`, `PIP_NO_INDEX=1`, `PIP_FIND_LINKS=file://<폴더>`, `PIP_CONFIG_FILE=/dev/null` | `Collecting studio32-directlib @ http://127.0.0.1:18741/…`, `Downloading …`, 종료 0. 서버 기록: `/studio32_directlib-0.1.0-py3-none-any.whl`                                 |
| 사용자 pip 설정 `[global] find-links = http://127.0.0.1:18741/`, 의존성이 빠진 wheel, `PIP_NO_INDEX=1`                                                | `Looking in links: http://127.0.0.1:18741/`, 서버 기록: `/`. `PIP_CONFIG_FILE=/dev/null`을 주면 서버 기록 없음                                                               |
| 사용자 pip 설정 `[install] target = <다른 디렉터리>`                                                                                                  | `Successfully installed aelix-starter-ext-0.1.0`, `Installed, but this build has no binding verdict for it …` 종료 **0**. 세대에는 아무것도 없고 다른 디렉터리에 파일이 있다 |
| 직접 URL wheel에 죽은 proxy(`HTTP_PROXY`·`HTTPS_PROXY`·`ALL_PROXY=http://127.0.0.1:9`)                                                                | `error: proxy-connection-failed`, 종료 1, 서버 기록 없음. 같은 proxy로 정상 묶음은 `Successfully installed studio32-depext-0.1.0 tabulate-0.10.0`                            |
| sdist(`aelix_starter_ext-0.1.0.tar.gz`), `PIP_NO_INDEX=1`, `PIP_ONLY_BINARY=:all:`                                                                    | `Installing build dependencies: started` … `No matching distribution found for hatchling`, 종료 1. `PIP_ONLY_BINARY`를 빼도 같다                                             |
| 정적 검사(파일만 읽는 스크립트)                                                                                                                       | 직접 URL wheel: `REFUSED … direct-reference dependency: studio32-directlib @ http://…`. sdist: `REFUSED … not a wheel`. 정상 묶음: `checked 2 wheel(s): acceptable`          |

Python 소켓 호출 추적. native 부모에는 launcher 앞에서, pip 자식에는 `PYTHONPATH`로 audit hook을 넣어
`socket.*` 이벤트를 기록했다(소켓 객체 생성, `gethostname`, `getservbyname`은 뺐다). venv 만들기는 추적하지
않았다.

| 실행                                                             | 기록된 소켓 호출                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 정상 묶음 설치 (native 부모 + pip 자식)                          | `socket.bind(('::1', 0))` 두 번. 위치는 `<native-site>/urllib3/util/connection.py:127`과 `<세대>/pip/_vendor/urllib3/util/connection.py:127`(`_has_ipv6`). 그 밖에 없음 |
| `extension verify`                                               | 같은 bind 한 번. 그 밖에 없음                                                                                                                                           |
| 로드 검사(대화 형태, `--no-extensions -e studio32_depext:setup`) | 같은 bind 한 번. 그 밖에 없음                                                                                                                                           |
| 직접 URL wheel 설치 (정적 검사와 죽은 proxy 없이)                | 위 bind에 더해 `socket.getaddrinfo('127.0.0.1', 18741, …)`와 `socket.connect(('127.0.0.1', 18741))`                                                                     |

sandbox(`deny network*`)가 system log에 남기는 거부 기록도 봤다. curl의 연결 시도와 pip의 직접 URL 연결
시도(`python3.12 deny(1) network-outbound remote:*:18741`)는 기록됐다. 그러나 `urllib3`의 bind 시도는 어떤
실행에서는 기록되고(`network-bind local:*:0`) 어떤 실행에서는 기록되지 않았다. 횟수의 증거로 쓰지 않는다.

### 7.4 ACP와 대화 형태

`HYB`는 `--aelix <번들>/python/bin/python3 --aelix-arg=-I --aelix-arg=-S --aelix-arg=-B --aelix-arg=-Xutf8 --aelix-arg=<시험용 launcher> --aelix-arg=<번들> --aelix-arg=native`다.
세대에는 `aelix-starter-ext 0.1.0`, `studio32-depext 0.1.0`, `tabulate 0.10.0`이 있다. 어댑터와 `launch.cjs`는
번들 그대로다.

| 실행                                                                                                                              | prompt                                                                                        | 관찰                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node <번들>/launch.cjs HYB --extension aelix_starter:setup --extension studio32_depext:setup`                                    | `/hello`, `/studio32-table`                                                                   | `hello from the aelix starter extension`. `tabulate  0.10.0` 표(세대에만 있는 의존성)                                                                                                                    |
| `node <번들>/launch.cjs HYB --extension aelix_starter:setup`                                                                      | `/extension list`, `/extension install <0.2.0 wheel>`, `/extension remove aelix-starter`      | 목록: `aelix-starter … — REFUSED (untrusted sys.path provenance); not loaded`. install·remove 둘 다 승인 뒤 `{"code": -33002, "message": "Aelix extension manager failed"}`. 세대의 `dist-info`는 그대로 |
| 같은 실행, `PATH`에 `uv` 포함                                                                                                     | install, remove                                                                               | 위와 같다. 세대에 pip이 있어 pip 경로를 탔다. uv로 넘어가는 경우의 확인이 아니다                                                                                                                         |
| 어댑터가 실행한 명령을 직접 실행(`대화 형태 extension install <wheel> --yes`)                                                     | —                                                                                             | `→ <번들>/python/bin/python3 -P -m pip install …`, `error: externally-managed-environment`, `pip install failed (exit 1).` `remove`도 같은 오류. 추가한 디렉터리에 pip이 없으면 종료 2                   |
| `node <번들>/launch.cjs <세대 venv interpreter 인자> --extension aelix_starter:setup --extension-manager <번들>/native/bin/aelix` | `/extension list`, install, remove                                                            | 목록: `No extensions installed`. install·remove는 `-33002`. 세대는 그대로                                                                                                                                |
| `node <번들>/launch.cjs HYB --extension aelix_starter:setup`                                                                      | `/extension disable aelix_starter:setup`, `/hello`                                            | `{"code": -32004, "message": "This extension is part of the adapter's launch configuration; change that configuration instead", "data": {"kind": "extension_owned_by_launch", …}}`. `/hello`는 계속 동작 |
| `node <번들>/launch.cjs HYB` (`--extension` 없음)                                                                                 | `/hello`, `/extension enable aelix_starter:setup`, `/hello`, `/extension disable …`, `/hello` | Unknown → 승인 뒤 `"loaded": true` → `hello from …` → 승인 뒤 `"enabledExtensions": []` → Unknown                                                                                                        |

pack마다 링크 하나를 둔 디렉터리(`packs/aelix_starter -> <세대>/…/site-packages/aelix_starter` 등 셋).

| 실행                                                                     | 관찰                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `대화 형태 --offline --mode rpc --no-session --no-extensions -e <packs>` | `extensions: ["aelix-starter", "studio32-lazybroken", "studio32-lazyok"]`(plugin id), `extensionErrors: []`, `aelix-starter`의 source는 `<packs>/aelix_starter`. `/hello`와 `/studio32-lazyok-cmd`는 동작, `/studio32-lazybroken-cmd`는 첫 사용에서 `activating plugin … failed` |
| 같은 세 pack을 `-e <모듈 참조>` 셋으로                                   | `extensions: ["aelix_starter:setup", "studio32_lazyok:setup"]`, `extensionErrors`에 `studio32_lazybroken:setup`                                                                                                                                                                  |
| `node <번들>/launch.cjs HYB --extension <packs>`                         | `/hello`, `/studio32-lazyok-cmd` 동작. `/extension disable <packs>`는 `extension_owned_by_launch`                                                                                                                                                                                |

확장이 `sys.executable`로 자식 interpreter를 띄우는 경우.

| 부모                                           | 자식의 `import tabulate`                          |
| ---------------------------------------------- | ------------------------------------------------- |
| venv interpreter (`site` 켜짐)                 | `child sees tabulate 0.10.0`                      |
| 대화 형태                                      | `ModuleNotFoundError: No module named 'tabulate'` |
| 지금 번들(세대 없음), 자식의 `import pydantic` | `ModuleNotFoundError: No module named 'pydantic'` |

### 7.5 main의 launcher로

번들 사본의 `launch.py`와 `launch.cjs`를 main `0665d6004`의 파일로 바꾼 뒤 실행했다.

| launcher                                       | Studio가 `PYTHONDONTWRITEBYTECODE=1`을 주는가 | `extension install` 한 번 뒤 번들에 추가된 파일          |
| ---------------------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| main                                           | 아니오                                        | **163개** (`python/lib/python3.12/__pycache__/*.pyc` 등) |
| main                                           | 예                                            | 0개. `extension list`에 설치한 확장이 나온다             |
| #31 (`7510beb38`)                              | 아니오                                        | 0개                                                      |
| main, ACP 세션(`/hello`), 변수는 어댑터 환경에 | 예                                            | 0개. `hello from the aelix starter extension`            |

### 7.6 고친 절차

2차 스크립트의 순서: 반입 묶음 정적 검사와 보관소 복사 → 잠금 → 미완성 후보 정리 → 후보(새 venv +
부모 `RECORD` 기준 복사) → 정적 검사 → native CLI → 정적 검사 → `extension verify`와 로드 검사 → revision
확인 → 전환. 설치는 모두 파일 반입(`--offline`)으로 했다.

| #   | 네트워크  | 실행                                                                    | 관찰                                                                                                                                                                                                                                                                                                            | 결과           |
| --- | --------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1   | 전부 차단 | `studio32_depext` + 같은 폴더의 `tabulate`                              | `import set …: 2 wheel(s) checked and copied to the artifact store`, 설치 0, `static scan passed`, `loaded with -e: ["studio32_depext:setup"]`                                                                                                                                                                  | g1로 전환      |
| 2   | 열림      | `studio32_directext`(직접 URL 의존성)                                   | `REFUSED before any installer ran: … direct-reference dependency …` 종료 7. 후보를 만들지 않았다                                                                                                                                                                                                                | g1 유지        |
| 3   | 열림      | `studio32_lazybroken`, `studio32_setupfail`, `studio32_lazyok`          | 앞의 둘: native 종료 0, `verify FAILED: load error …`. 셋째: 통과                                                                                                                                                                                                                                               | 폐기, 폐기, g2 |
| 4   | 열림      | `studio32_sitecust`, `studio32_pthext`, `studio32_shadow`               | 셋 다 native 종료 0. `verify FAILED: scan: startup module sitecustomize.py …` / `scan: startup file studio32_pthext.pth …` / `scan: top-level module packaging is also shipped by the bundle`. "starting the candidate for verification" 줄이 없다                                                              | 셋 다 폐기     |
| 5   | 열림      | `studio32_scriptext` 설치 뒤 `aelix_starter_ext` 설치                   | 새 세대에 `bin/studio32-aux`와 `share/studio32/info.txt`가 있다. 첫 줄 `#!<새 세대>/venv/bin/python`. 실행 결과 `studio32-scriptext console script ran`. 1차 스크립트로 같은 순서를 돌리면 둘 다 `No such file or directory`였다(import는 성공)                                                                 | g3, g4         |
| 6   | 열림      | 두 프로세스가 1초 간격으로 서로 다른 wheel을 설치                       | 둘째: `waited 8.0s for the mutation lock`, `prepared candidate g6 from g5`. 두 확장 모두 로드. revision 5 → 6                                                                                                                                                                                                   | g5, g6         |
| 7   | —         | `generation.json` 없는 `g99` 디렉터리를 만들고 `current.json`을 잘라 냄 | `pointer unusable; recovered from current.prev -> g5`(직전 포인터). 포인터를 되살린 뒤 다음 설치에서 `recovery: removed uncommitted candidate g99`                                                                                                                                                              | —              |
| 8   | 열림      | 한 프로세스가 현재 세대에 lease를 잡은 동안 설치·제거 뒤 정리           | `gc: removed g1` … `gc: kept g7 (in use by a running launcher)`. lease 프로세스가 끝난 뒤 `gc: removed g7`                                                                                                                                                                                                      | —              |
| 9   | 열림      | 번들을 새 경로에 놓고 옛 번들을 지움                                    | launcher 판단: 쓸 수 있는 세대 없음, 번들만으로 `No extensions installed`. 옮기기: `prepared candidate g10 from g9: 75 recorded files copied`, 검증 통과. 옛 g9의 `bin/python3`과 `pyvenv.cfg`는 지워진 번들을 가리킨 채 그대로                                                                                 | g10            |
| 10  | 열림      | 위 상태에서 되돌리기                                                    | `g9 is bound to another bundle; adopting its content into a new candidate`, 검증 통과                                                                                                                                                                                                                           | g11            |
| 11  | 전부 차단 | 번들 사본에 `tabulate`를 넣고 lock 해시를 바꾼 "새 번들"로 옮기기       | `adopted content does not fit the new bundle: scan: distribution tabulate 0.10.0 is also shipped by the bundle`. 빈 후보에 기록 7건을 보관소 wheel로 다시 설치, 검증 통과. 새 세대에 `tabulate`가 없다                                                                                                          | g12            |
| 12  | 전부 차단 | 반대로 `tabulate`가 없는 번들로 옮기기                                  | `adopted content does not fit the new bundle: load error studio32_depext:setup: No module named 'tabulate'`. 다시 설치(보관소의 `tabulate` wheel 사용), 검증 통과                                                                                                                                               | g14            |
| 13  | —         | 전체가 끝난 뒤 worker의 agent dir(`$HOME/.aelix/agent`)                 | native가 만든 `auth.json` 하나가 있었다. 로드 검사를 대화와 같은 agent dir로 실행했기 때문이다. 로드 검사에 후보의 `agent/`를 주도록 고쳐 다시 설치하니 `$HOME/.aelix`가 만들어지지 않았고 `auth.json`은 세대의 `agent/`에 생겼다. 설치 기록은 처음부터 세대의 `agent/`에만 있었다. 세대 5개 63MB, 보관소 148KB | —              |

파일 반입이 아닌 출처도 고친 절차로 한 번씩 실행했다(새 root, 내부 index는 loopback).

| #   | 네트워크   | 실행                                                                                                 | 관찰                                                                                                                  | 결과   |
| --- | ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------ |
| 14  | loopback만 | 이름으로 설치: `studio32-depext`, `aelix-starter-ext` (`--index-url http://127.0.0.1:18732/simple/`) | `Looking in indexes: …`, 설치 0, `loaded with -e: ["aelix_starter:setup", "studio32_depext:setup"]`                   | g1, g2 |
| 15  | loopback만 | index에 0.2.0을 올린 뒤 `update aelix-starter-ext`                                                   | `Successfully installed aelix-starter-ext-0.2.0`, 검증 통과                                                           | g3     |
| 16  | loopback만 | index에 0.3.0(import 안 됨)을 올린 뒤 `update aelix-starter-ext`                                     | native 종료 0, `verify FAILED: load error aelix_starter:setup: No module named 'studio32_module_that_does_not_exist'` | 폐기   |
| 17  | 열림       | `remove aelix-starter`, 이어서 `install git+file://<starter git 저장소>`                             | 제거 뒤 검증 통과. git: `Resolved … to commit 71afc5d2…`, `Building wheel …`, 검증 통과                               | g4, g5 |
| 18  | —          | 되돌리기                                                                                             | `ROLLED BACK current -> g4 (was g5)`. 대화 형태의 `resources/list`에 `studio32_depext:setup`만 있다                   | g4     |

## 8. 3차 실험 (둘째 리뷰 반영)

추가로 만든 wheel: `studio32-noendpoint`(`aelix.extensions` entry point 없음), `studio32-compactref`
(`Requires-Dist: studio32_dep@git+ssh://example.invalid/studio32-dep.git`, 공백 없음), `studio32-setupconnect`
(`setup()`이 `http://127.0.0.1:18741/setup-was-here`를 요청), `studio32-chatwrite`.

### 8.1 대화창 설치와 pip 환경 변수

번들 사본을 하나 더 만들어 그 Python으로 세대를 만들었다(`aelix-starter-ext 0.1.0`). 실행은 7.4의 `HYB`와
같고 `--extension aelix_starter:setup`을 줬다. prompt는 `/extension install <wheel>`이고 승인 요청에 허용으로
답했다.

| 어댑터의 환경                     | 관찰                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pip 변수 없음                     | `-33002 Aelix extension manager failed`. 세대와 번들 사본 그대로                                                                                                                    |
| `PIP_TARGET=<세대 site-packages>` | 응답은 `-33002`였지만 세대에 `studio32_chatwrite-0.1.0.dist-info`가 생겼다. 번들 사본은 그대로                                                                                      |
| `PIP_BREAK_SYSTEM_PACKAGES=1`     | `"exitCode": 0`, `Successfully installed studio32-noendpoint-0.1.0`. **번들 사본에 파일 8개가 추가됐다**(`python/lib/python3.12/site-packages/studio32_noendpoint…`). 세대는 그대로 |

### 8.2 2차 절차에 남아 있던 빈틈

2차 스크립트(7.6의 절차)를 그대로 실행했다.

| 실행                                                                            | 관찰                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `studio32_noendpoint` 반입                                                      | native 종료 0, `verify passed: {"studio32-noendpoint": "0.1.0"} \| loaded with -e: []`, `SWITCHED current -> g1`                                                                        |
| `studio32_compactref` 반입                                                      | 정적 검사를 통과했다(`1 wheel(s) checked and copied`). pip: `Failed to build 'studio32_dep' when git clone --filter=blob:none --quiet ssh://example.invalid/studio32-dep.git …`, 종료 1 |
| `studio32_setupconnect` 반입, 요청을 기록하는 서버를 `127.0.0.1:18741`에 띄움   | 로드 검증 중 서버 기록: `/setup-was-here`. (서버가 404를 돌려줘 `setup()`이 실패했고 후보는 폐기됐다)                                                                                   |
| helper 환경에 `AELIX_SETTINGS_PATH=<밖의 파일>`을 두고 `aelix_starter_ext` 반입 | 종료 0, 전환됨. 밖의 파일에 `{"extensionSources": [{"spec": "<보관소>/…/aelix_starter_ext-0.1.0…"}]}`가 쓰였다. 후보의 `agent/`에는 `settings.json`이 없다                              |

### 8.3 고친 뒤

스크립트를 세 군데 고쳤다. 띄우는 프로세스의 환경을 허용 목록으로 만든다. 정적 검사가 `METADATA` 헤더를
읽고 `Requires-Dist`를 직접 참조 형태(`이름 [extras] @ …`, 공백은 없어도 됨)로 해석한다. 설치 전후의
배포판과 확장 entry point를 비교하는 대조를 넣고 기대 확장 집합을 필수로 했다.

| 실행                                                                                                | 관찰                                                                                                                                                                                                          | 결과               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `studio32_noendpoint` 반입                                                                          | native 종료 0, `gate FAILED: the requested package provides no aelix.extensions entry point`                                                                                                                  | 폐기               |
| `studio32_compactref` 반입                                                                          | `REFUSED before any installer ran: … direct-reference dependency studio32_dep@git+ssh://example.invalid/studio32-dep.git` 종료 7                                                                              | 후보를 만들지 않음 |
| helper 환경에 `AELIX_SETTINGS_PATH`와 `AELIX_AUTH_PATH`를 밖의 파일로 두고 `aelix_starter_ext` 반입 | `gate passed: request ["aelix-starter-ext", "0.1.0"], expected extensions ["aelix-starter"]`, 검증 통과. 밖의 디렉터리는 비어 있고 세대의 `agent/`에 `auth.json`·`extension_pins.json`·`settings.json`이 있다 | g1                 |
| `studio32_depext` 반입(같은 폴더에 `tabulate`)                                                      | `expected extensions ["aelix-starter", "studio32-depext"]`, 검증 통과                                                                                                                                         | g2                 |
| `update aelix-starter-ext`(새 버전 없음)                                                            | native 종료 0, `DISCARDED candidate g3: nothing changed` 종료 9                                                                                                                                               | 전환하지 않음      |
| `remove aelix-starter`                                                                              | `gate passed: request ["aelix-starter-ext", null], expected extensions ["studio32-depext"]`, 검증 통과                                                                                                        | g3                 |
| `remove studio32-depext`(마지막 확장)                                                               | `expected extensions []`, `loaded with -e: []`, 검증 통과. 세대에 `tabulate`만 남는다                                                                                                                         | g4                 |
| `studio32_setupconnect` 반입, 서버를 띄움                                                           | 대조 통과, 로드 검증 중 서버 기록 `/setup-was-here`. 고친 뒤에도 요청은 나간다                                                                                                                                | 폐기(404로 실패)   |

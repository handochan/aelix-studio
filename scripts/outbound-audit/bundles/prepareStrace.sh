#!/usr/bin/env bash
# Build the same pinned, unmodified tracer for app-wide and host/native CI.
set -euo pipefail
strace_version=7.3
strace_digest=529634c40910895a9a1f3c5c1e65da2ca9ed72fb158dfc4bcc89efdf05e39b72
strace_output=$(realpath -m "${1:-.local/strace-toolchain}")
mkdir -p "$strace_output"
strace_archive="${2:-$strace_output/strace-$strace_version.tar.xz}"
if [ ! -f "$strace_archive" ]; then
  curl --fail --location --retry 3 --output "$strace_archive" "https://github.com/strace/strace/releases/download/v$strace_version/strace-$strace_version.tar.xz"
fi
printf '%s  %s\n' "$strace_digest" "$strace_archive" | sha256sum --check --status
strace_build=$(mktemp -d "$strace_output/build.XXXXXX")
trap 'rm -rf -- "$strace_build"' EXIT
tar -xf "$strace_archive" -C "$strace_build"
(
  cd "$strace_build/strace-$strace_version"
  # Match distro decoder support, including x86 compat ABIs when available. No
  # tracing filter/optimization is enabled; unsupported decoding fails closed.
  ./configure --prefix="$strace_output" --enable-mpers=check --disable-dependency-tracking --without-libunwind --without-libdw
  make -j4
  make install
) > "$strace_output/build.log" 2>&1
strace_actual=$("$strace_output/bin/strace" --version)
if [ "$(uname -m)" = x86_64 ]; then
  [[ "$strace_actual" == *" m32-mpers"* && "$strace_actual" == *" mx32-mpers"* ]]
fi
[[ "$strace_actual" == "strace -- version $strace_version"* ]]
python3 - "$strace_output" "$strace_version" "$strace_digest" <<'PY'
import hashlib,json,platform,subprocess,sys
from pathlib import Path
root=Path(sys.argv[1]);binary=root/'bin/strace'
report={'schema':'aelix.audit-toolchain/1','straceVersion':sys.argv[2],
        'source':'https://github.com/strace/strace/releases/tag/v'+sys.argv[2],
        'sourceSha256':sys.argv[3],'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
        'optionalFeatures':subprocess.check_output([str(binary),'--version'],text=True).split('Optional features enabled:',1)[-1].strip(),
        'machine':platform.machine(),'compiler':subprocess.check_output(['cc','--version'],text=True).splitlines()[0],
        'configure':['--enable-mpers=check','--disable-dependency-tracking','--without-libunwind','--without-libdw']}
(root/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
PY
printf 'Prepared strace %s with verified source %s\n' "$strace_version" "$strace_digest"

# Configuration persistence race

This manual probe uses the actual JSON store, window bounds persistence and quit
cleanup with a hidden Electron window and a synthetic one-second backend stop.
It does not run automatically in CI. It is not a full installed-app scenario.

With Bun and Electron available, from the repository root:

```sh
node tests/manual/configPersist.mjs --baseline bf8193b20 --runs 40
```

The baseline store and lifecycle modules come from the specified Git commit; the
fixed bundle uses the current checkout. Each independent cycle seeds a synthetic
false preference, requests normal app quit and checks the file after OS exit
using the same assertion as the installed smoke. `results.json` records file
size, digest, parse status and the boolean preference, never arbitrary values.

For an isolated Linux container, prepare on the host with `--prepare-only`, then
run with `--execute-only --electron <container-electron-binary>` and the same
`--output`. Mount only this checkout and its owned output, disable networking,
use an isolated HOME and give Python children `PYTHONDONTWRITEBYTECODE=1` and a
scratch `PYTHONPYCACHEPREFIX`. Use Xvfb. The optional `--no-sandbox` flag is only
for the minimal fixture in a disposable network-disabled container whose
standalone Electron lacks a configured sandbox helper; installed validation
keeps its normal sandbox and flags.

The runner fails if the baseline does not reproduce any empty file, an Electron
process exits unsuccessfully, or the fixed code fails any preservation check.
Keep the output as evidence and remove generated bundles when no longer needed.

`recoveredProfile.mjs` exports the separate installed-startup check used by
`host-release/probes/smoke.mjs`. It launches the real installed executable with an owned
0-byte config, without pre-seeding false. It verifies a visible window, effective
autoCheck false before and after the normal startup delay, preservation of the
0-byte original, and false after OS exit. It does not intercept native dialogs.
The app's normal quit path cancels an open recovery notice. Existing installed
outbound capture includes the probe; its `recoveryProfile` result is uploaded in
`renderer-result.json`. This adds one startup, not the repeated race loop, to CI.

## Aelix first-turn compaction

Build `aelix-studio-host` from the clean host feature-branch checkout with
`cargo build --locked -p aionui-app --bin aelix-studio-host`. Run the probe
from Studio with a clean ACP branch checkout and the prepared native runtime
for the Studio pin.

```sh
python3 tests/manual/aelixCompactBeforeRules.py \
  --host /path/to/host-checkout/target/debug/aelix-studio-host \
  --host-source /path/to/host-checkout \
  --runtime /path/to/prepared-studio-runtime \
  --acp-source /path/to/acp-checkout
```

The fixture starts the source-built host, ACP and native with disposable state
and a loopback provider. It checks that the first leading `/compact` enters
compaction, the next ordinary prompt receives the pending rules exactly once
even across runtime restarts, and a pasted rules block followed by a `/compact`
example reaches the provider as ordinary text. The receipt records the provided
host checkout SHA and the executable digest as independent inputs, alongside
the ACP SHA and native pin. For commit-specific qualification, keep a separate
build record linking the clean source commit to the executable digest.

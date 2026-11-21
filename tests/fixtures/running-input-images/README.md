# Running input image acceptance

Build the renderer with `bun run package`. Generate deterministic synthetic
fixtures outside the repository. On macOS, include the system Display P3 ICC
profile for the color conversion checks.

```sh
uv run --script tests/fixtures/running-input-images/generate.py /tmp/studio-images \
  --p3 '/System/Library/ColorSync/Profiles/Display P3.icc'
```

Use the unpacked production Electron build or start the real WebUI static
server with an isolated data directory. The probe creates a synthetic
conversation, verifies the bytes returned by the ordinary stream API with
Node SHA-256, and exercises the grant/ACP boundary with fixture data.

```sh
node tests/fixtures/running-input-images/probe.mjs electron \
  'out/mac-arm64/Aelix Studio.app/Contents/MacOS/Aelix Studio' /tmp/studio-images

NODE_ENV=production bun scripts/webui.ts --remote --port 45104 \
  --data-dir /tmp/studio-image-webui --no-open
node tests/fixtures/running-input-images/probe.mjs chrome \
  'http://LAN-IP:45104/' /tmp/studio-images
```

Set `IMAGE_PROBE_USER` and `IMAGE_PROBE_PASSWORD` to the isolated WebUI account.
For the LAN run, use the machine's actual LAN address without a browser secure
origin exception. `IMAGE_PROBE_RSS=1` reports sampled Chromium renderer RSS.
The sample includes the application, worker, upload and fixture readback.
`IMAGE_PROBE_THROTTLE=1` adds a Chromium download-plus-upload case at 200 KiB/s.

To verify stable Safari and Firefox, open the loopback fixture in the installed
browsers. The fixture checks all eight EXIF orientations and the Display P3
alpha sample using the production worker. It substitutes only the temporary
upload/stream backend. The same fixture checks the worker under a sandboxed
Electron custom origin with a same-origin worker CSP.

```sh
node tests/fixtures/running-input-images/browserMatrix.mjs /tmp/studio-images
node_modules/.bin/electron tests/fixtures/running-input-images/electronProtocol.cjs \
  http://127.0.0.1:45105/
```

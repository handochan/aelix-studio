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

The live mixed batch preserves existing upload, Local and Project references
alongside a one-time derivative upload. The Chrome LAN probe holds the actual
Host response after the file is stored, cancels twelve queued 16 MiB Blobs and
checks that none are still reachable before unblocking the active operation.
It then exercises an aborted late reply and a lost response. Both leave the
stored file in the pinned Host's `temp_dir()/aionui/<conversation-id>` scope.
The Host multipart route has a 30 MiB request limit. S-1a limits each output
to 3,750,000 B and a submission to 6 MiB, while Host/OS temp storage owns any
file retained after a completed upload. The probe removes its per-conversation
fixture uploads after checking retention.

The corrupt-IDAT fixture carries valid PNG chunk CRCs and invalid zlib bytes.
The 8000×8000 pass-through cases with and without final IDAT padding also run
with bitmap creation disabled in the Chrome worker. The browser matrix includes
Adam7 and the CMYK derivative.

The portable screenshot fixtures use generated RGBA pixels. The Windows samples
mirror the chunk layout of Microsoft's published 520×253 Snipping Tool image.
They cover the original layout, sixteen zero bytes in the final IDAT, and
nonzero padding followed by a valid text chunk. The macOS-style sample uses 2×
dimensions, 144 DPI, and the supplied Display P3 ICC profile. The worker
validates the exact zlib frame and passes the original PNG bytes through.
[Microsoft sample](https://support.microsoft.com/en-us/windows/media/snipping-tool-opened-png.png)
· [PNG IDAT](https://www.w3.org/TR/png-3/#11IDAT)
· [Compression Standard](https://compression.spec.whatwg.org/#supported-formats)

## S-1b running-input core

Use the H-1 Host binary, the A-1 adapter source and the unchanged pinned native
runtime. The Bun probe runs Studio's renderer client and dedicated worker
against the protected Host listener, real ACP and a loopback model endpoint.

```sh
bun tests/fixtures/running-input-images/realHost.ts \
  /path/to/aelix-studio-host /path/to/aelix-acp/src \
  /path/to/adapter/bin/python /path/to/native/bin/aelix
```

The fixture qualifies only its synthetic endpoint. It counts native image
write edges, compares grant and provider digests, checks exact native JSONL
sizes and exercises lost responses, lookup, turn change and late ACK after
Stop. It records sizes and counts at the native edge and checks that the
Host's diagnostic output omits private image fixture markers.

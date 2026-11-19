# Desktop JSON persistence

All stores created by `createJsonFileStore` retain the legacy
`base64(encodeURIComponent(JSON))` format. This covers `aionui-config.txt`,
`.aionui-env`, `aionui-chat.txt`, `aionui-chat-message.txt`, and per-conversation
files in `aionui-chat-history/`.

Each write uses a private temporary file in the destination directory, writes
and fsyncs it, closes it, then renames it over the destination. POSIX also fsyncs
the parent directory. Node's rename supports replacing existing Windows files;
the implementation never deletes the destination to work around a failed
rename. On Windows only, EPERM/EACCES/EBUSY get up to four attempts with
25/50/100ms backoff. Other errors are not retried. Exhaustion rejects the write
and retains the old destination. Windows directory fsync is not provided by this API.

One `.bak` file stores validated recovery data. The first replacement protects
the loaded valid data before committing the new primary. After primary commit,
the backup is synchronized to that latest value. Subsequent writes skip a
redundant backup write when its known content already matches. Keeping the
latest successful value matters for an update preference changed from ON to
OFF: recovery must not silently revert that change. A post-commit backup error
is logged as “primary saved, recovery refresh failed” and still rejects the
operation. The committed primary remains readable.

A missing primary means a new store, even when a stale `.bak` exists. The first
save overwrites that backup with the new values. Empty, invalidly encoded,
malformed, null or scalar JSON in an existing primary is corruption. Preserve
the original bytes under a unique `.corrupt-<timestamp>-<uuid>` name before
atomically replacing the primary; there is no missing-primary interval that
could be confused with a manual reset. Valid backups are restored synchronously.
Without one, env/chat/chatMessage start with `{}`, and per-conversation history
starts with `[]`. Invalid backups are preserved as well. Read/preservation I/O
errors retain the files and report failure rather than overwriting unknown data.
Diagnostics log the preserved location, never setting values. `clear`/`setJson`
work after recovery. Conversation archival still removes its recovery copy and
resets the store cache.

Unrecoverable config or env activates a `.recovery.json` marker in the stable
profile config directory before resetting. Env recovery also needs this guard:
losing a custom cacheDir must not silently enable checks in another config.
Config starts with `update.autoCheck: false`; the marker additionally suppresses
checks through clear/setJson/restarts, independently of the stored value. Only
an explicitly saved update preference from Settings removes the marker, after
the preference write succeeds. Healthy fresh profiles retain default-on checks.

The existing native warning dialog reports the reset in all configured locales.
Acknowledging it suppresses repeated notices without removing update protection.
Quit cancels an open notice and leaves it pending for the next launch. Quarantined
files are intentionally retained for manual recovery.

Every queued write, archive and asynchronous update is tracked until complete.
The quit barrier runs at `will-quit`, after window close has added its final
bounds write, and drains writes added while an earlier batch is settling. After
five seconds it logs the timeout and allows quit, including reentrant events.
Backend cleanup remains at `before-quit`. Forced process termination cannot run
the barrier; atomic replacement still avoids truncating the existing primary.
This is not a claim of power-loss durability on every filesystem.

Loads clean only exact owned PID/UUID temp patterns (including unfinished
quarantine copies). Dead owners are removed; inactive self files older than
24 hours can also be removed. Live foreign owners are preserved regardless of
age, and active self writes are protected.

Installed smoke first starts a separate 0-byte profile and checks its visible
window, effective update preference, preserved original and post-exit setting.
The existing whole-app audit includes this launch. `recoveryProfile` is recorded
in `renderer-result.json`. The ordinary permission scenario still seeds false
once, checks it before every
launch and after every OS exit, including the final exit, and fails on loss.
File size, digest, parse status, key count and the boolean preference are
retained in the already-uploaded `renderer-result.json`; arbitrary setting
values are not exported. Playwright's `DEBUG` remains on the driver only.
Neither the healthy-profile update default nor outbound audit policy changes.

See [the manual probe](../../tests/manual/README.md) for the baseline/fixed
Electron comparison. Unit tests cover actual file replacement, damaged files,
recovery, failed fsync/rename and shutdown ordering. Installed target validation
provides normal Windows replacement evidence; real antivirus sharing locks and
abrupt power loss require separate fault injection.

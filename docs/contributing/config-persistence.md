# Desktop JSON persistence

All stores created by `createJsonFileStore` retain the legacy
`base64(encodeURIComponent(JSON))` format. This covers `aionui-config.txt`,
`.aionui-env`, `aionui-chat.txt`, `aionui-chat-message.txt`, and per-conversation
files in `aionui-chat-history/`.

Each write uses a private temporary file in the destination directory, writes
and fsyncs it, closes it, then renames it over the destination. POSIX also fsyncs
the parent directory. Node's rename supports replacing existing Windows files;
the implementation never deletes the destination to work around a failed
rename. A sharing/permission failure rejects the write and retains the old
destination. Windows directory fsync is not provided by this API.

One `.bak` file stores validated recovery data. The first replacement protects
the loaded valid data before committing the new primary. After primary commit,
the backup is synchronized to that latest value. Subsequent writes skip a
redundant backup write when its known content already matches. Keeping the
latest successful value matters for an update preference changed from ON to
OFF: recovery must not silently revert that change. A post-commit backup error
is logged as “primary saved, recovery refresh failed” and still rejects the
operation. The committed primary remains readable.

Only missing primary **and** missing backup mean a new profile. Empty, invalidly
encoded, malformed, null or scalar JSON is corruption. A valid backup can be
loaded in memory with a warning; the original primary is retained until the
next explicit save. Without a valid backup, reads and mutations reject and
retain both files. Permission/device errors reject directly. Diagnostics do
not print stored values. An explicit `clear` or `setJson` does not bypass this
integrity check. Conversation archival removes its recovery copy and resets the
store cache so a later lookup cannot resurrect archived data.

Every queued write, archive and asynchronous update is tracked until complete.
The quit barrier runs at `will-quit`, after window close has added its final
bounds write, and drains writes added while an earlier batch is settling.
Backend cleanup remains at `before-quit`. Forced process termination cannot run
the barrier; atomic replacement still avoids truncating the existing primary.
This is not a claim of power-loss durability on every filesystem.

Installed smoke seeds `update.autoCheck: false` once, checks it before every
launch and after every OS exit, including the final exit, and fails on loss.
File size, digest, parse status, key count and the boolean preference are
retained in the already-uploaded `renderer-result.json`; arbitrary setting
values are not exported. Playwright's `DEBUG` remains on the driver only.
Neither the update default nor outbound audit policy changes.

See [the manual probe](../../tests/manual/README.md) for the baseline/fixed
Electron comparison. Unit tests cover actual file replacement, damaged files,
recovery, failed fsync/rename and shutdown ordering. Installed target validation
provides normal Windows replacement evidence; real antivirus sharing locks and
abrupt power loss require separate fault injection.

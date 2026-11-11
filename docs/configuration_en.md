# Configuration

**[中文](configuration.md) | English**

The plugin is configured through environment variables of the Hydro process. Restart Hydro after changing them; with pm2, run `pm2 restart hydrooj --update-env && pm2 save` so the new values take effect and survive a reboot.

## Encryption key

`ENCRYPTION_KEY`: encrypts the API keys stored in the database. At least 16 characters.

- If it is not set, the plugin falls back to a built-in default key and logs a warning. Always set it on a real server.
- To generate a random key: `openssl rand -base64 24`.

**Changing the key**: editing `ENCRYPTION_KEY` directly makes stored API keys unreadable. Rotate it like this:

1. Set the current key as `OLD_ENCRYPTION_KEY` and the new one as `ENCRYPTION_KEY`, then restart Hydro.
2. On startup the plugin re-encrypts every API key with the new key and logs `Key rotation: re-encrypted ...`.
3. Remove `OLD_ENCRYPTION_KEY` and restart once more.

## Optional environment variables

`AI_HELPER_UPDATE_CHANNEL`: the channel used by the one-click update on the "AI Config" page.

- `stable` (default): only updates to published releases (`vX.Y.Z` tags) and verifies their GPG signatures. Every production server should use this channel.
- `edge`: follows the latest `main` branch. Only for the maintainer's own test servers.

`AI_HELPER_JAILBREAK_LOG_RETENTION_DAYS`: how long blocked-request logs are kept.

- Default `180` days, range `7`–`3650`.
- New logs count from when they are created. Older logs expire gradually from the upgrade time instead of being deleted at deployment.

`AI_HELPER_TESTDATA_GENERATION_MODE`: whether test data generation must use the judge sandbox (`hydrojudge.sandbox_host`).

- `auto` (default): run and verify in the sandbox when it is reachable; otherwise fall back to direct output, clearly marked as unverified.
- `sandbox`: require the sandbox and stop if it is unavailable.
- `direct`: always use direct output. Not recommended.

`AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS`: the longest a single model call may take during test data generation.

- Default `300` seconds, range `30`–`1800`. Invalid values fall back to the default.
- It only stops a stuck call; it does not reduce model output length, reasoning effort or verification steps.

`AI_HELPER_TESTDATA_MUTATION_CONCURRENCY`: how many mutation tests run in the sandbox at once.

- Default `2`, range `1`–`4`. Invalid values fall back to the default.
- Results are still recorded in the original order. A candidate's first timeout under concurrency is re-run on its own, so brief congestion is not counted as the test data catching it.

## Disabling telemetry

By default the plugin reports anonymous statistics (installs, active users, conversation count, feature usage and version). Reports contain no code, conversation content or personal data. To turn it off, run this in the MongoDB database Hydro uses:

```javascript
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```

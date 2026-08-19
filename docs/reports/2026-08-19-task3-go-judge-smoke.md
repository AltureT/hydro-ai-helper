# Task 3 real go-judge smoke evidence — 2026-08-19

## Verdict and evaluated revision

- Verdict: **PASS** for the post-fix run described below.
- Evaluated branch: `codex/task3-hard-template-checker-verification`.
- Evaluated SHA: `5545328605151f90d90fadbb3294714cd584a8a4`.
- This evidence report is committed after the evaluated code SHA, so the report commit itself follows that revision.
- Endpoint class: local loopback HTTP endpoint with no credentials (`http://127.0.0.1:5050`).
- Adapter: built `dist/services/goJudgeSandboxService.js`; no mocked HTTP client.

## Environment

The version endpoint and `GoJudgeSandboxRunner.isAvailable()` both succeeded with proxy use disabled.

| Component | Observed value |
|---|---|
| go-judge | `v1.12.2` |
| go-judge build Go | `go1.26.5` |
| go-judge API OS/platform | `linux` / `arm64` |
| container kernel | `Linux 6.12.54-linuxkit aarch64` |
| Python | `Python 3.13.5` |
| C++ compiler | `g++ (Debian 14.2.0-19) 14.2.0` |
| Java compiler | `javac 21.0.12` |
| Java archive tool | `jar 21.0.12` |

Environment command (EXIT 0):

```text
docker exec hydro-ai-helper-task3-go-judge /bin/sh -lc 'uname -srm; python3 --version; g++ --version | head -n 1; javac -version; jar --version'
```

## Commands before smoke

Focused regression bundle, run during the initial Task 7 attempt (EXIT 0):

```text
npx jest src/__tests__/services/goJudgeSandboxService.test.ts src/__tests__/services/testdataTemplateVerifier.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/models/testdataGenerationJob.test.ts src/__tests__/frontend/testdataVerificationSummaryView.test.ts --runInBand
```

Observed result: 7/7 suites passed, 437/437 tests passed, 0 snapshots, 2.79 seconds. This focused run preceded the Java process-limit repair; the complete Jest gate below evaluates the final SHA.

The adapter was rebuilt immediately before the final recorded smoke (EXIT 0):

```text
npm run build:plugin
```

Final smoke command (EXIT 0):

```text
TESTDATA_GO_JUDGE_URL=http://127.0.0.1:5050 node /private/tmp/hydro-ai-helper-task3-go-judge-smoke.js
```

The temporary script was outside the repository and imported the built adapter by absolute path.

## Deadline and total timing

- Start epoch: `1787149992846` ms.
- Start ISO: `2026-08-19T14:33:12.846Z`.
- Absolute deadline epoch: `1787150112846` ms.
- Absolute deadline ISO: `2026-08-19T14:35:12.846Z`.
- Initial absolute-deadline budget: `120000` ms.
- Total wall time: `940` ms.

Every compile and execution request in the final smoke used that one absolute deadline.

## Language summary

| Language | Compile/prepare kind | compiled | executed | passed/total | Wall time |
|---|---:|---:|---:|---:|---:|
| Python (`solution + template.py`) | `interpreted-prepare` | true | 4 | 4/4 | 35 ms |
| C++ (`template.cc + foo.cc`) | `success` | true | 4 | 4/4 | 578 ms |
| Java (`Main.java + Solution.java`) | `success` | true | 4 | 4/4 | 315 ms |

## Per-case results

All output comparisons used normalized line endings and surrounding-whitespace trimming.

| Language | Input | Expected | Normalized output | Raw status | Exit status | accepted | Output matched |
|---|---:|---:|---:|---|---:|---:|---:|
| Python | `1 2` | `3` | `3` | `Accepted` | 0 | true | true |
| Python | `10 20` | `30` | `30` | `Accepted` | 0 | true | true |
| Python | `1000 2000` | `3000` | `3000` | `Accepted` | 0 | true | true |
| Python | `1000000 2000000` | `3000000` | `3000000` | `Accepted` | 0 | true | true |
| C++ | `1 2` | `3` | `3` | `Accepted` | 0 | true | true |
| C++ | `10 20` | `30` | `30` | `Accepted` | 0 | true | true |
| C++ | `1000 2000` | `3000` | `3000` | `Accepted` | 0 | true | true |
| C++ | `1000000 2000000` | `3000000` | `3000000` | `Accepted` | 0 | true | true |
| Java | `1 2` | `3` | `3` | `Accepted` | 0 | true | true |
| Java | `10 20` | `30` | `30` | `Accepted` | 0 | true | true |
| Java | `1000 2000` | `3000` | `3000` | `Accepted` | 0 | true | true |
| Java | `1000000 2000000` | `3000000` | `3000000` | `Accepted` | 0 | true | true |

## Cached-artifact cleanup

Raw go-judge cache IDs were neither printed nor committed. The report records only SHA-256-derived prefixes:

| Language | Redacted token | Delete attempted | Post-delete runner result | Confirmed unusable |
|---|---|---:|---|---:|
| C++ | `sha256:dd9178e3125d` | true | HTTP 500 from go-judge because the cached file no longer existed | true |
| Java | `sha256:8fd13b52be50` | true | HTTP 500 from go-judge because the cached file no longer existed | true |

The smoke also retained `finally` cleanup for any cached artifact if an earlier step failed.

## Complete gates at the evaluated SHA

The required gates ran in this exact order immediately before the final smoke rerun:

| Order | Command | Observed result | EXIT |
|---:|---|---|---:|
| 1 | `npm run gen:locale` | generated `frontend/generated/localeFallback.ts`; zh 1169 keys, en 1169 keys | 0 |
| 2 | `npm test -- --runInBand` | 70/70 suites, 1570/1570 tests, 0 snapshots, 2.992 seconds | 0 |
| 3 | `npm run lint` | zero reported warnings or errors | 0 |
| 4 | `npm run build:plugin` | TypeScript build completed | 0 |
| 5 | `git diff --check` | no whitespace errors | 0 |
| 6 | `git status --short` | only the intentional temporary untracked `node_modules` symlink was visible before this report update | 0 |

## Deviations and investigation history

1. The first Task 7 attempt found the prepared go-judge prefork namespace did not contain `/etc/java-21-openjdk`, leaving the JDK `java.security` symlink dangling. Java compilation returned `Nonzero Exit Status`, exit 1, with `java.lang.InternalError: Error loading java.security file`. The same named container was restarted without recreating, pulling, or installing anything; the refreshed prefork namespace then exposed the already-installed JDK and compilation succeeded.
2. That initial attempt then exposed a real adapter defect at SHA `8d105eb31b2684d867a69fa2301bc68f45bafdb7`: Java compilation succeeded, but runtime inherited `procLimit=16` and all four cases failed with native-thread `EAGAIN`. A same-JAR A/B probe held memory at 256 MiB: process limit 16 failed, while process limit 64 returned `Accepted`, exit 0, output `3`. The reviewed repair `2c61084e2cd22e0effc6493c41d01b7a76edb30c` raises only the Java runtime process limit to 64. The final verdict is based solely on the complete post-fix run above.
3. No test points or selected languages were removed during either investigation.

## UNVERIFIED

- This manual smoke did not import a complete package into a persistent Hydro problem; it directly exercised the real local go-judge through the built adapter, as scoped by Task 3.
- It did not manually exercise a custom checker, cancellation, or an expired deadline. Those contracts are covered by Jest, not claimed as manual smoke evidence here.
- No remote or production go-judge endpoint was exercised.

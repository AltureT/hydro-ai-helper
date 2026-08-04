import fs from 'fs';
import path from 'path';

const scriptPath = path.resolve(__dirname, '../../../scripts/verifyReleaseRef.js');
const COMMIT_SHA = 'a'.repeat(40);
const TAG_SHA = 'b'.repeat(40);
const env = {
  GITHUB_REF_NAME: 'v3.2.0',
  GITHUB_REPOSITORY: 'AltureT/hydro-ai-helper',
  GITHUB_TOKEN: 'test-token',
};

type VerificationOptions = {
  env: typeof env;
  execFile: (command: string, args: string[]) => string | undefined;
  fetchImpl: (url: string, options?: unknown) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
};

function loadVerifier(): { verifyReleaseRef: (options: VerificationOptions) => Promise<{ tagName: string; commitSha: string }> } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(scriptPath);
}

function createExecFile(mergeBaseError?: Error): VerificationOptions['execFile'] {
  return (command, args) => {
    expect(command).toBe('git');
    if (args[0] === 'rev-list') return `${COMMIT_SHA}\n`;
    if (args[0] === 'merge-base' && mergeBaseError) throw mergeBaseError;
    return undefined;
  };
}

function createFetch(overrides: {
  refType?: 'tag' | 'commit';
  commitVerified?: boolean;
  tagVerified?: boolean;
} = {}): VerificationOptions['fetchImpl'] {
  const {
    refType = 'tag',
    commitVerified = true,
    tagVerified = true,
  } = overrides;

  return async (url) => {
    if (url.endsWith('/git/ref/tags/v3.2.0')) {
      return { ok: true, json: async () => ({ object: { type: refType, sha: TAG_SHA } }) };
    }
    if (url.endsWith(`/git/tags/${TAG_SHA}`)) {
      return {
        ok: true,
        json: async () => ({
          object: { type: 'commit', sha: COMMIT_SHA },
          verification: { verified: tagVerified },
        }),
      };
    }
    if (url.endsWith(`/git/commits/${COMMIT_SHA}`)) {
      return { ok: true, json: async () => ({ verification: { verified: commitVerified } }) };
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
}

describe('verifyReleaseRef', () => {
  beforeAll(() => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('accepts an annotated tag whose verified commit is on origin/main', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({ env, execFile: createExecFile(), fetchImpl: createFetch() })).resolves.toEqual({
      tagName: 'v3.2.0',
      commitSha: COMMIT_SHA,
    });
  });

  test('rejects a commit outside origin/main', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({
      env,
      execFile: createExecFile(new Error('not an ancestor')),
      fetchImpl: createFetch(),
    })).rejects.toThrow('not an ancestor');
  });

  test('rejects a lightweight tag', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({ env, execFile: createExecFile(), fetchImpl: createFetch({ refType: 'commit' }) }))
      .rejects.toThrow('annotated');
  });

  test('rejects an unverified commit', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({ env, execFile: createExecFile(), fetchImpl: createFetch({ commitVerified: false }) }))
      .rejects.toThrow('commit');
  });

  test('rejects an unverified tag', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({ env, execFile: createExecFile(), fetchImpl: createFetch({ tagVerified: false }) }))
      .rejects.toThrow('tag');
  });
});

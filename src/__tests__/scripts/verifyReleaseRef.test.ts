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
    if (args[0] === 'fetch') expect(args).toEqual(['fetch', 'origin', 'main', '--no-tags']);
    if (args[0] === 'rev-list') {
      expect(args).toEqual(['rev-list', '-n', '1', 'v3.2.0']);
      return `${COMMIT_SHA}\n`;
    }
    if (args[0] === 'merge-base') {
      expect(args).toEqual(['merge-base', '--is-ancestor', COMMIT_SHA, 'origin/main']);
      if (mergeBaseError) throw mergeBaseError;
    }
    return undefined;
  };
}

function createFetch(overrides: {
  refType?: 'tag' | 'commit';
  commitVerified?: boolean;
  tagTargetSha?: string;
  tagVerified?: boolean;
} = {}): VerificationOptions['fetchImpl'] {
  const {
    refType = 'tag',
    commitVerified = true,
    tagTargetSha = COMMIT_SHA,
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
          object: { type: 'commit', sha: tagTargetSha },
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
    const execFile = jest.fn(createExecFile());

    await expect(verifyReleaseRef({ env, execFile, fetchImpl: createFetch() })).resolves.toEqual({
      tagName: 'v3.2.0',
      commitSha: COMMIT_SHA,
    });
    expect(execFile.mock.calls).toEqual([
      ['git', ['fetch', 'origin', 'main', '--no-tags']],
      ['git', ['rev-list', '-n', '1', 'v3.2.0']],
      ['git', ['merge-base', '--is-ancestor', COMMIT_SHA, 'origin/main']],
    ]);
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

  test('rejects an annotated tag object that targets a different commit', async () => {
    const { verifyReleaseRef } = loadVerifier();

    await expect(verifyReleaseRef({
      env,
      execFile: createExecFile(),
      fetchImpl: createFetch({ tagTargetSha: 'c'.repeat(40) }),
    })).rejects.toThrow(`does not directly reference ${COMMIT_SHA}`);
  });
});

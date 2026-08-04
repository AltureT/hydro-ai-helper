const { execFileSync } = require('child_process');

function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function fetchJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) throw new Error(`GitHub request failed (${response.status}): ${url}`);
  return response.json();
}

async function verifyReleaseRef(options = {}) {
  const env = options.env || process.env;
  const execFile = options.execFile || execFileSync;
  const fetchImpl = options.fetchImpl || fetch;
  const tagName = requireEnv(env, 'GITHUB_REF_NAME');
  const repository = requireEnv(env, 'GITHUB_REPOSITORY');
  const token = requireEnv(env, 'GITHUB_TOKEN');

  if (!/^v\d+\.\d+\.\d+$/.test(tagName)) {
    throw new Error(`Invalid release tag: ${tagName}`);
  }

  execFile('git', ['fetch', 'origin', 'main', '--no-tags']);
  const commitSha = String(execFile('git', ['rev-list', '-n', '1', tagName])).trim();
  execFile('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main']);

  const apiBase = `https://api.github.com/repos/${repository}`;
  const tagRef = await fetchJson(fetchImpl, `${apiBase}/git/ref/tags/${tagName}`, token);
  if (tagRef.object?.type !== 'tag') {
    throw new Error(`Release tag ${tagName} must be an annotated tag`);
  }

  const tagObject = await fetchJson(fetchImpl, `${apiBase}/git/tags/${tagRef.object.sha}`, token);
  if (tagObject.verification?.verified !== true) {
    throw new Error(`Release tag ${tagName} is not verified`);
  }
  if (tagObject.object?.type !== 'commit' || tagObject.object.sha !== commitSha) {
    throw new Error(`Release tag ${tagName} does not directly reference ${commitSha}`);
  }

  const commit = await fetchJson(fetchImpl, `${apiBase}/git/commits/${commitSha}`, token);
  if (commit.verification?.verified !== true) {
    throw new Error(`Release commit ${commitSha} is not verified`);
  }

  return { tagName, commitSha };
}

if (require.main === module) {
  verifyReleaseRef()
    .then(({ tagName, commitSha }) => console.log(`Verified release ${tagName} at ${commitSha}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { verifyReleaseRef };

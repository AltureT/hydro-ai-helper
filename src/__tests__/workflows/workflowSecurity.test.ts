import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

type WorkflowStep = {
  'continue-on-error'?: boolean;
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  'continue-on-error'?: boolean;
  env?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = { jobs?: Record<string, WorkflowJob> };

const workflowDirectory = path.resolve(__dirname, '../../../.github/workflows');
const githubDirectory = path.resolve(__dirname, '../../../.github');
const workflowFiles = [
  'ci.yml',
  'npm-publish.yml',
  'sync-releases-to-gitee.yml',
  'sync-to-gitee.yml',
];
const CHECKOUT_ACTION = 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';
const GITEE_HOST_KEY = 'gitee.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB/OvYN';
const DISPATCH_TAG_EXPRESSION = '${{ github.event.inputs.tag_name }}';

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowDirectory, name), 'utf8');
}

function readGitHubDocument(name: string): string {
  return fs.readFileSync(path.join(githubDirectory, name), 'utf8');
}

function parseWorkflow(source: string): Workflow {
  return yaml.load(source) as Workflow;
}

function getJob(workflow: Workflow, name: string): WorkflowJob {
  const job = workflow.jobs?.[name];
  if (!job) throw new Error(`Missing ${name} job`);
  return job;
}

function getSteps(job: WorkflowJob): WorkflowStep[] {
  if (!job.steps) throw new Error('Job has no steps');
  return job.steps;
}

function activeShellLines(run: string | undefined): string[] {
  return (run || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function commandIndex(steps: WorkflowStep[], command: string): number {
  return steps.findIndex((step) => step.run?.trim() === command);
}

function permitsFailure(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function expressionPaths(value: unknown, target: string, currentPath = ''): string[] {
  if (typeof value === 'string' && value.includes(target)) return [currentPath];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => expressionPaths(entry, target, `${currentPath}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => expressionPaths(
    entry,
    target,
    currentPath ? `${currentPath}.${key}` : key,
  ));
}

function releasePolicyViolations(workflow: Workflow): string[] {
  const job = getJob(workflow, 'publish');
  const steps = getSteps(job);
  const violations: string[] = [];
  const checkout = steps.find((step) => step.uses === CHECKOUT_ACTION);
  const verifierIndex = commandIndex(steps, 'node scripts/verifyReleaseRef.js');
  const lintIndex = commandIndex(steps, 'npm run lint');
  const testIndex = commandIndex(steps, 'npm test -- --runInBand --silent');
  const buildIndex = commandIndex(steps, 'npm run build:plugin');
  const publishIndex = commandIndex(steps, 'npm publish --provenance --access public');
  const verifier = steps[verifierIndex];
  const publish = steps[publishIndex];

  if (job.permissions?.['id-token'] !== 'write') violations.push('id-token permission must be write');
  if (permitsFailure(job['continue-on-error'])) violations.push('release job must not continue after failure');
  if (!checkout || checkout.with?.['fetch-depth'] !== 0) violations.push('checkout must fetch complete history');
  if (!verifier || verifier.env?.GITHUB_TOKEN !== '${{ secrets.GITHUB_TOKEN }}') {
    violations.push('release verifier must receive GITHUB_TOKEN');
  }
  if (!publish || publish.env?.NODE_AUTH_TOKEN !== '${{ secrets.NPM_TOKEN }}') {
    violations.push('provenance publish must retain NODE_AUTH_TOKEN');
  }
  if ([verifierIndex, lintIndex, testIndex, buildIndex, publishIndex].some((index) => index < 0)) {
    violations.push('release gate command is missing');
  } else if (![verifierIndex, lintIndex, testIndex, buildIndex].every((index) => index < publishIndex)) {
    violations.push('release gates must run before publish');
  }
  if ([verifier, steps[lintIndex], steps[testIndex], steps[buildIndex], publish].some(
    (step) => step && permitsFailure(step['continue-on-error']),
  )) {
    violations.push('release security gates must not continue after failure');
  }

  return violations;
}

function mirrorPolicyViolations(workflow: Workflow): string[] {
  const job = getJob(workflow, 'sync');
  const steps = getSteps(job);
  const commands = steps.flatMap((step) => activeShellLines(step.run));
  const strictHostKeyLines = commands.filter((line) => /^StrictHostKeyChecking\s+\S+$/.test(line));
  const tagPushLines = commands.filter((line) => line.startsWith('git push gitee --tags'));
  const disablesExitOnError = commands.some((line) => /^set\s+\+(?:e|o\s+errexit)(?:\s|$)/.test(line));
  const violations: string[] = [];

  if (permitsFailure(job['continue-on-error'])) violations.push('mirror job must not continue after failure');
  if (steps.some((step) => permitsFailure(step['continue-on-error']))) {
    violations.push('mirror steps must not continue after failure');
  }
  if (!commands.includes(`echo '${GITEE_HOST_KEY}' >> ~/.ssh/known_hosts`)) {
    violations.push('pinned Gitee host key is missing');
  }
  if (commands.some((line) => line.includes('ssh-keyscan'))) violations.push('dynamic host-key discovery is forbidden');
  if (!commands.includes('cat >> ~/.ssh/config << EOF')
    || strictHostKeyLines.length !== 1
    || strictHostKeyLines[0] !== 'StrictHostKeyChecking yes') {
    violations.push('SSH config must contain exactly one strict host-key setting');
  }
  if (tagPushLines.length !== 1 || tagPushLines[0] !== 'git push gitee --tags --force' || disablesExitOnError) {
    violations.push('tag push must propagate failures');
  }

  return violations;
}

function dispatchPolicyViolations(workflow: Workflow): string[] {
  const job = getJob(workflow, 'sync-release');
  const commands = getSteps(job).flatMap((step) => activeShellLines(step.run));
  const violations: string[] = [];

  if (job.env?.DISPATCH_TAG_NAME !== DISPATCH_TAG_EXPRESSION) {
    violations.push('dispatch tag must be assigned through job environment');
  }
  if (!commands.includes('TAG_NAME="$DISPATCH_TAG_NAME"')) {
    violations.push('dispatch tag must be expanded from DISPATCH_TAG_NAME');
  }
  if (expressionPaths(workflow, DISPATCH_TAG_EXPRESSION).join(',') !== 'jobs.sync-release.env.DISPATCH_TAG_NAME') {
    violations.push('dispatch tag expression must only appear in job environment');
  }

  return violations;
}

function legacyReleaseSubstringPolicy(source: string): boolean {
  return [
    'fetch-depth: 0',
    'node scripts/verifyReleaseRef.js',
    'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    'npm run lint',
    'npm test -- --runInBand --silent',
    'npm run build:plugin',
    'npm publish --provenance --access public',
    'id-token: write',
  ].every((required) => source.includes(required));
}

function legacyMirrorSubstringPolicy(source: string): boolean {
  return source.includes(GITEE_HOST_KEY)
    && source.includes('StrictHostKeyChecking yes')
    && !source.includes('ssh-keyscan')
    && !/git push gitee --tags --force\s*\|\|\s*true/.test(source);
}

describe('workflow security policy', () => {
  test('security policy documents supported 3.x releases and verified private reporting', () => {
    const securityPolicy = readGitHubDocument('SECURITY.md');

    expect(securityPolicy).toMatch(/^\| 3\.x\s+\|\s+:white_check_mark: \|$/m);
    expect(securityPolicy).not.toMatch(/^\| 1\.x\s+\|\s+:white_check_mark: \|$/m);
    expect(securityPolicy).toMatch(/^\| 2\.x and earlier\s+\|\s+:x: \|$/m);
    expect(securityPolicy).toContain('mailto:myalture@gmail.com');
    expect(securityPolicy).toContain('https://github.com/AltureT/hydro-ai-helper/security/advisories/new');
  });

  test('automation guide documents release security gates and trusted publishing', () => {
    const automationGuide = readGitHubDocument('AUTOMATION.md');

    expect(automationGuide).toContain('签名');
    expect(automationGuide).toContain('npm run lint');
    expect(automationGuide).toContain('npm test -- --runInBand --silent');
    expect(automationGuide).toContain('npm publish --provenance');
    expect(automationGuide).toContain('Trusted Publishing');
    expect(automationGuide).toContain('当前发布工作流使用 OIDC provenance，同时保留令牌认证');
    expect(automationGuide).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(automationGuide).toContain('Trusted Publishing 尚待 npm 包设置和一次受控发布确认');
  });

  test.each(workflowFiles)('%s pins every GitHub Action to an immutable SHA', (workflowFile) => {
    const usesLines = readWorkflow(workflowFile)
      .split('\n')
      .filter((line) => line.includes('uses:'));

    for (const line of usesLines) {
      expect(line).toMatch(/^\s*(?:-\s+)?uses:\s+[^\s@]+@[a-f0-9]{40}\s+# v\d+\s*$/);
    }
  });

  test('npm publishing executes trusted release gates before authenticated provenance publishing', () => {
    expect(releasePolicyViolations(parseWorkflow(readWorkflow('npm-publish.yml')))).toEqual([]);
  });

  test('Gitee mirror uses an active pinned SSH policy and a failure-propagating tag push', () => {
    expect(mirrorPolicyViolations(parseWorkflow(readWorkflow('sync-to-gitee.yml')))).toEqual([]);
  });

  test('release dispatch data appears only in job environment and shell variable expansion', () => {
    expect(dispatchPolicyViolations(parseWorkflow(readWorkflow('sync-releases-to-gitee.yml')))).toEqual([]);
  });

  test('adversarial workflow fixtures bypass legacy substring checks but fail parsed policy checks', () => {
    const misleadingRelease = `
jobs:
  publish:
    permissions:
      id-token: read # id-token: write
    steps:
      - uses: ${CHECKOUT_ACTION}
        with:
          fetch-depth: 1 # fetch-depth: 0
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
      - run: node scripts/verifyReleaseRef.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: npm run lint
      - run: npm test -- --runInBand --silent
      - run: npm run build:plugin
`;
    const conflictingMirror = `
jobs:
  sync:
    steps:
      - run: |
          echo '${GITEE_HOST_KEY}' >> ~/.ssh/known_hosts
          StrictHostKeyChecking yes
          StrictHostKeyChecking no
          git push gitee --tags --force || :
`;
    const interpolatedDispatch = `
jobs:
  sync-release:
    env:
      DISPATCH_TAG_NAME: \${{ github.event.inputs.tag_name }}
    steps:
      - run: |
          TAG_NAME="$DISPATCH_TAG_NAME"
          EXTRA="\${{ github.event.inputs.tag_name }}"
`;

    expect(legacyReleaseSubstringPolicy(misleadingRelease)).toBe(true);
    expect(releasePolicyViolations(parseWorkflow(misleadingRelease))).not.toEqual([]);
    expect(legacyMirrorSubstringPolicy(conflictingMirror)).toBe(true);
    expect(mirrorPolicyViolations(parseWorkflow(conflictingMirror))).not.toEqual([]);
    expect(interpolatedDispatch).not.toContain('TAG_NAME="${{ github.event.inputs.tag_name }}"');
    expect(dispatchPolicyViolations(parseWorkflow(interpolatedDispatch))).not.toEqual([]);
  });

  test('continue-on-error adversarial fixtures must fail release and mirror policies', () => {
    const releaseJobBypass = parseWorkflow(`
jobs:
  publish:
    continue-on-error: true
    permissions:
      id-token: write
    steps:
      - uses: ${CHECKOUT_ACTION}
        with:
          fetch-depth: 0
      - run: node scripts/verifyReleaseRef.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: npm run lint
      - run: npm test -- --runInBand --silent
      - run: npm run build:plugin
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`);
    const releaseStepBypass = parseWorkflow(`
jobs:
  publish:
    permissions:
      id-token: write
    steps:
      - uses: ${CHECKOUT_ACTION}
        with:
          fetch-depth: 0
      - run: node scripts/verifyReleaseRef.js
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: npm run lint
        continue-on-error: true
      - run: npm test -- --runInBand --silent
      - run: npm run build:plugin
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`);
    const mirrorJobBypass = parseWorkflow(`
jobs:
  sync:
    continue-on-error: true
    steps:
      - run: |
          echo '${GITEE_HOST_KEY}' >> ~/.ssh/known_hosts
          cat >> ~/.ssh/config << EOF
          StrictHostKeyChecking yes
          EOF
          git push gitee --tags --force
`);
    const mirrorStepBypass = parseWorkflow(`
jobs:
  sync:
    steps:
      - run: |
          echo '${GITEE_HOST_KEY}' >> ~/.ssh/known_hosts
          cat >> ~/.ssh/config << EOF
          StrictHostKeyChecking yes
          EOF
          git push gitee --tags --force
        continue-on-error: true
`);

    expect(releasePolicyViolations(releaseJobBypass)).toContain('release job must not continue after failure');
    expect(releasePolicyViolations(releaseStepBypass)).toContain('release security gates must not continue after failure');
    expect(mirrorPolicyViolations(mirrorJobBypass)).toContain('mirror job must not continue after failure');
    expect(mirrorPolicyViolations(mirrorStepBypass)).toContain('mirror steps must not continue after failure');
  });
});

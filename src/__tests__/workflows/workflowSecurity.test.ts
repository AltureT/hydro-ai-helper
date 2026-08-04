import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

type WorkflowStep = {
  'continue-on-error'?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: unknown;
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

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, unknown>;
};

const workflowDirectory = path.resolve(__dirname, '../../../.github/workflows');
const githubDirectory = path.resolve(__dirname, '../../../.github');
const workflowFiles = [
  'ci.yml',
  'npm-publish.yml',
  'sync-releases-to-gitee.yml',
  'sync-to-gitee.yml',
];
const CHECKOUT_ACTION = 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09';
const SETUP_NODE_ACTION = 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38';
const GITEE_HOST_KEY = 'gitee.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB/OvYN';
const DISPATCH_TAG_EXPRESSION = '${{ github.event.inputs.tag_name }}';
const RELEASE_EVENT_TAG_EXPRESSION = '${{ github.event.release.tag_name }}';

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

function namedStepIndex(steps: WorkflowStep[], name: string): number {
  return steps.findIndex((step) => step.name === name);
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
  const setupNodeIndex = steps.findIndex((step) => step.uses === SETUP_NODE_ACTION);
  const verifierIndex = commandIndex(steps, 'node scripts/verifyReleaseRef.js');
  const installIndex = commandIndex(steps, 'npm ci');
  const lintIndex = commandIndex(steps, 'npm run lint');
  const testIndex = commandIndex(steps, 'npm test -- --runInBand --silent');
  const buildIndex = commandIndex(steps, 'npm run build:plugin');
  const versionCheckIndex = namedStepIndex(steps, '验证版本一致性');
  const publishIndex = commandIndex(steps, 'npm publish --provenance --access public');
  const verifier = steps[verifierIndex];
  const publish = steps[publishIndex];

  const permissionEntries = Object.entries(job.permissions || {}).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(permissionEntries) !== JSON.stringify([
    ['actions', 'write'],
    ['contents', 'write'],
    ['id-token', 'write'],
  ])) {
    violations.push('release permissions must be limited to contents, actions, and id-token write');
  }
  if (permitsFailure(job['continue-on-error'])) violations.push('release job must not continue after failure');
  if (!checkout || checkout.with?.['fetch-depth'] !== 0 || checkout.with?.['persist-credentials'] !== false) {
    violations.push('checkout must fetch complete history without persisting credentials');
  }
  if (!verifier || verifier.env?.GITHUB_TOKEN !== '${{ secrets.GITHUB_TOKEN }}') {
    violations.push('release verifier must receive GITHUB_TOKEN');
  }
  if (!publish || publish.env?.NODE_AUTH_TOKEN !== '${{ secrets.NPM_TOKEN }}') {
    violations.push('provenance publish must retain NODE_AUTH_TOKEN');
  }
  if ([setupNodeIndex, verifierIndex, installIndex, lintIndex, testIndex, buildIndex, versionCheckIndex, publishIndex]
    .some((index) => index < 0)) {
    violations.push('release gate command is missing');
  } else if (verifierIndex !== setupNodeIndex + 1 || verifierIndex >= installIndex) {
    violations.push('release verifier must run immediately after setup-node and before dependency install');
  } else if (![verifierIndex, installIndex, lintIndex, testIndex, buildIndex, versionCheckIndex]
    .every((index) => index < publishIndex)) {
    violations.push('release gates must run before publish');
  }
  const mandatorySteps = [
    verifier,
    steps[installIndex],
    steps[lintIndex],
    steps[testIndex],
    steps[buildIndex],
    steps[versionCheckIndex],
    publish,
  ];
  if (mandatorySteps.some(
    (step) => step && permitsFailure(step['continue-on-error']),
  )) {
    violations.push('release security gates must not continue after failure');
  }
  if (mandatorySteps.some((step) => step && step.if !== undefined)) {
    violations.push('release security gates must not have conditional execution');
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
  if (steps.some((step) => step.if !== undefined)) {
    violations.push('mirror security steps must not have conditional execution');
  }
  if (steps.filter((step) => step.run).some((step) => activeShellLines(step.run)[0] !== 'set -euo pipefail')) {
    violations.push('mirror shell steps must enable strict error handling');
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
  const steps = getSteps(job);
  const commands = steps.flatMap((step) => activeShellLines(step.run));
  const releaseStep = steps.find((step) => step.id === 'release');
  const checkStep = steps.find((step) => step.id === 'check');
  const syncStep = steps.find((step) => step.name === 'Create or Update release on Gitee');
  const violations: string[] = [];

  if (permitsFailure(job['continue-on-error']) || steps.some((step) => permitsFailure(step['continue-on-error']))) {
    violations.push('release mirror failures must propagate');
  }
  if (steps.some((step) => step.if !== undefined)) {
    violations.push('release mirror security steps must not have conditional execution');
  }
  if (steps.filter((step) => step.run).some((step) => activeShellLines(step.run)[0] !== 'set -euo pipefail')) {
    violations.push('release mirror shell steps must enable strict error handling');
  }
  if (steps.some((step) => step.run?.includes('${{'))) {
    violations.push('GitHub expressions must not be inserted into release mirror shell source');
  }
  const expressionLocations = [
    ...expressionPaths(workflow, DISPATCH_TAG_EXPRESSION),
    ...expressionPaths(workflow, RELEASE_EVENT_TAG_EXPRESSION),
  ];
  if (expressionLocations.length !== 2 || expressionLocations.some((location) => !location.includes('.env.'))) {
    violations.push('event tag expressions must only appear in step environment');
  }
  if (releaseStep?.env?.DISPATCH_TAG_NAME !== DISPATCH_TAG_EXPRESSION
    || releaseStep.env?.RELEASE_EVENT_TAG_NAME !== RELEASE_EVENT_TAG_EXPRESSION
    || releaseStep.env?.EVENT_NAME !== '${{ github.event_name }}'
    || releaseStep.env?.GH_REPO !== '${{ github.repository }}'
    || releaseStep.env?.GH_TOKEN !== '${{ secrets.GITHUB_TOKEN }}') {
    violations.push('release event data and GitHub token must enter through release-step environment');
  }
  if (checkStep?.env?.TAG_NAME !== '${{ steps.release.outputs.tag_name }}'
    || checkStep.env?.GITEE_ACCESS_TOKEN !== '${{ secrets.GITEE_ACCESS_TOKEN }}') {
    violations.push('Gitee lookup data must enter through check-step environment');
  }
  if (syncStep?.env?.TAG_NAME !== '${{ steps.release.outputs.tag_name }}'
    || syncStep.env?.PRERELEASE !== '${{ steps.release.outputs.prerelease }}'
    || syncStep.env?.RELEASE_EXISTS !== '${{ steps.check.outputs.exists }}'
    || syncStep.env?.RELEASE_ID !== '${{ steps.check.outputs.release_id }}'
    || syncStep.env?.GITEE_ACCESS_TOKEN !== '${{ secrets.GITEE_ACCESS_TOKEN }}') {
    violations.push('controlled outputs and Gitee token must enter through sync-step environment');
  }
  const releaseCommands = activeShellLines(releaseStep?.run);
  if (!releaseCommands.includes('TAG_NAME="$DISPATCH_TAG_NAME"')
    || !releaseCommands.includes('TAG_NAME="$RELEASE_EVENT_TAG_NAME"')) {
    violations.push('release tag must be selected from quoted environment variables');
  }
  if (!releaseCommands.includes('if [[ ! "$TAG_NAME" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then')) {
    violations.push('release tag must be validated as a stable semantic version');
  }
  if (!releaseCommands.some((line) => line.startsWith('gh api ') && line.includes('> /tmp/release_info.json'))
    || !releaseCommands.some((line) => line.includes('> /tmp/release_name.txt'))
    || !releaseCommands.some((line) => line.includes('> /tmp/release_body.txt'))) {
    violations.push('GitHub release data must be fetched into JSON and name/body files');
  }
  if (commands.some((line) => /release_(?:name|body)=/i.test(line))) {
    violations.push('release name and body must not be workflow outputs');
  }
  const outputWrites = commands.filter((line) => line.includes('GITHUB_OUTPUT'));
  if (outputWrites.some((line) => !line.includes('>> "$GITHUB_OUTPUT"'))
    || outputWrites.some((line) => !/^printf /.test(line))) {
    violations.push('workflow outputs must use quoted multiline-safe writes');
  }

  return violations;
}

function nonPublishingPermissionViolations(workflow: Workflow): string[] {
  return JSON.stringify(workflow.permissions) === JSON.stringify({ contents: 'read' })
    ? []
    : ['non-publishing workflow permissions must be contents read only'];
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
    expect(automationGuide).toContain('npm version patch --no-git-tag-version');
    expect(automationGuide).toContain('git fetch origin main --tags');
    expect(automationGuide).toContain('git tag -s -a');
    expect(automationGuide).toContain('git push origin refs/tags/');
    expect(automationGuide).not.toContain('npm version patch --sign-git-tag');
    expect(automationGuide).not.toContain('git push origin main --tags');
  });

  test.each(workflowFiles)('%s pins every GitHub Action to an immutable SHA', (workflowFile) => {
    const usesLines = readWorkflow(workflowFile)
      .split('\n')
      .filter((line) => line.includes('uses:'));

    for (const line of usesLines) {
      expect(line).toMatch(/^\s*(?:-\s+)?uses:\s+[^\s@]+@[a-f0-9]{40}\s+# v\d+\s*$/);
    }
  });

  test.each(['ci.yml', 'sync-to-gitee.yml', 'sync-releases-to-gitee.yml'])(
    '%s grants only read access to repository contents',
    (workflowFile) => {
      expect(nonPublishingPermissionViolations(parseWorkflow(readWorkflow(workflowFile)))).toEqual([]);
    },
  );

  test('npm publishing executes trusted release gates before authenticated provenance publishing', () => {
    expect(releasePolicyViolations(parseWorkflow(readWorkflow('npm-publish.yml')))).toEqual([]);
  });

  test('Gitee mirror uses an active pinned SSH policy and a failure-propagating tag push', () => {
    expect(mirrorPolicyViolations(parseWorkflow(readWorkflow('sync-to-gitee.yml')))).toEqual([]);
  });

  test('release dispatch data appears only in job environment and shell variable expansion', () => {
    expect(dispatchPolicyViolations(parseWorkflow(readWorkflow('sync-releases-to-gitee.yml')))).toEqual([]);
  });

  test('release tag selection rejects command substitution, quotes, and newlines before API access', () => {
    const workflow = parseWorkflow(readWorkflow('sync-releases-to-gitee.yml'));
    const releaseStep = getSteps(getJob(workflow, 'sync-release')).find((step) => step.id === 'release');
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-tag-policy-'));
    const sentinelPath = path.join(temporaryDirectory, 'command-substitution-ran');
    const maliciousTags = [
      `v1.2.3$(touch ${sentinelPath})`,
      'v1.2.3"',
      'v1.2.3\nINJECTED=true',
    ];

    try {
      expect(releaseStep?.run).toBeDefined();
      for (const maliciousTag of maliciousTags) {
        const result = spawnSync('/bin/bash', ['-c', releaseStep?.run || ''], {
          encoding: 'utf8',
          env: {
            ...process.env,
            DISPATCH_TAG_NAME: maliciousTag,
            EVENT_NAME: 'workflow_dispatch',
            GH_REPO: 'AltureT/hydro-ai-helper',
            GH_TOKEN: 'test-token',
            GITHUB_OUTPUT: path.join(temporaryDirectory, 'outputs'),
            RELEASE_EVENT_TAG_NAME: '',
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Invalid stable release tag');
      }
      expect(fs.existsSync(sentinelPath)).toBe(false);
    } finally {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  test('direct release expressions and multiline output propagation are policy violations', () => {
    const unsafeWorkflow = parseWorkflow(`
jobs:
  sync-release:
    steps:
      - id: release
        env:
          DISPATCH_TAG_NAME: \${{ github.event.inputs.tag_name }}
          RELEASE_EVENT_TAG_NAME: \${{ github.event.release.tag_name }}
        run: |
          set -euo pipefail
          TAG_NAME="\${{ github.event.inputs.tag_name }}"
          echo "release_name=\${{ github.event.release.name }}" >> $GITHUB_OUTPUT
          echo "release_body=\${{ github.event.release.body }}" >> $GITHUB_OUTPUT
      - id: check
        run: |
          set -euo pipefail
          TAG_NAME="\${{ steps.release.outputs.tag_name }}"
      - name: Create or Update release on Gitee
        run: |
          set -euo pipefail
          RELEASE_NAME="\${{ steps.release.outputs.release_name }}"
`);

    const violations = dispatchPolicyViolations(unsafeWorkflow);
    expect(violations).toContain('GitHub expressions must not be inserted into release mirror shell source');
    expect(violations).toContain('release name and body must not be workflow outputs');
    expect(violations).toContain('workflow outputs must use quoted multiline-safe writes');
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

  test('conditional execution cannot skip release or mirror security steps', () => {
    const conditionalRelease = parseWorkflow(`
jobs:
  publish:
    permissions:
      actions: write
      contents: write
      id-token: write
    steps:
      - uses: ${CHECKOUT_ACTION}
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: ${SETUP_NODE_ACTION}
      - run: node scripts/verifyReleaseRef.js
        if: false
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: npm ci
      - run: npm run lint
      - run: npm test -- --runInBand --silent
      - run: npm run build:plugin
      - name: 验证版本一致性
        run: verify-version
      - run: npm publish --provenance --access public
        if: always()
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`);
    const conditionalMirror = parseWorkflow(`
jobs:
  sync:
    steps:
      - name: Setup SSH
        if: false
        run: |
          set -euo pipefail
          echo '${GITEE_HOST_KEY}' >> ~/.ssh/known_hosts
          cat >> ~/.ssh/config << EOF
          StrictHostKeyChecking yes
          EOF
      - name: Push to Gitee
        run: |
          set -euo pipefail
          git push gitee --tags --force
`);

    expect(releasePolicyViolations(conditionalRelease))
      .toContain('release security gates must not have conditional execution');
    expect(mirrorPolicyViolations(conditionalMirror))
      .toContain('mirror security steps must not have conditional execution');
  });
});

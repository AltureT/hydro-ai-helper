import fs from 'fs';
import path from 'path';

const workflowDirectory = path.resolve(__dirname, '../../../.github/workflows');
const workflowFiles = [
  'ci.yml',
  'npm-publish.yml',
  'sync-releases-to-gitee.yml',
  'sync-to-gitee.yml',
];

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(workflowDirectory, name), 'utf8');
}

describe('workflow security policy', () => {
  test.each(workflowFiles)('%s pins every GitHub Action to an immutable SHA', (workflowFile) => {
    const usesLines = readWorkflow(workflowFile)
      .split('\n')
      .filter((line) => line.includes('uses:'));

    for (const line of usesLines) {
      expect(line).toMatch(/^\s*(?:-\s+)?uses:\s+[^\s@]+@[a-f0-9]{40}\s+# v\d+\s*$/);
    }
  });

  test('npm publishing verifies a complete trusted release before provenance publishing', () => {
    const workflow = readWorkflow('npm-publish.yml');

    expect(workflow).toContain('fetch-depth: 0');
    expect(workflow).toContain('node scripts/verifyReleaseRef.js');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(workflow).toContain('npm run lint');
    expect(workflow).toContain('npm test -- --runInBand --silent');
    expect(workflow).toContain('npm run build:plugin');
    expect(workflow).toContain('npm publish --provenance --access public');
    expect(workflow).toContain('id-token: write');
  });

  test('Gitee mirror pins its SSH host identity and does not hide tag push failures', () => {
    const workflow = readWorkflow('sync-to-gitee.yml');

    expect(workflow).toContain('gitee.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB/OvYN');
    expect(workflow).toContain('StrictHostKeyChecking yes');
    expect(workflow).not.toContain('ssh-keyscan');
    expect(workflow).not.toMatch(/git push gitee --tags --force\s*\|\|\s*true/);
  });

  test('release dispatch data is passed through environment instead of shell interpolation', () => {
    const workflow = readWorkflow('sync-releases-to-gitee.yml');

    expect(workflow).toContain('DISPATCH_TAG_NAME: ${{ github.event.inputs.tag_name }}');
    expect(workflow).toContain('TAG_NAME="$DISPATCH_TAG_NAME"');
    expect(workflow).not.toContain('TAG_NAME="${{ github.event.inputs.tag_name }}"');
  });
});

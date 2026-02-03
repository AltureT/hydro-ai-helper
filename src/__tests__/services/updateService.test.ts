import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { UpdateService } from '../../services/updateService';

describe('UpdateService (security)', () => {
  const makeTempPluginDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydro-ai-helper-update-test-'));
    fs.mkdirSync(path.join(dir, 'assets', 'trusted-keys'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'trusted-keys', 'publisher.asc'), 'dummy');
    return dir;
  };

  afterEach(() => {
    delete process.env.AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS;
  });

  describe('verifyGPGSignature', () => {
    it('accepts a commit signed by a subkey when the primary fingerprint is trusted', async () => {
      const pluginDir = makeTempPluginDir();
      const service = new UpdateService(pluginDir) as any;

      const signingSubkeyFpr = '2E7B52E0673EB599A0478A559EB777505708430C';
      const primaryFpr = 'B6115AF3D271D12AB85E843E45DACC0ECFE90852';

      service.executeCommand = jest.fn(async (command: string, args: string[]) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { code: 0, stdout: 'gpg (GnuPG) 2.4.0', stderr: '' };
        }
        if (command === 'gpg' && args[0] === '--batch') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args.includes('verify-commit')) {
          return {
            code: 0,
            stdout: '',
            stderr: `[GNUPG:] GOODSIG 9EB777505708430C AltureT <myalture@gmail.com>\n[GNUPG:] VALIDSIG ${signingSubkeyFpr} 2026-02-01 1769954015 0 4 0 1 8 00 ${primaryFpr}\n`
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.verifyGPGSignature();

      expect(result.valid).toBe(true);

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('rejects a signature when the primary fingerprint is not trusted', async () => {
      const pluginDir = makeTempPluginDir();
      const service = new UpdateService(pluginDir) as any;

      service.executeCommand = jest.fn(async (command: string, args: string[]) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { code: 0, stdout: 'gpg (GnuPG) 2.4.0', stderr: '' };
        }
        if (command === 'gpg' && args[0] === '--batch') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args.includes('verify-commit')) {
          return {
            code: 0,
            stdout: '',
            stderr:
              '[GNUPG:] VALIDSIG 1111111111111111111111111111111111111111 2026-02-01 1769954015 0 4 0 1 8 00 2222222222222222222222222222222222222222\n'
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.verifyGPGSignature();

      expect(result.valid).toBe(false);
      expect(result.error).toContain('不在信任列表');

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('rejects when the commit has no signature', async () => {
      const pluginDir = makeTempPluginDir();
      const service = new UpdateService(pluginDir) as any;

      service.executeCommand = jest.fn(async (command: string, args: string[]) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { code: 0, stdout: 'gpg (GnuPG) 2.4.0', stderr: '' };
        }
        if (command === 'gpg' && args[0] === '--batch') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (command === 'git' && args.includes('verify-commit')) {
          return { code: 1, stdout: '', stderr: 'no signature found' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.verifyGPGSignature();

      expect(result.valid).toBe(false);
      expect(result.error).toContain('未启用 GPG 签名');

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('rejects when gpg is not available', async () => {
      const pluginDir = makeTempPluginDir();
      const service = new UpdateService(pluginDir) as any;

      service.executeCommand = jest.fn(async (command: string, args: string[]) => {
        if (command === 'gpg' && args[0] === '--version') {
          return { code: 1, stdout: '', stderr: 'not found' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.verifyGPGSignature();

      expect(result.valid).toBe(false);
      expect(result.error).toContain('未检测到可用的 gpg');

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });
  });

  describe('installDependencies', () => {
    it('uses npm ci and disables scripts by default when package-lock exists', async () => {
      const pluginDir = makeTempPluginDir();
      fs.writeFileSync(path.join(pluginDir, 'package-lock.json'), '{}');
      const service = new UpdateService(pluginDir) as any;

      service.executeCommand = jest.fn(async (_cmd: string, args: string[], _cwd: string, _onOut: any, _timeout: any, env: any) => {
        expect(env.NODE_ENV).toBe('development');
        expect(env.NPM_CONFIG_PRODUCTION).toBe('false');
        expect(args[0]).toBe('ci');
        expect(args).toContain('--ignore-scripts');
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.installDependencies();

      expect(result.code).toBe(0);
      expect(result.usedCi).toBe(true);
      expect(result.ignoreScripts).toBe(true);

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('falls back to npm install when npm ci fails', async () => {
      const pluginDir = makeTempPluginDir();
      fs.writeFileSync(path.join(pluginDir, 'package-lock.json'), '{}');
      const service = new UpdateService(pluginDir) as any;

      const calls: string[][] = [];
      service.executeCommand = jest.fn(async (_cmd: string, args: string[]) => {
        calls.push(args);
        if (args[0] === 'ci') {
          return { code: 1, stdout: '', stderr: 'ci failed' };
        }
        if (args[0] === 'install') {
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.installDependencies();

      expect(result.code).toBe(0);
      expect(result.usedCi).toBe(false);
      expect(calls[0][0]).toBe('ci');
      expect(calls[1][0]).toBe('install');

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });

    it('allows npm scripts when AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS=1', async () => {
      process.env.AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS = '1';

      const pluginDir = makeTempPluginDir();
      fs.writeFileSync(path.join(pluginDir, 'package-lock.json'), '{}');
      const service = new UpdateService(pluginDir) as any;

      service.executeCommand = jest.fn(async (_cmd: string, args: string[]) => {
        expect(args).not.toContain('--ignore-scripts');
        return { code: 0, stdout: '', stderr: '' };
      });

      const result = await service.installDependencies();

      expect(result.code).toBe(0);
      expect(result.ignoreScripts).toBe(false);

      fs.rmSync(pluginDir, { recursive: true, force: true });
    });
  });
});


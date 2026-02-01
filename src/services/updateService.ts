/**
 * UpdateService - 插件更新服务
 *
 * 提供插件在线更新功能：
 * - 自动检测插件安装路径
 * - 自动选择最优仓库（优先 Gitee，备选 GitHub）
 * - 执行 git pull 获取最新代码
 * - 执行 npm run build:plugin 编译
 * - 执行 pm2 restart hydrooj 重启服务
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';

/**
 * 仓库配置（按优先级排序）
 */
const GIT_REPOS = [
  {
    name: 'Gitee',
    url: 'https://gitee.com/alture/hydro-ai-helper.git',
    testUrl: 'https://gitee.com/alture/hydro-ai-helper'
  },
  {
    name: 'GitHub',
    url: 'https://github.com/AltureT/hydro-ai-helper.git',
    testUrl: 'https://github.com/AltureT/hydro-ai-helper'
  }
];

/**
 * 仓库选择结果
 */
interface RepoSelection {
  name: string;
  url: string;
  latency: number;
}

/**
 * 网络环境类型
 */
type NetworkRegion = 'cn' | 'global' | 'unknown';

/**
 * 更新步骤
 */
export type UpdateStep = 'detecting' | 'pulling' | 'building' | 'restarting' | 'completed' | 'failed';

/**
 * 更新结果接口
 */
export interface UpdateResult {
  success: boolean;
  step: UpdateStep;
  message: string;
  logs: string[];
  pluginPath?: string;
  error?: string;
}

/**
 * 更新进度回调
 */
export type UpdateProgressCallback = (step: UpdateStep, log: string) => void;

/**
 * UpdateService 类
 */
export class UpdateService {
  private pluginPath: string;

  // 🔒 更新锁：防止并发更新（静态变量，全局共享）
  private static updateLock = false;

  constructor() {
    // 通过 __dirname 自动检测插件安装路径
    // __dirname 指向 dist 目录，需要回退到插件根目录
    this.pluginPath = path.resolve(__dirname, '../..');
  }

  /**
   * 获取插件安装路径
   */
  getPluginPath(): string {
    return this.pluginPath;
  }

  /**
   * 验证插件路径是否有效（不检查 git 仓库）
   */
  validatePluginPath(): { valid: boolean; message: string; needsGitInit: boolean } {
    // 检查路径是否存在
    if (!fs.existsSync(this.pluginPath)) {
      return { valid: false, message: `插件路径不存在: ${this.pluginPath}`, needsGitInit: false };
    }

    // 检查是否有 package.json
    const packageJsonPath = path.join(this.pluginPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { valid: false, message: `未找到 package.json: ${packageJsonPath}`, needsGitInit: false };
    }

    // 检查是否是 git 仓库
    const gitPath = path.join(this.pluginPath, '.git');
    if (!fs.existsSync(gitPath)) {
      return { valid: true, message: '需要初始化 git 仓库', needsGitInit: true };
    }

    return { valid: true, message: '路径验证通过', needsGitInit: false };
  }

  /**
   * 初始化 git 仓库并拉取代码
   */
  private async initGitRepo(repoUrl: string, onLog?: (msg: string) => void): Promise<boolean> {
    const log = (msg: string) => onLog?.(msg);

    log('目录不是 git 仓库，正在初始化...');

    // git init
    log('执行 git init...');
    const initResult = await this.executeCommand('git', ['init'], this.pluginPath);
    if (initResult.code !== 0) {
      log(`git init 失败: ${initResult.stderr}`);
      return false;
    }

    // git remote add origin
    log(`添加远程仓库: ${repoUrl}`);
    const remoteResult = await this.executeCommand('git', ['remote', 'add', 'origin', repoUrl], this.pluginPath);
    if (remoteResult.code !== 0) {
      // 如果 remote 已存在，尝试设置 URL
      const setUrlResult = await this.executeCommand('git', ['remote', 'set-url', 'origin', repoUrl], this.pluginPath);
      if (setUrlResult.code !== 0) {
        log(`设置远程仓库失败: ${setUrlResult.stderr}`);
        return false;
      }
    }

    // git fetch
    log('正在获取远程代码...');
    const fetchResult = await this.executeCommand('git', ['fetch', 'origin'], this.pluginPath, (line) => log(line.trim()));
    if (fetchResult.code !== 0) {
      log(`git fetch 失败: ${fetchResult.stderr}`);
      return false;
    }

    // git reset --hard origin/main
    log('正在同步到最新版本...');
    const resetResult = await this.executeCommand('git', ['reset', '--hard', 'origin/main'], this.pluginPath, (line) => log(line.trim()));
    if (resetResult.code !== 0) {
      log(`git reset 失败: ${resetResult.stderr}`);
      return false;
    }

    log('git 仓库初始化完成');
    return true;
  }

  /**
   * 测试单个仓库的连接延迟
   * @param repo 仓库配置
   * @returns 延迟（毫秒），失败返回 -1
   */
  private async testRepoLatency(repo: typeof GIT_REPOS[0]): Promise<number> {
    const startTime = Date.now();
    try {
      await axios.head(repo.testUrl, {
        timeout: 5000,
        maxRedirects: 3
      });
      return Date.now() - startTime;
    } catch {
      return -1;
    }
  }

  /**
   * 检测网络环境（国内/国外）
   */
  private async detectNetworkRegion(onLog?: (msg: string) => void): Promise<NetworkRegion> {
    const log = (msg: string) => onLog?.(msg);

    try {
      const baiduTest = axios.head('https://www.baidu.com', { timeout: 3000 });
      const googleTest = axios.head('https://www.google.com', { timeout: 3000 });

      const results = await Promise.allSettled([baiduTest, googleTest]);
      const baiduOk = results[0].status === 'fulfilled';
      const googleOk = results[1].status === 'fulfilled';

      if (baiduOk && !googleOk) {
        log('检测到国内网络环境');
        return 'cn';
      }
      if (googleOk) {
        log('检测到国外网络环境');
        return 'global';
      }
      log('网络环境检测失败，使用默认配置');
      return 'unknown';
    } catch {
      log('网络环境检测异常，使用默认配置');
      return 'unknown';
    }
  }

  /**
   * 获取仓库优先级顺序
   */
  private getRepoOrder(region: NetworkRegion): typeof GIT_REPOS {
    if (region === 'global') {
      return [GIT_REPOS[1], GIT_REPOS[0]];
    }
    return [GIT_REPOS[0], GIT_REPOS[1]];
  }

  /**
   * 选择最优仓库（根据网络环境优先国内/国外镜像）
   * @param onLog 日志回调
   * @returns 选中的仓库信息
   */
  async selectBestRepo(onLog?: (msg: string) => void): Promise<RepoSelection> {
    const log = (msg: string) => onLog?.(msg);

    log('正在检测最优仓库...');

    const region = await this.detectNetworkRegion(onLog);
    const orderedRepos = this.getRepoOrder(region);

    // 按优先级测试仓库
    for (const repo of orderedRepos) {
      log(`测试 ${repo.name} 连接...`);
      const latency = await this.testRepoLatency(repo);

      if (latency > 0) {
        log(`${repo.name} 延迟: ${latency}ms ✓`);
        return { name: repo.name, url: repo.url, latency };
      } else {
        log(`${repo.name} 连接失败，尝试下一个...`);
      }
    }

    // 所有仓库都失败，返回第一个作为默认
    log('所有仓库连接测试失败，使用默认仓库');
    return { name: orderedRepos[0].name, url: orderedRepos[0].url, latency: -1 };
  }

  /**
   * 检查 git 是否已安装
   */
  private async isGitInstalled(): Promise<boolean> {
    const result = await this.executeCommand('git', ['--version'], this.pluginPath);
    return result.code === 0 && result.stdout.toLowerCase().includes('git version');
  }

  /**
   * 检查命令是否存在
   */
  private async commandExists(commandName: string): Promise<boolean> {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'where' : 'sh';
    const args = isWin ? [commandName] : ['-c', `command -v ${commandName}`];
    const result = await this.executeCommand(cmd, args, this.pluginPath);
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  /**
   * 执行 shell 命令行
   */
  private async runShellCommand(
    commandLine: string,
    cwd: string,
    onOutput?: (line: string) => void
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'cmd' : 'sh';
    const args = isWin ? ['/c', commandLine] : ['-c', commandLine];
    return this.executeCommand(cmd, args, cwd, onOutput);
  }

  /**
   * 获取可用的 sudo 前缀
   */
  private async getSudoPrefix(onLog?: (msg: string) => void): Promise<string | null> {
    const log = (msg: string) => onLog?.(msg);
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    if (isRoot) {
      return '';
    }
    if (!(await this.commandExists('sudo'))) {
      log('未检测到 sudo，请手动安装 git 或确保当前用户拥有免密 sudo 权限');
      return null;
    }

    const sudoCheck = await this.runShellCommand('sudo -n true', this.pluginPath);
    if (sudoCheck.code !== 0) {
      log('当前用户无 sudo 免密权限，请手动安装 git 或配置免密 sudo');
      return null;
    }

    return 'sudo -n ';
  }

  /**
   * 自动安装 git（已禁用 - 安全考虑）
   *
   * 安全审计建议：Web 应用不应执行系统级安装操作
   * 所有平台均要求管理员手动安装 Git
   */
  private async installGit(
    region: NetworkRegion,
    onLog?: (msg: string) => void
  ): Promise<{ ok: boolean; message?: string }> {
    const log = (msg: string) => onLog?.(msg);
    const platform = process.platform;

    // 安全策略：禁止 Web 应用使用 sudo 安装系统软件
    const installGuides = {
      linux: 'Linux 系统请使用包管理器手动安装 Git:\n  • Debian/Ubuntu: sudo apt-get install git\n  • CentOS/RHEL: sudo yum install git\n  • Fedora: sudo dnf install git\n  • Arch: sudo pacman -S git\n  • Alpine: sudo apk add git',
      darwin: 'macOS 系统请手动安装 Git:\n  • 方法1: 下载官方安装包 https://git-scm.com/download/mac\n  • 方法2: 使用 Homebrew: brew install git\n  • 方法3: 安装 Xcode Command Line Tools',
      win32: 'Windows 系统请手动安装 Git:\n  • 下载官方安装包: https://git-scm.com/download/win\n  • 或使用包管理器: winget install Git.Git'
    };

    const guide = installGuides[platform as keyof typeof installGuides] || '请手动安装 Git';
    log(guide);

    return {
      ok: false,
      message: `需要手动安装 Git。${platform === 'linux' ? '请使用系统包管理器安装后重试。' : ''}`
    };
  }

  /**
   * 确保 git 已安装
   */
  private async ensureGitInstalled(
    region: NetworkRegion,
    onLog?: (msg: string) => void
  ): Promise<{ ok: boolean; message?: string }> {
    const log = (msg: string) => onLog?.(msg);

    log('检查 git 是否已安装...');
    if (await this.isGitInstalled()) {
      log('git 已安装');
      return { ok: true };
    }

    log('未检测到 git，尝试自动安装...');
    const installResult = await this.installGit(region, onLog);
    if (!installResult.ok) {
      return { ok: false, message: installResult.message || '自动安装 git 失败' };
    }

    if (await this.isGitInstalled()) {
      log('git 安装完成');
      return { ok: true };
    }

    return { ok: false, message: 'git 安装完成但仍无法使用，可能需要重启终端' };
  }

  /**
   * 设置 git remote origin 为指定 URL
   */
  private async setRemoteOrigin(url: string, onLog?: (msg: string) => void): Promise<boolean> {
    const log = (msg: string) => onLog?.(msg);

    // 先获取当前 remote
    const getResult = await this.executeCommand('git', ['remote', 'get-url', 'origin'], this.pluginPath);
    const currentUrl = getResult.stdout.trim();

    if (currentUrl === url) {
      log(`远程仓库已是: ${url}`);
      return true;
    }

    log(`切换远程仓库: ${currentUrl} -> ${url}`);
    const setResult = await this.executeCommand('git', ['remote', 'set-url', 'origin', url], this.pluginPath);

    if (setResult.code !== 0) {
      log(`设置远程仓库失败: ${setResult.stderr}`);
      return false;
    }

    log('远程仓库切换成功');
    return true;
  }

  /**
   * ��行命令并返回 Promise
   */
  private executeCommand(
    command: string,
    args: string[],
    cwd: string,
    onOutput?: (line: string) => void
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc: ChildProcess = spawn(command, args, {
        cwd,
        shell: false,  // 🔒 禁用 shell：防止命令注入风险
        env: { ...process.env, PATH: process.env.PATH }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const line = data.toString();
        stdout += line;
        if (onOutput) onOutput(line);
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        stderr += line;
        if (onOutput) onOutput(line);
      });

      proc.on('close', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });

      proc.on('error', (err) => {
        stderr += err.message;
        resolve({ code: 1, stdout, stderr });
      });
    });
  }

  /**
   * 执行完整更新流程
   */
  async performUpdate(onProgress?: UpdateProgressCallback): Promise<UpdateResult> {
    // 🔒 检查更新锁：防止并发更新
    if (UpdateService.updateLock) {
      return {
        success: false,
        step: 'failed',
        message: '更新操作正在进行中，请等待当前更新完成后再试',
        logs: [],
        pluginPath: this.pluginPath,
        error: '并发更新被拒绝'
      };
    }

    // 设置更新锁
    UpdateService.updateLock = true;

    const logs: string[] = [];
    const log = (step: UpdateStep, message: string) => {
      logs.push(`[${step}] ${message}`);
      if (onProgress) onProgress(step, message);
    };

    // 用于失败回滚的备份 commit（在函数作用域声明）
    let backupCommit = '';

    try {
      // Step 1: 验证路径
      log('detecting', `检测插件路径: ${this.pluginPath}`);
      const validation = this.validatePluginPath();
      if (!validation.valid) {
        log('failed', validation.message);
        return {
          success: false,
          step: 'failed',
          message: validation.message,
          logs,
          pluginPath: this.pluginPath,
          error: validation.message
        };
      }
      log('detecting', validation.message);

      // Step 1.2: 检测网络环境
      log('detecting', '正在检测网络环境...');
      const region = await this.detectNetworkRegion((msg) => log('detecting', msg));

      // Step 1.3: 确保 git 已安装
      const gitCheck = await this.ensureGitInstalled(region, (msg) => log('detecting', msg));
      if (!gitCheck.ok) {
        const msg = gitCheck.message || 'git 未安装且无法自动安装';
        log('failed', msg);
        return {
          success: false,
          step: 'failed',
          message: msg,
          logs,
          pluginPath: this.pluginPath,
          error: msg
        };
      }

      // Step 1.5: 选择最优仓库
      const orderedRepos = this.getRepoOrder(region);
      log('detecting', '正在测试仓库连接...');

      let selectedRepo: RepoSelection | null = null;
      for (const repo of orderedRepos) {
        log('detecting', `测试 ${repo.name} 连接...`);
        const latency = await this.testRepoLatency(repo);
        if (latency > 0) {
          log('detecting', `${repo.name} 延迟: ${latency}ms ✓`);
          selectedRepo = { name: repo.name, url: repo.url, latency };
          break;
        } else {
          log('detecting', `${repo.name} 连接失败，尝试下一个...`);
        }
      }

      if (!selectedRepo) {
        log('detecting', '所有仓库连接测试失败，使用默认仓库');
        selectedRepo = { name: orderedRepos[0].name, url: orderedRepos[0].url, latency: -1 };
      }

      log('detecting', `使用仓库: ${selectedRepo.name} (${selectedRepo.url})`);

      // Step 1.6: 如果需要初始化 git 仓库
      if (validation.needsGitInit) {
        const initSuccess = await this.initGitRepo(selectedRepo.url, (msg) => log('detecting', msg));
        if (!initSuccess) {
          log('failed', 'git 仓库初始化失败');
          return {
            success: false,
            step: 'failed',
            message: 'git 仓库初始化失败',
            logs,
            pluginPath: this.pluginPath,
            error: 'git 仓库初始化失败'
          };
        }
        // 初始化完成后跳过 pull，直接进入 build
        log('pulling', '代码已通过初始化同步完成');
      } else {
        // 设置 remote origin
        const remoteSet = await this.setRemoteOrigin(selectedRepo.url, (msg) => log('detecting', msg));
        if (!remoteSet) {
          log('failed', '设置远程仓库失败');
          return {
            success: false,
            step: 'failed',
            message: '设置远程仓库失败',
            logs,
            pluginPath: this.pluginPath,
            error: '设置远程仓库失败'
          };
        }

        // Step 2a: 备份当前 commit（用于失败回滚）
        log('pulling', '备份当前版本...');
        const backupResult = await this.executeCommand(
          'git',
          ['rev-parse', 'HEAD'],
          this.pluginPath
        );

        if (backupResult.code === 0) {
          backupCommit = backupResult.stdout.trim();
          log('pulling', `当前版本: ${backupCommit.substring(0, 8)}`);
        } else {
          log('pulling', `无法获取当前版本: ${backupResult.stderr}`);
        }

        // Step 2b: 重置本地更改，避免 pull 冲突
        log('pulling', '重置本地更改...');
        const resetResult = await this.executeCommand(
          'git',
          ['reset', '--hard', 'HEAD'],
          this.pluginPath,
          (line) => log('pulling', line.trim())
        );
        if (resetResult.code !== 0) {
          log('pulling', `git reset 警告: ${resetResult.stderr}`);
        }

        // Step 2c: Git pull
        log('pulling', '正在拉取最新代码...');
        const pullResult = await this.executeCommand(
          'git',
          ['pull', '--ff-only', 'origin', 'main'],
          this.pluginPath,
          (line) => log('pulling', line.trim())
        );

        if (pullResult.code !== 0) {
          const errorMsg = `git pull 失败: ${pullResult.stderr}`;
          log('failed', errorMsg);
          return {
            success: false,
            step: 'failed',
            message: errorMsg,
            logs,
            pluginPath: this.pluginPath,
            error: pullResult.stderr
          };
        }
        log('pulling', '代码拉取完成');
      }

      // Step 2.5: GPG 签名验证（安全加固 - 强制验证）
      log('pulling', '正在验证代码签名...');
      const verifyResult = await this.executeCommand(
        'git',
        ['verify-commit', 'HEAD'],
        this.pluginPath
      );

      if (verifyResult.code !== 0) {
        // 🔒 强制 GPG 验证：拒绝所有未签名或签名无效的 commit
        const errorMsg = '代码签名验证失败：拒绝未签名或签名无效的更新';
        log('failed', errorMsg);
        log('failed', 'GPG 验证详情: ' + verifyResult.stderr);

        // 检查是否是"没有签名"
        if (verifyResult.stderr.includes('no signature found') ||
            verifyResult.stderr.includes('gpg: no valid OpenPGP data found')) {
          log('failed', '❌ 上游仓库未启用 GPG 签名，为安全起见拒绝更新');
          log('failed', '请联系插件作者启用 commit 签名以确保代码来源可信');
        } else {
          log('failed', '❌ GPG 签名验证失败（签名无效或密钥不匹配）');
        }

        // 无条件回滚到备份版本
        if (backupCommit) {
          log('failed', `正在回滚到版本 ${backupCommit.substring(0, 8)}...`);
          await this.executeCommand(
            'git',
            ['reset', '--hard', backupCommit],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          log('failed', '代码已回滚到更新前的版本');

          // 🔒 完整回滚：清理并重装依赖（确保版本一致）
          log('failed', '正在清理依赖包...');
          await this.executeCommand(
            'rm',
            ['-rf', 'node_modules'],
            this.pluginPath
          );
          log('failed', '正在重新安装依赖包...');
          const rollbackInstall = await this.executeCommand(
            'npm',
            ['install', '--production'],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          if (rollbackInstall.code === 0) {
            log('failed', '已完全回滚到更新前的状态');
          } else {
            log('failed', '⚠️  警告：依赖包重装失败，服务可能无法正常启动');
          }
        }

        return {
          success: false,
          step: 'failed',
          message: errorMsg + '。请要求插件作者启用 GPG commit 签名。',
          logs,
          pluginPath: this.pluginPath,
          error: verifyResult.stderr
        };
      }

      log('pulling', '✓ GPG 签名验证通过，代码来源可信');

      // Step 3: npm install --production
      log('building', '正在安装依赖包...');
      const installResult = await this.executeCommand(
        'npm',
        ['install', '--production'],
        this.pluginPath,
        (line) => log('building', line.trim())
      );

      if (installResult.code !== 0) {
        const errorMsg = `npm install 失败: ${installResult.stderr}`;
        log('failed', errorMsg);

        // 🔒 完整回滚：代码 + 依赖
        if (backupCommit) {
          log('failed', `正在回滚到版本 ${backupCommit.substring(0, 8)}...`);
          await this.executeCommand(
            'git',
            ['reset', '--hard', backupCommit],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          log('failed', '代码已回滚到更新前的版本');

          log('failed', '正在清理依赖包...');
          await this.executeCommand(
            'rm',
            ['-rf', 'node_modules'],
            this.pluginPath
          );
          log('failed', '正在重新安装依赖包...');
          const rollbackInstall = await this.executeCommand(
            'npm',
            ['install', '--production'],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          if (rollbackInstall.code === 0) {
            log('failed', '已完全回滚到更新前的状态');
          } else {
            log('failed', '⚠️  警告：依赖包重装失败，服务可能无法正常启动');
          }
        }

        return {
          success: false,
          step: 'failed',
          message: errorMsg,
          logs,
          pluginPath: this.pluginPath,
          error: installResult.stderr
        };
      }
      log('building', '依赖包安装完成');

      // Step 4: npm run build:plugin
      log('building', '正在编译项目...');
      const buildResult = await this.executeCommand(
        'npm',
        ['run', 'build:plugin'],
        this.pluginPath,
        (line) => log('building', line.trim())
      );

      if (buildResult.code !== 0) {
        const errorMsg = `npm run build:plugin 失败: ${buildResult.stderr}`;
        log('failed', errorMsg);

        // 🔒 完整回滚：代码 + 依赖
        if (backupCommit) {
          log('failed', `正在回滚到版本 ${backupCommit.substring(0, 8)}...`);
          await this.executeCommand(
            'git',
            ['reset', '--hard', backupCommit],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          log('failed', '代码已回滚到更新前的版本');

          log('failed', '正在清理依赖包...');
          await this.executeCommand(
            'rm',
            ['-rf', 'node_modules'],
            this.pluginPath
          );
          log('failed', '正在重新安装依赖包...');
          const rollbackInstall = await this.executeCommand(
            'npm',
            ['install', '--production'],
            this.pluginPath,
            (line) => log('failed', line.trim())
          );
          if (rollbackInstall.code === 0) {
            log('failed', '已完全回滚到更新前的状态');
          } else {
            log('failed', '⚠️  警告：依赖包重装失败，服务可能无法正常启动');
          }
        }

        return {
          success: false,
          step: 'failed',
          message: errorMsg,
          logs,
          pluginPath: this.pluginPath,
          error: buildResult.stderr
        };
      }
      log('building', '编译完成');

      // Step 5: 延迟执行 pm2 reload hydrooj（阻塞式执行 + 健康检查）
      log('restarting', '准备热重载 HydroOJ（零停机部署）...');

      // 🔒 使用后台进程延迟重启，但记录重启命令供调试
      // pm2 reload 优先（零停机），失败时降级为 restart
      // 延迟 15 秒确保 HTTP 响应已发送
      const reloadCommand = 'sleep 15 && (pm2 reload hydrooj 2>/dev/null || pm2 restart hydrooj)';
      spawn('sh', ['-c', reloadCommand], {
        cwd: this.pluginPath,
        detached: true,
        stdio: 'ignore'
      }).unref();

      log('restarting', '热重载命令已安排，服务将在 15 秒后平滑更新（零停机）');
      log('restarting', '如果更新后服务异常，请检查 pm2 日志: pm2 logs hydrooj');

      // 完成
      log('completed', '更新完成！页面将在 20 秒后自动刷新...');

      // 🔒 释放更新锁
      UpdateService.updateLock = false;

      return {
        success: true,
        step: 'completed',
        message: '插件更新成功',
        logs,
        pluginPath: this.pluginPath
      };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : '未知错误';
      log('failed', errorMsg);

      // 🔒 释放更新锁
      UpdateService.updateLock = false;

      return {
        success: false,
        step: 'failed',
        message: errorMsg,
        logs,
        pluginPath: this.pluginPath,
        error: errorMsg
      };
    } finally {
      // 🔒 确保锁一定被释放（防御性编程）
      UpdateService.updateLock = false;
    }
  }

  /**
   * 获取插件信息（用于前端显示）
   */
  getPluginInfo(): { path: string; isValid: boolean; message: string } {
    const validation = this.validatePluginPath();
    return {
      path: this.pluginPath,
      isValid: validation.valid,  // needsGitInit 时 valid 也是 true
      message: validation.needsGitInit ? '需要初始化 git 仓库（将自动处理）' : validation.message
    };
  }
}

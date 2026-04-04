/**
 * UpdateService - 插件更新服务
 *
 * 提供插件在线更新功能：
 * - 自动检测插件安装路径
 * - 自动选择最优仓库（优先 Gitee，备选 GitHub）
 * - 执行 git fetch + verify + reset 获取最新代码（防 TOCTOU）
 * - 执行 npm run build:plugin 编译
 * - 执行 pm2 restart hydrooj 重启服务
 */

import { spawn, exec, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
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
  messageKey?: string;
  messageArgs?: string[];
  logs: string[];
  pluginPath?: string;
  error?: string;
  errorKey?: string;
  errorArgs?: string[];
}

/**
 * 更新进度回调
 */
export type UpdateProgressCallback = (step: UpdateStep, messageKey: string, ...messageArgs: string[]) => void;

/**
 * 文件锁信息
 */
interface LockInfo {
  pid: number;
  timestamp: number;
}

/**
 * UpdateService 类
 */
export class UpdateService {
  private pluginPath: string;

  // 🔒 GPG 信任指纹白名单（插件发布者密钥 - 完整 40 位指纹）
  private readonly TRUSTED_GPG_FINGERPRINTS = [
    'B6115AF3D271D12AB85E843E45DACC0ECFE90852',  // AltureT <myalture@gmail.com>
    '968479A1AFF927E37D1A566BB5690EEEBB952194'   // GitHub <noreply@github.com> (web-flow merge commits)
  ];

  // 🔒 安全命令路径映射（防止 PATH 劫持）
  // 说明：优先使用绝对路径；当不存在时，回退到当前 Node 的 bin 目录（适配 nvm/pm2/npm 全局安装）。
  private readonly SAFE_COMMANDS: Record<string, string[]> = {
    git: ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'],
    npm: ['/usr/bin/npm', '/usr/local/bin/npm', '/opt/homebrew/bin/npm'],
    pm2: ['/usr/local/bin/pm2', '/usr/bin/pm2', '/opt/homebrew/bin/pm2'],
    gpg: ['/usr/bin/gpg', '/usr/local/bin/gpg', '/opt/homebrew/bin/gpg'],
    sh: ['/bin/sh', '/usr/bin/sh']
  };

  // 🔒 文件锁路径
  private readonly LOCK_FILE: string;

  // 🔒 锁超时时间（30分钟，防止死锁）
  private readonly LOCK_TIMEOUT_MS = 30 * 60 * 1000;

  // 🔒 更新锁：防止并发更新（静态变量，进程内共享）
  // 注意：此锁仅在单进程内有效，cluster 模式下依赖文件锁
  private static updateLock = false;

  /**
   * 是否运行在 PM2 托管环境中
   * - 参照 HydroOJ 官方实现 (packages/hydrooj/src/handler/manage.ts)
   * - pm2 启动时会注入 pm_cwd 环境变量
   */
  private isRunningUnderPM2(): boolean {
    return typeof process.env.pm_cwd !== 'undefined';
  }

  constructor(pluginPath?: string) {
    // 通过 __dirname 自动检测插件安装路径
    // __dirname 指向 dist 目录，需要回退到插件根目录
    const resolvedPath = pluginPath ? path.resolve(pluginPath) : path.resolve(__dirname, '../..');
    // 🔒 解析真实路径（防止 symlink 路径混淆）
    try {
      this.pluginPath = fs.realpathSync(resolvedPath);
    } catch {
      this.pluginPath = resolvedPath;
    }
    this.LOCK_FILE = path.join(this.pluginPath, '.update.lock');
  }

  /**
   * 获取插件安装路径
   */
  getPluginPath(): string {
    return this.pluginPath;
  }

  /**
   * 🔒 获取安全命令路径（防止 PATH 劫持）
   */
  private getSafeCommandPath(cmd: string): string {
    // 已是绝对路径则直接使用
    if (path.isAbsolute(cmd)) {
      return cmd;
    }

    const candidates = this.SAFE_COMMANDS[cmd] || [];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // ignore
      }
    }

    // 回退：优先使用当前 Node 的 bin 目录（适配 nvm / asdf / 自定义安装）；
    // 也能覆盖 pm2/npm 通过 npm 全局安装到 node bin 的情况。
    try {
      const nodeBin = path.dirname(process.execPath);
      if (nodeBin) {
        const nodeCandidate = path.join(nodeBin, cmd);
        if (fs.existsSync(nodeCandidate)) {
          return nodeCandidate;
        }
      }
    } catch {
      // ignore
    }

    // 最终回退：使用原始命令名（依赖最小化 PATH）
    return cmd;
  }

  /**
   * 🔒 构造安全 PATH（最小化 + 兼容 nvm/Homebrew）
   */
  private getSafePathEnv(): string {
    if (process.platform === 'win32') {
      // Windows 环境不强行覆盖 PATH，避免破坏系统查找逻辑
      return process.env.PATH || '';
    }

    const dirs: string[] = ['/usr/bin', '/usr/local/bin', '/bin'];

    // macOS Homebrew（Apple Silicon）
    if (fs.existsSync('/opt/homebrew/bin')) {
      dirs.push('/opt/homebrew/bin');
    }

    // 运行时 Node 所在目录（常见于 nvm / asdf / 自定义安装）
    try {
      const nodeBin = path.dirname(process.execPath);
      if (nodeBin) {
        dirs.push(nodeBin);
      }
    } catch {
      // ignore
    }

    return Array.from(new Set(dirs.filter(Boolean))).join(path.delimiter);
  }

  /**
   * 🔒 尝试获取文件锁（支持 cluster 模式）
   */
  private async acquireFileLock(): Promise<{ success: boolean; message?: string; messageArgs?: string[] }> {
    try {
      // 检查锁文件是否存在
      if (fs.existsSync(this.LOCK_FILE)) {
        const lockContent = await fsPromises.readFile(this.LOCK_FILE, 'utf-8');
        let lockInfo: LockInfo | null = null;
        try {
          lockInfo = JSON.parse(lockContent) as LockInfo;
        } catch {
          // 锁文件损坏：清理并继续（避免永久死锁）
          console.warn('[UpdateService] 锁文件损坏，已自动清理');
          await fsPromises.unlink(this.LOCK_FILE);
        }

        // 校验格式
        if (lockInfo && (typeof lockInfo.pid !== 'number' || typeof lockInfo.timestamp !== 'number')) {
          console.warn('[UpdateService] 锁文件格式非法，已自动清理');
          await fsPromises.unlink(this.LOCK_FILE);
          lockInfo = null;
        }

        if (lockInfo) {
          // 检查锁是否超时
          const now = Date.now();
          if (now - lockInfo.timestamp < this.LOCK_TIMEOUT_MS) {
            // 检查持有锁的进程是否仍在运行
            try {
              process.kill(lockInfo.pid, 0);  // 检查进程存在性（不发送信号）
              return {
                success: false,
                message: 'ai_helper_update_lock_in_progress',
                messageArgs: [String(lockInfo.pid)]
              };
            } catch (e: unknown) {
              const nodeErr = e as NodeJS.ErrnoException;
              if (nodeErr?.code === 'ESRCH') {
                console.log(`[UpdateService] Cleaned stale lock file (process ${lockInfo.pid} exited)`);
                await fsPromises.unlink(this.LOCK_FILE);
              } else if (nodeErr?.code === 'EPERM') {
                return {
                  success: false,
                  message: 'ai_helper_update_lock_held_by_other',
                  messageArgs: [String(lockInfo.pid)]
                };
              } else {
                return {
                  success: false,
                  message: 'ai_helper_update_lock_unknown',
                  messageArgs: [String(lockInfo.pid)]
                };
              }
            }
          } else {
            // 锁超时，清理
            console.log(`[UpdateService] 清理超时锁文件（超时 ${Math.floor((now - lockInfo.timestamp) / 1000)}s）`);
            await fsPromises.unlink(this.LOCK_FILE);
          }
        }
      }

      // 创建新锁
      const lockInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now()
      };
      await fsPromises.writeFile(this.LOCK_FILE, JSON.stringify(lockInfo), { flag: 'wx' });
      return { success: true };

    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        // 并���写入冲突，锁已被其他进程获取
        return { success: false, message: 'ai_helper_update_lock_race_condition' };
      }
      console.error('[UpdateService] File lock error:', err);
      return { success: false, message: 'ai_helper_update_lock_failed', messageArgs: [nodeErr.message] };
    }
  }

  /**
   * 🔒 释放文件锁
   */
  private async releaseFileLock(): Promise<void> {
    try {
      if (fs.existsSync(this.LOCK_FILE)) {
        const lockContent = await fsPromises.readFile(this.LOCK_FILE, 'utf-8');
        const lockInfo: LockInfo = JSON.parse(lockContent);

        // 只释放自己持有的锁
        if (lockInfo.pid === process.pid) {
          await fsPromises.unlink(this.LOCK_FILE);
        } else {
          console.warn(`[UpdateService] 锁文件被其他进程持有（PID: ${lockInfo.pid}），跳过释放`);
        }
      }
    } catch (err) {
      console.error('[UpdateService] 释放文件锁失败:', err);
    }
  }

  /**
   * 验证插件路径是否有效（不检查 git 仓库）
   */
  validatePluginPath(): { valid: boolean; message: string; messageArgs?: string[]; needsGitInit: boolean } {
    // 检查路径是否存在
    if (!fs.existsSync(this.pluginPath)) {
      return { valid: false, message: 'ai_helper_update_path_not_found', messageArgs: [this.pluginPath], needsGitInit: false };
    }

    const packageJsonPath = path.join(this.pluginPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { valid: false, message: 'ai_helper_update_package_json_not_found', messageArgs: [packageJsonPath], needsGitInit: false };
    }

    const gitPath = path.join(this.pluginPath, '.git');
    if (!fs.existsSync(gitPath)) {
      return { valid: true, message: 'ai_helper_update_needs_git_init', needsGitInit: true };
    }

    return { valid: true, message: 'ai_helper_update_path_valid', needsGitInit: false };
  }

  /**
   * 🔒 写权限预检（避免更新过程中途失败）
   */
  private async checkWritePermission(onLog?: (msg: string) => void): Promise<{ ok: boolean; message?: string; messageArgs?: string[] }> {
    const log = (msg: string) => onLog?.(msg);
    try {
      await fsPromises.access(this.pluginPath, fs.constants.W_OK);

      // 额外探测：确保可创建/删除文件（覆盖部分挂载/ACL 场景）
      const probeName = `.update.writecheck.${process.pid}.${Date.now()}`;
      const probePath = path.join(this.pluginPath, probeName);
      try {
        const fh = await fsPromises.open(probePath, 'wx');
        await fh.close();
      } finally {
        try {
          if (fs.existsSync(probePath)) {
            await fsPromises.unlink(probePath);
          }
        } catch {
          // ignore
        }
      }

      const gitDir = path.join(this.pluginPath, '.git');
      if (fs.existsSync(gitDir)) {
        await fsPromises.access(gitDir, fs.constants.W_OK);
      }

      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      log(`ai_helper_update_write_check_failed: ${msg}`);
      return { ok: false, message: 'ai_helper_update_no_write_permission', messageArgs: [msg] };
    }
  }

  /**
   * 初始化 git 仓库并拉取代码
   */
  private async initGitRepo(repoUrl: string, onLog?: (msg: string) => void, fallbackRepoUrls?: Array<{ name: string; url: string }>): Promise<boolean> {
    const log = (msg: string) => onLog?.(msg);

    log('ai_helper_update_not_git_repo_initializing');

    log('ai_helper_update_running_git_init');
    const initResult = await this.executeCommand('git', ['init'], this.pluginPath, undefined, 300000);
    if (initResult.code !== 0) {
      log(`git init failed: ${initResult.stderr}`);
      return false;
    }

    log(`ai_helper_update_adding_remote: ${repoUrl}`);
    const remoteResult = await this.executeCommand('git', ['remote', 'add', 'origin', repoUrl], this.pluginPath, undefined, 300000);
    if (remoteResult.code !== 0) {
      const setUrlResult = await this.executeCommand('git', ['remote', 'set-url', 'origin', repoUrl], this.pluginPath, undefined, 300000);
      if (setUrlResult.code !== 0) {
        log(`ai_helper_update_set_remote_failed: ${setUrlResult.stderr}`);
        return false;
      }
    }

    log('ai_helper_update_fetching_remote');
    let fetchResult = await this.executeCommand(
      'git',
      ['fetch', '--prune', 'origin', 'main'],
      this.pluginPath,
      (line) => log(line.trim()),
      300000
    );

    if (fetchResult.code !== 0 && fallbackRepoUrls && fallbackRepoUrls.length > 0) {
      log(`ai_helper_update_fetch_failed: ${fetchResult.stderr}`);
      for (const repo of fallbackRepoUrls) {
        if (repo.url === repoUrl) continue;
        log(`ai_helper_update_trying_fallback: ${repo.name} (${repo.url})`);
        await this.executeCommand('git', ['remote', 'set-url', 'origin', repo.url], this.pluginPath, undefined, 300000);
        fetchResult = await this.executeCommand(
          'git',
          ['fetch', '--prune', 'origin', 'main'],
          this.pluginPath,
          (line) => log(line.trim()),
          300000
        );
        if (fetchResult.code === 0) {
          log(`ai_helper_update_fallback_success: ${repo.name}`);
          break;
        }
        log(`${repo.name} fetch failed: ${fetchResult.stderr}`);
      }
    }

    if (fetchResult.code !== 0) {
      log(`ai_helper_update_all_fetch_failed: ${fetchResult.stderr}`);
      return false;
    }

    log('ai_helper_update_git_init_complete');
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
        log('ai_helper_update_network_cn');
        return 'cn';
      }
      if (googleOk) {
        log('ai_helper_update_network_global');
        return 'global';
      }
      log('ai_helper_update_network_detect_failed');
      return 'unknown';
    } catch {
      log('ai_helper_update_network_detect_error');
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

    log('ai_helper_update_detecting_best_repo');

    const region = await this.detectNetworkRegion(onLog);
    const orderedRepos = this.getRepoOrder(region);

    for (const repo of orderedRepos) {
      log(`ai_helper_update_testing_repo: ${repo.name}`);
      const latency = await this.testRepoLatency(repo);

      if (latency > 0) {
        log(`${repo.name}: ${latency}ms ✓`);
        return { name: repo.name, url: repo.url, latency };
      } else {
        log(`ai_helper_update_repo_failed: ${repo.name}`);
      }
    }

    log('ai_helper_update_all_repos_failed');
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
      log('ai_helper_update_no_sudo');
      return null;
    }

    const sudoCheck = await this.runShellCommand('sudo -n true', this.pluginPath);
    if (sudoCheck.code !== 0) {
      log('ai_helper_update_no_passwordless_sudo');
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
      linux: 'ai_helper_update_install_git_linux',
      darwin: 'ai_helper_update_install_git_macos',
      win32: 'ai_helper_update_install_git_windows'
    };

    const guide = installGuides[platform as keyof typeof installGuides] || 'ai_helper_update_install_git_generic';
    log(guide);

    return {
      ok: false,
      message: 'ai_helper_update_git_manual_install_required'
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

    log('ai_helper_update_checking_git');
    if (await this.isGitInstalled()) {
      log('ai_helper_update_git_installed');
      return { ok: true };
    }

    log('ai_helper_update_git_not_found');
    const installResult = await this.installGit(region, onLog);
    if (!installResult.ok) {
      return { ok: false, message: installResult.message || 'ai_helper_update_git_install_failed' };
    }

    if (await this.isGitInstalled()) {
      log('ai_helper_update_git_install_complete');
      return { ok: true };
    }

    return { ok: false, message: 'ai_helper_update_git_installed_but_unusable' };
  }

  /**
   * 是否允许在一键更新中执行 npm install scripts
   * - 默认禁用（更安全）：避免依赖包中的 install/postinstall 脚本在服务器上执行
   * - 如确需启用：设置环境变量 AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS=1
   */
  private allowNpmScriptsOnUpdate(): boolean {
    const raw = (process.env.AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS || '').trim();
    return raw === '1' || raw.toLowerCase() === 'true';
  }

  /**
   * 🔒 安装依赖（优先 npm ci，失败时回退 npm install；默认禁用 scripts）
   */
  private async installDependencies(
    onOutput?: (line: string) => void,
    timeoutMs: number = 300000
  ): Promise<{ code: number; stdout: string; stderr: string; usedCi: boolean; ignoreScripts: boolean }> {
    const ignoreScripts = !this.allowNpmScriptsOnUpdate();
    const env: NodeJS.ProcessEnv = {
      // 关键：即便服务进程 NODE_ENV=production，也要安装 devDependencies（tsc 需要）
      NODE_ENV: 'development',
      NPM_CONFIG_PRODUCTION: 'false',
      // 降低噪音/外部请求
      NPM_CONFIG_AUDIT: 'false',
      NPM_CONFIG_FUND: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false'
    };

    const lockPath = path.join(this.pluginPath, 'package-lock.json');
    const hasLock = fs.existsSync(lockPath);

    const runNpm = async (args: string[], usedCi: boolean) => {
      const finalArgs = ignoreScripts ? [...args, '--ignore-scripts'] : args;
      const result = await this.executeCommand('npm', finalArgs, this.pluginPath, onOutput, timeoutMs, env);
      return { ...result, usedCi };
    };

    // 优先使用 npm ci（更可复现）
    if (hasLock) {
      const ciResult = await runNpm(['ci'], true);
      if (ciResult.code === 0) {
        return { ...ciResult, ignoreScripts };
      }

      // 回退到 npm install（兼容 package-lock 不一致等情况）
      onOutput?.('ai_helper_update_npm_ci_fallback');
      const installResult = await runNpm(['install'], false);
      return { ...installResult, ignoreScripts };
    }

    // 没有 lock：清理旧依赖，避免残留导致运行时异常
    try {
      const nodeModulesPath = path.join(this.pluginPath, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        onOutput?.('ai_helper_update_cleaning_old_deps');
        await fsPromises.rm(nodeModulesPath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }

    const installResult = await runNpm(['install'], false);
    return { ...installResult, ignoreScripts };
  }

  /**
   * 🔒 原子化构建 dist：先构建到临时目录，再用 rename 原子替换
   */
  private async buildPluginAtomically(
    onOutput?: (line: string) => void,
    timeoutMs: number = 300000
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const distDir = path.join(this.pluginPath, 'dist');
    const tmpDir = path.join(this.pluginPath, `.dist.tmp.${process.pid}.${Date.now()}`);
    const backupDir = path.join(this.pluginPath, `.dist.backup.${process.pid}.${Date.now()}`);

    const safeRm = async (p: string) => {
      try {
        await fsPromises.rm(p, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    // 清理可能残留的临时目录
    await safeRm(tmpDir);

    const buildResult = await this.executeCommand(
      'npm',
      ['run', 'build:plugin', '--', '--outDir', tmpDir],
      this.pluginPath,
      onOutput,
      timeoutMs
    );

    if (buildResult.code !== 0) {
      await safeRm(tmpDir);
      return buildResult;
    }

    let backupCreated = false;
    try {
      if (fs.existsSync(distDir)) {
        await fsPromises.rename(distDir, backupDir);
        backupCreated = true;
      }

      await fsPromises.rename(tmpDir, distDir);

      if (backupCreated) {
        await safeRm(backupDir);
      }

      return buildResult;
    } catch (err) {
      // 尝试恢复旧 dist（防御性：避免 dist 丢失）
      try {
        if (!fs.existsSync(distDir) && backupCreated && fs.existsSync(backupDir)) {
          await fsPromises.rename(backupDir, distDir);
        }
      } catch {
        // ignore
      }

      await safeRm(tmpDir);
      return {
        code: 1,
        stdout: buildResult.stdout || '',
        stderr: `Atomic build swap failed: ${err instanceof Error ? err.message : 'unknown error'}`
      };
    }
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
      log(`ai_helper_update_remote_already_set: ${url}`);
      return true;
    }

    log(`ai_helper_update_switching_remote: ${currentUrl} -> ${url}`);
    const setResult = await this.executeCommand('git', ['remote', 'set-url', 'origin', url], this.pluginPath);

    if (setResult.code !== 0) {
      log(`ai_helper_update_set_remote_failed: ${setResult.stderr}`);
      return false;
    }

    log('ai_helper_update_remote_switch_success');
    return true;
  }

  /**
   * 🔒 验证 GPG 签名并检查指纹白名单
   */
  private async verifyGPGSignature(
    ref: string,
    onLog?: (msg: string) => void
  ): Promise<{ valid: boolean; error?: string; errorArgs?: string[] }> {
    const log = (msg: string) => onLog?.(msg);

    // 🔒 使用隔离的 GNUPGHOME（避免污染系统密钥环；也避免服务用户无写入 ~/.gnupg 导致验证失败）
    const gpgHomePrefix = path.join(os.tmpdir(), 'hydro-ai-helper-gpg-');
    let gpgHome = '';

    const safeRmDir = async (dir: string) => {
      try {
        if (dir) {
          await fsPromises.rm(dir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    };

    try {
      gpgHome = await fsPromises.mkdtemp(gpgHomePrefix);
      try {
        await fsPromises.chmod(gpgHome, 0o700);
      } catch {
        // ignore
      }

      const env = { GNUPGHOME: gpgHome };

      // Step 0: 确保 gpg 可用
      const gpgVersion = await this.executeCommand('gpg', ['--version'], this.pluginPath, undefined, 15000, env);
      if (gpgVersion.code !== 0) {
        return {
          valid: false,
          error: 'ai_helper_update_gpg_not_found'
        };
      }

      // Step 1: 导入信任的公钥
      const publicKeyPath = path.join(this.pluginPath, 'assets/trusted-keys/publisher.asc');

      if (fs.existsSync(publicKeyPath)) {
        log('ai_helper_update_importing_pubkey');
        const importResult = await this.executeCommand(
          'gpg',
          ['--batch', '--yes', '--import', publicKeyPath],
          this.pluginPath,
          undefined,
          60000,
          env
        );

        if (importResult.code === 0) {
          log('ai_helper_update_pubkey_imported');
        } else {
          log(`ai_helper_update_pubkey_import_warning: ${(importResult.stderr || importResult.stdout || '').substring(0, 200)}`);
        }
      } else {
        log('ai_helper_update_pubkey_file_missing');
      }

      // Step 2: 验证 commit 签名并获取指纹
      // 🔒 使用 git verify-commit 而非 gpg（git 命令会调用 gpg）
      const gpgPath = this.getSafeCommandPath('gpg');
      const verifyResult = await this.executeCommand(
        'git',
        ['-c', `gpg.program=${gpgPath}`, 'verify-commit', '--raw', ref],
        this.pluginPath,
        undefined,
        60000,
        env
      );

      const combinedOutput = `${verifyResult.stdout || ''}\n${verifyResult.stderr || ''}`;

      // Step 3: 检查验证结果
      if (verifyResult.code !== 0) {
        // 无签名或签名无效
        if (
          combinedOutput.includes('no signature found') ||
          combinedOutput.includes('no valid OpenPGP data found') ||
          combinedOutput.includes('[GNUPG:] NODATA')
        ) {
          return {
            valid: false,
            error: 'ai_helper_update_gpg_no_signature'
          };
        }

        if (combinedOutput.includes('BAD signature') || combinedOutput.includes('[GNUPG:] BADSIG')) {
          return {
            valid: false,
            error: 'ai_helper_update_gpg_bad_signature'
          };
        }

        if (combinedOutput.includes('NO_PUBKEY')) {
          return {
            valid: false,
            error: 'ai_helper_update_gpg_no_pubkey'
          };
        }

        return {
          valid: false,
          error: `GPG verification failed: ${(verifyResult.stderr || verifyResult.stdout || '').substring(0, 400)}`
        };
      }

      // Step 4: 提取签名指纹（优先 primary key fpr；完整 40 位，防止密钥 ID 碰撞）
      const { signingFingerprint, primaryFingerprint } = this.extractGpgFingerprints(combinedOutput);
      const fingerprint = primaryFingerprint || signingFingerprint;

      if (!fingerprint) {
        return {
          valid: false,
          error: 'ai_helper_update_gpg_no_fingerprint'
        };
      }

      if (primaryFingerprint && signingFingerprint && primaryFingerprint !== signingFingerprint) {
        log(`Signing fingerprint: ${signingFingerprint} (subkey)`);
        log(`Primary key fingerprint: ${primaryFingerprint} (primary)`);
      } else {
        log(`Signing fingerprint: ${fingerprint}`);
      }

      if (!this.TRUSTED_GPG_FINGERPRINTS.includes(fingerprint)) {
        return {
          valid: false,
          error: 'ai_helper_update_gpg_untrusted_fingerprint',
          errorArgs: [fingerprint]
        };
      }

      log(`ai_helper_update_gpg_verified: ${fingerprint}`);
      return { valid: true };

    } catch (err) {
      return {
        valid: false,
        error: `GPG verification error: ${err instanceof Error ? err.message : 'unknown error'}`
      };
    } finally {
      await safeRmDir(gpgHome);
    }
  }

  /**
   * 从 git verify-commit --raw 输出中提取指纹
   * - signingFingerprint: 签名子密钥指纹（可能为 subkey）
   * - primaryFingerprint: 主密钥指纹（若可解析到）
   */
  private extractGpgFingerprints(output: string): { signingFingerprint?: string; primaryFingerprint?: string } {
    const lines = output.split(/\r?\n/);
    let signingFingerprint: string | undefined;
    let primaryFingerprint: string | undefined;

    // 优先解析 PRIMARY_KEY_FPR
    for (const line of lines) {
      const match = line.match(/\[GNUPG:\]\s*PRIMARY_KEY_FPR\s+([0-9A-F]{40})/i);
      if (match) {
        primaryFingerprint = match[1].toUpperCase();
        break;
      }
    }

    // 解析 VALIDSIG（格式：VALIDSIG <signing_fpr> ... <primary_fpr>）
    for (const line of lines) {
      if (!line.includes('[GNUPG:]')) continue;
      if (!line.includes('VALIDSIG')) continue;

      const parts = line.trim().split(/\s+/);
      const validSigIndex = parts.findIndex((p) => p === 'VALIDSIG');
      if (validSigIndex < 0) continue;

      const maybeSigning = parts[validSigIndex + 1];
      if (maybeSigning && /^[0-9A-F]{40}$/i.test(maybeSigning)) {
        signingFingerprint = maybeSigning.toUpperCase();
      }

      const last = parts[parts.length - 1];
      if (last && /^[0-9A-F]{40}$/i.test(last)) {
        primaryFingerprint = primaryFingerprint || last.toUpperCase();
      }
      break;
    }

    // 🔒 不再使用 fallback 匹配：防止从 commit message 等可控文本中提取指纹绕过白名单
    // 仅信任 [GNUPG:] 状态行中的指纹

    return { signingFingerprint, primaryFingerprint };
  }

  /**
   * ��行命令并返回 Promise
   */
  private executeCommand(
    command: string,
    args: string[],
    cwd: string,
    onOutput?: (line: string) => void,
    timeout?: number,  // 超时时间（毫秒）
    envOverrides?: NodeJS.ProcessEnv
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      // 🔒 使用安全命令路径（防止 PATH 劫持）
      const safeCommand = this.getSafeCommandPath(command);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ...envOverrides,
        PATH: this.getSafePathEnv()  // 🔒 最小化 PATH（并兼容 nvm/Homebrew）
      };
      // 🔒 清理 GIT_* 环境变量（防止 GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* 劫持）
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) {
          delete env[key];
        }
      }
      // 🔒 禁止 git 弹出凭据提示（非交互环境下防止阻塞）
      env.GIT_TERMINAL_PROMPT = '0';

      const proc: ChildProcess = spawn(safeCommand, args, {
        cwd,
        shell: false,  // 🔒 禁用 shell：防止命令注入风险
        env,
        // 🔒 让子进程成为新的进程组 leader，便于超时后 kill 整个子进程树（POSIX）
        detached: process.platform !== 'win32'
      });

      let stdout = '';
      let stderr = '';
      let timeoutHandle: NodeJS.Timeout | null = null;
      let killed = false;

      // 🔒 超时机制（防止进程挂起导致 DoS）
      if (timeout && timeout > 0) {
        timeoutHandle = setTimeout(() => {
          // 若进程已退出（exitCode 已有值），则不再执行超时杀进程逻辑
          if (!killed && proc.pid && proc.exitCode === null) {
            killed = true;
            const pid = proc.pid;

            // 🔒 优先杀死整个进程组（包含子进程），避免 npm/git 等派生子进程在后台继续运行
            if (process.platform !== 'win32') {
              try {
                process.kill(-pid, 'SIGTERM');
              } catch {
                try {
                  proc.kill('SIGTERM');
                } catch {
                  // ignore
                }
              }
            } else {
              // Windows 无法通过负 PID 杀进程组：先尝试 taskkill /T，失败再退回 kill 单进程
              try {
                spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
                  cwd,
                  shell: false,
                  env
                });
              } catch {
                try {
                  proc.kill('SIGTERM');
                } catch {
                  // ignore
                }
              }
            }

            setTimeout(() => {
              // SIGTERM 后 5 秒仍未退出：强制 KILL（仅在进程仍在运行时）
              if (proc.exitCode !== null) return;
              if (process.platform !== 'win32') {
                try {
                  process.kill(-pid, 'SIGKILL');
                } catch {
                  try {
                    proc.kill('SIGKILL');
                  } catch {
                    // ignore
                  }
                }
              } else {
                try {
                  proc.kill('SIGKILL');
                } catch {
                  // ignore
                }
              }
            }, 5000);  // 5秒后强制 KILL
          }
        }, timeout);
      }

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
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (killed) {
          resolve({ code: 124, stdout, stderr: stderr + '\nCommand timed out and was terminated' });
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });

      proc.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        stderr += err.message;
        resolve({ code: 1, stdout, stderr });
      });
    });
  }

  /**
   * 🔒 完整回滚：代码 + 依赖 + dist（用于更新失败的安全兜底）
   */
  private async rollback(backupCommit: string, onLog: (msg: string, ...args: string[]) => void): Promise<void> {
    const log = (msg: string, ...args: string[]) => onLog(msg, ...args);
    if (!backupCommit) return;

    log('ai_helper_update_rolling_back', backupCommit.substring(0, 8));
    await this.executeCommand(
      'git',
      ['reset', '--hard', backupCommit],
      this.pluginPath,
      (line) => log(line.trim()),
      300000
    );
    log('ai_helper_update_code_rolled_back');

    log('ai_helper_update_cleaning_deps');
    try {
      const nodeModulesPath = path.join(this.pluginPath, 'node_modules');
      if (fs.existsSync(nodeModulesPath)) {
        await fsPromises.rm(nodeModulesPath, { recursive: true, force: true });
      }
      log('ai_helper_update_deps_cleaned');
    } catch (rmErr) {
      log(`ai_helper_update_deps_clean_warning: ${rmErr instanceof Error ? rmErr.message : 'unknown error'}`);
    }

    log('ai_helper_update_reinstalling_deps');
    const rollbackInstall = await this.installDependencies(
      (line) => log(line.trim()),
      300000
    );
    if (rollbackInstall.code === 0) {
      log('ai_helper_update_deps_restored');
    } else {
      log('ai_helper_update_deps_reinstall_failed');
      return;
    }

    log('ai_helper_update_rebuilding_dist');
    const rebuild = await this.buildPluginAtomically((line) => log(line.trim()), 300000);
    if (rebuild.code === 0) {
      log('ai_helper_update_dist_rebuilt');
      log('ai_helper_update_fully_rolled_back');
    } else {
      log('ai_helper_update_dist_rebuild_failed');
    }
  }

  /**
   * 执行完整更新流程
   */
  async performUpdate(onProgress?: UpdateProgressCallback): Promise<UpdateResult> {
    // 🔒 检查进程内更新锁：快速拒绝并发请求
    if (UpdateService.updateLock) {
      return {
        success: false,
        step: 'failed',
        message: 'ai_helper_update_concurrent_in_memory',
        messageKey: 'ai_helper_update_concurrent_in_memory',
        logs: [],
        pluginPath: this.pluginPath,
        error: 'ai_helper_update_concurrent_rejected_in_memory',
        errorKey: 'ai_helper_update_concurrent_rejected_in_memory'
      };
    }

    // 🔒 获取文件锁：支持 cluster 模式的跨进程锁
    const fileLockResult = await this.acquireFileLock();
    if (!fileLockResult.success) {
      return {
        success: false,
        step: 'failed',
        message: fileLockResult.message || 'ai_helper_update_cannot_acquire_lock',
        messageKey: fileLockResult.message || 'ai_helper_update_cannot_acquire_lock',
        messageArgs: fileLockResult.messageArgs,
        logs: [],
        pluginPath: this.pluginPath,
        error: 'ai_helper_update_concurrent_rejected_file_lock',
        errorKey: 'ai_helper_update_concurrent_rejected_file_lock'
      };
    }

    // 设置进程内更新锁
    UpdateService.updateLock = true;

    const logs: string[] = [];
    const log = (step: UpdateStep, messageKey: string, ...messageArgs: string[]) => {
      logs.push(`[${step}] ${messageKey}`);
      if (onProgress) onProgress(step, messageKey, ...messageArgs);
    };

    // 用于失败回滚的备份 commit（在函数作用域声明）
    let backupCommit = '';
    // 🔒 成功更新时延后释放文件锁（等待 pm2 restart 完成，避免竞态窗口）
    let deferFileLockRelease = false;

    try {
      // Step 1: 验证路径
      log('detecting', 'ai_helper_update_detecting_path', this.pluginPath);
      const validation = this.validatePluginPath();
      if (!validation.valid) {
        log('failed', validation.message, ...(validation.messageArgs || []));
        return {
          success: false,
          step: 'failed',
          message: validation.message,
          messageKey: validation.message,
          messageArgs: validation.messageArgs,
          logs,
          pluginPath: this.pluginPath,
          error: validation.message,
          errorKey: validation.message,
          errorArgs: validation.messageArgs
        };
      }
      log('detecting', validation.message, ...(validation.messageArgs || []));

      log('detecting', 'ai_helper_update_checking_write_permission');
      const writeCheck = await this.checkWritePermission((msg) => log('detecting', msg));
      if (!writeCheck.ok) {
        const msg = writeCheck.message || 'ai_helper_update_write_check_failed';
        const args = writeCheck.messageArgs;
        log('failed', msg, ...(args || []));
        return {
          success: false,
          step: 'failed',
          message: msg,
          messageKey: msg,
          messageArgs: args,
          logs,
          pluginPath: this.pluginPath,
          error: msg,
          errorKey: msg,
          errorArgs: args
        };
      }

      log('detecting', 'ai_helper_update_detecting_network');
      const region = await this.detectNetworkRegion((msg) => log('detecting', msg));

      const gitCheck = await this.ensureGitInstalled(region, (msg) => log('detecting', msg));
      if (!gitCheck.ok) {
        const msg = gitCheck.message || 'ai_helper_update_git_not_installed';
        log('failed', msg);
        return {
          success: false,
          step: 'failed',
          message: msg,
          messageKey: msg,
          logs,
          pluginPath: this.pluginPath,
          error: msg,
          errorKey: msg
        };
      }

      if (!validation.needsGitInit) {
        log('detecting', 'ai_helper_update_verifying_git_root');
        const topLevelResult = await this.executeCommand('git', ['rev-parse', '--show-toplevel'], this.pluginPath);
        if (topLevelResult.code !== 0) {
          const detail = topLevelResult.stderr || topLevelResult.stdout;
          log('failed', 'ai_helper_update_git_detect_failed', detail);
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_git_detect_failed',
            messageKey: 'ai_helper_update_git_detect_failed',
            messageArgs: [detail],
            logs,
            pluginPath: this.pluginPath,
            error: 'ai_helper_update_git_detect_failed',
            errorKey: 'ai_helper_update_git_detect_failed',
            errorArgs: [detail]
          };
        }

        const rawTopLevel = topLevelResult.stdout.trim();
        let realTopLevel = rawTopLevel;
        try {
          realTopLevel = fs.realpathSync(rawTopLevel);
        } catch {
          // ignore
        }
        if (realTopLevel !== this.pluginPath) {
          log('failed', 'ai_helper_update_not_git_root', rawTopLevel);
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_not_git_root',
            messageKey: 'ai_helper_update_not_git_root',
            messageArgs: [rawTopLevel],
            logs,
            pluginPath: this.pluginPath,
            error: 'ai_helper_update_not_git_root',
            errorKey: 'ai_helper_update_not_git_root',
            errorArgs: [rawTopLevel]
          };
        }
      }

      const orderedRepos = this.getRepoOrder(region);
      log('detecting', 'ai_helper_update_testing_repos');

      let selectedRepo: RepoSelection | null = null;
      for (const repo of orderedRepos) {
        log('detecting', 'ai_helper_update_testing_repo', repo.name);
        const latency = await this.testRepoLatency(repo);
        if (latency > 0) {
          log('detecting', 'ai_helper_update_repo_latency', repo.name, `${latency}ms`);
          selectedRepo = { name: repo.name, url: repo.url, latency };
          break;
        } else {
          log('detecting', 'ai_helper_update_repo_connect_failed', repo.name);
        }
      }

      if (!selectedRepo) {
        log('detecting', 'ai_helper_update_all_repos_failed');
        selectedRepo = { name: orderedRepos[0].name, url: orderedRepos[0].url, latency: -1 };
      }

      log('detecting', 'ai_helper_update_using_repo', selectedRepo.name, selectedRepo.url);

      if (validation.needsGitInit) {
        const initSuccess = await this.initGitRepo(selectedRepo.url, (msg) => log('detecting', msg), orderedRepos);
        if (!initSuccess) {
          log('failed', 'ai_helper_update_git_init_failed');
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_git_init_failed',
            messageKey: 'ai_helper_update_git_init_failed',
            logs,
            pluginPath: this.pluginPath,
            error: 'ai_helper_update_git_init_failed',
            errorKey: 'ai_helper_update_git_init_failed'
          };
        }
        log('pulling', 'ai_helper_update_remote_fetched_pending_verify');
      } else {
        const remoteSet = await this.setRemoteOrigin(selectedRepo.url, (msg) => log('detecting', msg));
        if (!remoteSet) {
          log('failed', 'ai_helper_update_set_remote_failed');
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_set_remote_failed',
            messageKey: 'ai_helper_update_set_remote_failed',
            logs,
            pluginPath: this.pluginPath,
            error: 'ai_helper_update_set_remote_failed',
            errorKey: 'ai_helper_update_set_remote_failed'
          };
        }

        log('pulling', 'ai_helper_update_backing_up_version');
        const backupResult = await this.executeCommand(
          'git',
          ['rev-parse', 'HEAD'],
          this.pluginPath
        );

        if (backupResult.code === 0) {
          backupCommit = backupResult.stdout.trim();
          log('pulling', 'ai_helper_update_current_version', backupCommit.substring(0, 8));
        } else {
          const detail = (backupResult.stderr || backupResult.stdout || 'unknown error').trim();
          log('failed', 'ai_helper_update_cannot_get_version', detail);
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_cannot_get_version',
            messageKey: 'ai_helper_update_cannot_get_version',
            messageArgs: [detail],
            logs,
            pluginPath: this.pluginPath,
            error: 'ai_helper_update_cannot_get_version',
            errorKey: 'ai_helper_update_cannot_get_version',
            errorArgs: [detail]
          };
        }

        log('pulling', 'ai_helper_update_resetting_local');
        const resetResult = await this.executeCommand(
          'git',
          ['reset', '--hard', 'HEAD'],
          this.pluginPath,
          (line) => log('pulling', line.trim()),
          300000
        );
        if (resetResult.code !== 0) {
          log('pulling', `git reset warning: ${resetResult.stderr}`);
        }

        log('pulling', 'ai_helper_update_fetching_latest');
        let fetchResult = await this.executeCommand(
          'git',
          ['fetch', '--prune', 'origin', 'main'],
          this.pluginPath,
          (line) => log('pulling', line.trim()),
          300000
        );

        if (fetchResult.code !== 0) {
          log('pulling', 'ai_helper_update_fetch_failed', fetchResult.stderr);
          let fallbackSuccess = false;
          for (const repo of orderedRepos) {
            if (repo.url === selectedRepo.url) continue;
            log('pulling', 'ai_helper_update_trying_fallback', repo.name, repo.url);
            const setResult = await this.setRemoteOrigin(repo.url, (msg) => log('pulling', msg));
            if (!setResult) continue;
            fetchResult = await this.executeCommand(
              'git',
              ['fetch', '--prune', 'origin', 'main'],
              this.pluginPath,
              (line) => log('pulling', line.trim()),
              300000
            );
            if (fetchResult.code === 0) {
              log('pulling', 'ai_helper_update_fallback_success', repo.name);
              fallbackSuccess = true;
              break;
            }
            log('pulling', `${repo.name} fetch failed: ${fetchResult.stderr}`);
          }
          if (!fallbackSuccess) {
            log('failed', 'ai_helper_update_all_fetch_failed', fetchResult.stderr);
            return {
              success: false,
              step: 'failed',
              message: 'ai_helper_update_all_fetch_failed',
              messageKey: 'ai_helper_update_all_fetch_failed',
              messageArgs: [fetchResult.stderr],
              logs,
              pluginPath: this.pluginPath,
              error: fetchResult.stderr
            };
          }
        }
        log('pulling', 'ai_helper_update_fetch_complete');
      }

      // Step 2.4: 获取远程 main 的具体 commit hash（防止 TOCTOU：后续只对该 hash 做验证和切换）
      log('pulling', 'ai_helper_update_resolving_remote');
      const revParseResult = await this.executeCommand(
        'git',
        ['rev-parse', '--verify', 'origin/main'],
        this.pluginPath,
        undefined,
        15000
      );
      if (revParseResult.code !== 0) {
        const detail = revParseResult.stderr || revParseResult.stdout;
        log('failed', 'ai_helper_update_cannot_resolve_remote', detail);
        return {
          success: false,
          step: 'failed',
          message: 'ai_helper_update_cannot_resolve_remote',
          messageKey: 'ai_helper_update_cannot_resolve_remote',
          messageArgs: [detail],
          logs,
          pluginPath: this.pluginPath,
          error: detail
        };
      }
      const targetCommit = revParseResult.stdout.trim();
      log('pulling', 'ai_helper_update_remote_version', targetCommit.substring(0, 8));

      log('pulling', 'ai_helper_update_verifying_signature');
      const verifyRef = targetCommit;
      const gpgVerifyResult = await this.verifyGPGSignature(verifyRef, (msg) => log('pulling', msg));

      if (!gpgVerifyResult.valid) {
        log('failed', 'ai_helper_update_signature_failed', gpgVerifyResult.error || '');

        if (backupCommit) {
          await this.rollback(backupCommit, (m) => log('failed', m));
        } else {
          log('failed', 'ai_helper_update_no_backup_cannot_rollback');
          log('failed', 'ai_helper_update_check_git_status_hint');
        }

        return {
          success: false,
          step: 'failed',
          message: 'ai_helper_update_signature_failed',
          messageKey: 'ai_helper_update_signature_failed',
          messageArgs: [gpgVerifyResult.error || ''],
          logs,
          pluginPath: this.pluginPath,
          error: gpgVerifyResult.error,
          errorKey: gpgVerifyResult.error
        };
      }

      log('pulling', 'ai_helper_update_gpg_passed');

      log('pulling', 'ai_helper_update_switching_to_latest');
      if (validation.needsGitInit) {
        // 新初始化的仓库中，yarn 安装的文件是 untracked 状态
        // 使用 git clean + checkout -f 强制切换，避免 untracked 文件冲突
        // 这是安全的：签名已验证通过，且 reset --hard 紧随其后会确保最终状态正确
        await this.executeCommand(
          'git', ['clean', '-fd'],
          this.pluginPath, undefined, 60000
        );
        const checkoutResult = await this.executeCommand(
          'git',
          ['checkout', '-f', '-B', 'main', targetCommit],
          this.pluginPath,
          (line) => log('pulling', line.trim()),
          300000  // 🔒 5 分钟超时
        );
        if (checkoutResult.code !== 0) {
          log('failed', 'ai_helper_update_checkout_failed', checkoutResult.stderr);
          return {
            success: false,
            step: 'failed',
            message: 'ai_helper_update_checkout_failed',
            messageKey: 'ai_helper_update_checkout_failed',
            messageArgs: [checkoutResult.stderr],
            logs,
            pluginPath: this.pluginPath,
            error: checkoutResult.stderr
          };
        }
      }

      const resetToVerified = await this.executeCommand(
        'git',
        ['reset', '--hard', targetCommit],
        this.pluginPath,
        (line) => log('pulling', line.trim()),
        300000  // 🔒 5 分钟超时
      );
      if (resetToVerified.code !== 0) {
        log('failed', 'ai_helper_update_reset_to_latest_failed', resetToVerified.stderr);
        if (backupCommit) {
          await this.rollback(backupCommit, (m) => log('failed', m));
        }
        return {
          success: false,
          step: 'failed',
          message: 'ai_helper_update_reset_to_latest_failed',
          messageKey: 'ai_helper_update_reset_to_latest_failed',
          messageArgs: [resetToVerified.stderr],
          logs,
          pluginPath: this.pluginPath,
          error: resetToVerified.stderr
        };
      }
      log('pulling', 'ai_helper_update_pull_complete');

      log('building', 'ai_helper_update_installing_deps');
      const installResult = await this.installDependencies(
        (line) => log('building', line.trim()),
        300000
      );

      if (installResult.code !== 0) {
        const errorMsgKey = installResult.ignoreScripts
          ? 'ai_helper_update_deps_install_failed_scripts_hint'
          : 'ai_helper_update_deps_install_failed';
        log('failed', errorMsgKey, installResult.stderr);

        // 🔒 完整回滚：代码 + 依赖
        if (backupCommit) {
          await this.rollback(backupCommit, (m) => log('failed', m));
        }

        return {
          success: false,
          step: 'failed',
          message: errorMsgKey,
          messageKey: errorMsgKey,
          messageArgs: [installResult.stderr],
          logs,
          pluginPath: this.pluginPath,
          error: installResult.stderr
        };
      }
      log('building', 'ai_helper_update_deps_installed');

      log('building', 'ai_helper_update_building');
      const buildResult = await this.buildPluginAtomically(
        (line) => log('building', line.trim()),
        300000
      );

      if (buildResult.code !== 0) {
        log('failed', 'ai_helper_update_build_failed', buildResult.stderr);

        if (backupCommit) {
          await this.rollback(backupCommit, (m) => log('failed', m));
        }

        return {
          success: false,
          step: 'failed',
          message: 'ai_helper_update_build_failed',
          messageKey: 'ai_helper_update_build_failed',
          messageArgs: [buildResult.stderr],
          logs,
          pluginPath: this.pluginPath,
          error: buildResult.stderr
        };
      }
      log('building', 'ai_helper_update_build_complete');

      log('restarting', 'ai_helper_update_preparing_restart');

      // 延迟执行确保 HTTP 响应已发送（避免前端请求中断）
      const restartDelayMs = 15000;
      setTimeout(async () => {
        try {
          // 检测 PM2 环境（使用官方方式）
          if (!this.isRunningUnderPM2()) {
            log('restarting', 'ai_helper_update_no_pm2');
            await this.releaseFileLock();
            return;
          }

          const processName = process.env.name || 'hydrooj';
          log('restarting', 'ai_helper_update_running_pm2_reload', processName);

          exec(`pm2 reload "${processName}"`, async (error, stdout, stderr) => {
            if (error) {
              const detail = (stderr || stdout || error.message || '').trim();
              log('restarting', 'ai_helper_update_pm2_reload_failed', detail || 'unknown error');
              log('restarting', 'ai_helper_update_fallback_process_exit');
              await this.releaseFileLock();
              setTimeout(() => {
                process.exit(0);
              }, 500);
            } else {
              log('restarting', 'ai_helper_update_pm2_reload_done');
              await this.releaseFileLock();
            }
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          log('restarting', 'ai_helper_update_restart_error', detail);
          await this.releaseFileLock();
          if (this.isRunningUnderPM2()) {
            log('restarting', 'ai_helper_update_fallback_process_exit');
            setTimeout(() => {
              process.exit(0);
            }, 500);
          } else {
            log('restarting', 'ai_helper_update_manual_restart_needed');
          }
        }
      }, restartDelayMs);
      deferFileLockRelease = true;

      log('restarting', 'ai_helper_update_restart_scheduled', `${Math.round(restartDelayMs / 1000)}`);
      log('restarting', 'ai_helper_update_check_pm2_logs_hint');

      log('completed', 'ai_helper_update_complete');

      // 🔒 释放更新锁
      UpdateService.updateLock = false;

      return {
        success: true,
        step: 'completed',
        message: 'ai_helper_update_success',
        messageKey: 'ai_helper_update_success',
        logs,
        pluginPath: this.pluginPath
      };

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'unknown error';
      log('failed', errorMsg);

      if (backupCommit) {
        try {
          await this.rollback(backupCommit, (m) => log('failed', m));
        } catch (rollbackErr) {
          const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
          log('failed', `Rollback error: ${detail}`);
        }
      }

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
      if (!deferFileLockRelease) {
        await this.releaseFileLock();
      }
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
      message: validation.needsGitInit ? 'ai_helper_update_needs_git_init_auto' : validation.message
    };
  }
}

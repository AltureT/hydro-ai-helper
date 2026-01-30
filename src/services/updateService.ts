/**
 * UpdateService - 插件更新服务
 *
 * 提供插件在线更新功能：
 * - 自动检测插件安装路径
 * - 自动选择最优仓库（优先 Gitee，备选 GitHub）
 * - 执行 git pull 获取最新代码
 * - 执行 npm run build 编译
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
   * 选择最优仓库（优先 Gitee，备选 GitHub）
   * @param onLog 日志回调
   * @returns 选中的仓库信息
   */
  async selectBestRepo(onLog?: (msg: string) => void): Promise<RepoSelection> {
    const log = (msg: string) => onLog?.(msg);

    log('正在检测最优仓库...');

    // 按优先级测试仓库
    for (const repo of GIT_REPOS) {
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
    return { name: GIT_REPOS[0].name, url: GIT_REPOS[0].url, latency: -1 };
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
        shell: true,
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
    const logs: string[] = [];
    const log = (step: UpdateStep, message: string) => {
      logs.push(`[${step}] ${message}`);
      if (onProgress) onProgress(step, message);
    };

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

      // Step 1.5: 选择最优仓库
      const selectedRepo = await this.selectBestRepo((msg) => log('detecting', msg));
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

        // Step 2: Git pull
        log('pulling', '正在拉取最新代码...');
        const pullResult = await this.executeCommand(
          'git',
          ['pull', 'origin', 'main'],
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

      // Step 3: npm run build
      log('building', '正在编��项目...');
      const buildResult = await this.executeCommand(
        'npm',
        ['run', 'build'],
        this.pluginPath,
        (line) => log('building', line.trim())
      );

      if (buildResult.code !== 0) {
        const errorMsg = `npm run build 失败: ${buildResult.stderr}`;
        log('failed', errorMsg);
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

      // Step 4: 延迟执行 pm2 restart hydrooj
      // 注意：必须延迟执行，确保 HTTP 响应先发送给客户端
      // 否则 pm2 restart 会立即杀死进程，导致响应无法完成
      log('restarting', '准备重启 HydroOJ（将在响应发送后执行）...');

      // 使用 setTimeout 延迟 1 秒执行重启，确保响应先发送
      setTimeout(() => {
        spawn('pm2', ['restart', 'hydrooj'], {
          cwd: this.pluginPath,
          shell: true,
          detached: true,
          stdio: 'ignore'
        }).unref();
      }, 1000);

      log('restarting', '重启命令已安排，服务将在 1 秒后重启');

      // 完成
      log('completed', '更新完成！页面将在几秒后自动刷新...');
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
      return {
        success: false,
        step: 'failed',
        message: errorMsg,
        logs,
        pluginPath: this.pluginPath,
        error: errorMsg
      };
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

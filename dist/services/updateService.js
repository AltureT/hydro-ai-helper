"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateService = void 0;
const child_process_1 = require("child_process");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const fsPromises = __importStar(require("fs/promises"));
const axios_1 = __importDefault(require("axios"));
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
 * UpdateService 类
 */
class UpdateService {
    /**
     * 是否运行在 PM2 托管环境中
     * - 参照 HydroOJ 官方实现 (packages/hydrooj/src/handler/manage.ts)
     * - pm2 启动时会注入 pm_cwd 环境变量
     */
    isRunningUnderPM2() {
        return typeof process.env.pm_cwd !== 'undefined';
    }
    constructor(pluginPath) {
        // 🔒 GPG 信任指纹白名单（插件发布者密钥 - 完整 40 位指纹）
        this.TRUSTED_GPG_FINGERPRINTS = [
            'B6115AF3D271D12AB85E843E45DACC0ECFE90852', // AltureT <myalture@gmail.com>
            '968479A1AFF927E37D1A566BB5690EEEBB952194' // GitHub <noreply@github.com> (web-flow merge commits)
        ];
        // 🔒 安全命令路径映射（防止 PATH 劫持）
        // 说明：优先使用绝对路径；当不存在时，回退到当前 Node 的 bin 目录（适配 nvm/pm2/npm 全局安装）。
        this.SAFE_COMMANDS = {
            git: ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'],
            npm: ['/usr/bin/npm', '/usr/local/bin/npm', '/opt/homebrew/bin/npm'],
            pm2: ['/usr/local/bin/pm2', '/usr/bin/pm2', '/opt/homebrew/bin/pm2'],
            gpg: ['/usr/bin/gpg', '/usr/local/bin/gpg', '/opt/homebrew/bin/gpg'],
            sh: ['/bin/sh', '/usr/bin/sh']
        };
        // 🔒 锁超时时间（30分钟，防止死锁）
        this.LOCK_TIMEOUT_MS = 30 * 60 * 1000;
        // 通过 __dirname 自动检测插件安装路径
        // __dirname 指向 dist 目录，需要回退到插件根目录
        const resolvedPath = pluginPath ? path.resolve(pluginPath) : path.resolve(__dirname, '../..');
        // 🔒 解析真实路径（防止 symlink 路径混淆）
        try {
            this.pluginPath = fs.realpathSync(resolvedPath);
        }
        catch {
            this.pluginPath = resolvedPath;
        }
        this.LOCK_FILE = path.join(this.pluginPath, '.update.lock');
    }
    /**
     * 获取插件安装路径
     */
    getPluginPath() {
        return this.pluginPath;
    }
    /**
     * 🔒 获取安全命令路径（防止 PATH 劫持）
     */
    getSafeCommandPath(cmd) {
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
            }
            catch {
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
        }
        catch {
            // ignore
        }
        // 最终回退：使用原始命令名（依赖最小化 PATH）
        return cmd;
    }
    /**
     * 🔒 构造安全 PATH（最小化 + 兼容 nvm/Homebrew）
     */
    getSafePathEnv() {
        if (process.platform === 'win32') {
            // Windows 环境不强行覆盖 PATH，避免破坏系统查找逻辑
            return process.env.PATH || '';
        }
        const dirs = ['/usr/bin', '/usr/local/bin', '/bin'];
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
        }
        catch {
            // ignore
        }
        return Array.from(new Set(dirs.filter(Boolean))).join(path.delimiter);
    }
    /**
     * 🔒 尝试获取文件锁（支持 cluster 模式）
     */
    async acquireFileLock() {
        try {
            // 检查锁文件是否存在
            if (fs.existsSync(this.LOCK_FILE)) {
                const lockContent = await fsPromises.readFile(this.LOCK_FILE, 'utf-8');
                let lockInfo = null;
                try {
                    lockInfo = JSON.parse(lockContent);
                }
                catch {
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
                            process.kill(lockInfo.pid, 0); // 检查进程存在性（不发送信号）
                            return {
                                success: false,
                                message: `更新正在进行中（PID: ${lockInfo.pid}），请稍后重试`
                            };
                        }
                        catch (e) {
                            const nodeErr = e;
                            if (nodeErr?.code === 'ESRCH') {
                                console.log(`[UpdateService] 清理过期锁文件（进程 ${lockInfo.pid} 已退出）`);
                                await fsPromises.unlink(this.LOCK_FILE);
                            }
                            else if (nodeErr?.code === 'EPERM') {
                                return {
                                    success: false,
                                    message: `更新锁被其他用户进程持有（PID: ${lockInfo.pid}），当前进程无权限探测其状态，请稍后重试`
                                };
                            }
                            else {
                                return {
                                    success: false,
                                    message: `更新锁状态未知（PID: ${lockInfo.pid}），为安全起见已拒绝并发更新，请稍后重试`
                                };
                            }
                        }
                    }
                    else {
                        // 锁超时，清理
                        console.log(`[UpdateService] 清理超时锁文件（超时 ${Math.floor((now - lockInfo.timestamp) / 1000)}s）`);
                        await fsPromises.unlink(this.LOCK_FILE);
                    }
                }
            }
            // 创建新锁
            const lockInfo = {
                pid: process.pid,
                timestamp: Date.now()
            };
            await fsPromises.writeFile(this.LOCK_FILE, JSON.stringify(lockInfo), { flag: 'wx' });
            return { success: true };
        }
        catch (err) {
            const nodeErr = err;
            if (nodeErr.code === 'EEXIST') {
                // 并���写入冲突，锁已被其他进程获取
                return { success: false, message: '更新锁被其他进程持有，请稍后重试' };
            }
            console.error('[UpdateService] 文件锁异常:', err);
            return { success: false, message: `锁文件操作失败: ${nodeErr.message}` };
        }
    }
    /**
     * 🔒 释放文件锁
     */
    async releaseFileLock() {
        try {
            if (fs.existsSync(this.LOCK_FILE)) {
                const lockContent = await fsPromises.readFile(this.LOCK_FILE, 'utf-8');
                const lockInfo = JSON.parse(lockContent);
                // 只释放自己持有的锁
                if (lockInfo.pid === process.pid) {
                    await fsPromises.unlink(this.LOCK_FILE);
                }
                else {
                    console.warn(`[UpdateService] 锁文件被其他进程持有（PID: ${lockInfo.pid}），跳过释放`);
                }
            }
        }
        catch (err) {
            console.error('[UpdateService] 释放文件锁失败:', err);
        }
    }
    /**
     * 验证插件路径是否有效（不检查 git 仓库）
     */
    validatePluginPath() {
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
     * 🔒 写权限预检（避免更新过程中途失败）
     */
    async checkWritePermission(onLog) {
        const log = (msg) => onLog?.(msg);
        try {
            await fsPromises.access(this.pluginPath, fs.constants.W_OK);
            // 额外探测：确保可创建/删除文件（覆盖部分挂载/ACL 场景）
            const probeName = `.update.writecheck.${process.pid}.${Date.now()}`;
            const probePath = path.join(this.pluginPath, probeName);
            try {
                const fh = await fsPromises.open(probePath, 'wx');
                await fh.close();
            }
            finally {
                try {
                    if (fs.existsSync(probePath)) {
                        await fsPromises.unlink(probePath);
                    }
                }
                catch {
                    // ignore
                }
            }
            const gitDir = path.join(this.pluginPath, '.git');
            if (fs.existsSync(gitDir)) {
                await fsPromises.access(gitDir, fs.constants.W_OK);
            }
            return { ok: true };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : '未知错误';
            log(`写权限检查失败: ${msg}`);
            return { ok: false, message: `当前进程对插件目录缺少写入权限: ${msg}` };
        }
    }
    /**
     * 初始化 git 仓库并拉取代码
     */
    async initGitRepo(repoUrl, onLog, fallbackRepoUrls) {
        const log = (msg) => onLog?.(msg);
        log('目录不是 git 仓库，正在初始化...');
        // git init
        log('执行 git init...');
        const initResult = await this.executeCommand('git', ['init'], this.pluginPath, undefined, 300000);
        if (initResult.code !== 0) {
            log(`git init 失败: ${initResult.stderr}`);
            return false;
        }
        // git remote add origin
        log(`添加远程仓库: ${repoUrl}`);
        const remoteResult = await this.executeCommand('git', ['remote', 'add', 'origin', repoUrl], this.pluginPath, undefined, 300000);
        if (remoteResult.code !== 0) {
            // 如果 remote 已存在，尝试设置 URL
            const setUrlResult = await this.executeCommand('git', ['remote', 'set-url', 'origin', repoUrl], this.pluginPath, undefined, 300000);
            if (setUrlResult.code !== 0) {
                log(`设置远程仓库失败: ${setUrlResult.stderr}`);
                return false;
            }
        }
        // git fetch（避免 TOCTOU：仅获取对象，不切换工作区；待签名验证通过后再 checkout/reset）
        log('正在获取远程代码...');
        let fetchResult = await this.executeCommand('git', ['fetch', '--prune', 'origin', 'main'], this.pluginPath, (line) => log(line.trim()), 300000 // 🔒 5 分钟超时
        );
        // 🔒 fetch 失败时尝试回退到备选仓库
        if (fetchResult.code !== 0 && fallbackRepoUrls && fallbackRepoUrls.length > 0) {
            log(`当前仓库 fetch 失败: ${fetchResult.stderr}`);
            for (const repo of fallbackRepoUrls) {
                if (repo.url === repoUrl)
                    continue;
                log(`尝试回退到 ${repo.name} (${repo.url})...`);
                await this.executeCommand('git', ['remote', 'set-url', 'origin', repo.url], this.pluginPath, undefined, 300000);
                fetchResult = await this.executeCommand('git', ['fetch', '--prune', 'origin', 'main'], this.pluginPath, (line) => log(line.trim()), 300000);
                if (fetchResult.code === 0) {
                    log(`回退到 ${repo.name} 成功`);
                    break;
                }
                log(`${repo.name} fetch 也失败: ${fetchResult.stderr}`);
            }
        }
        if (fetchResult.code !== 0) {
            log(`所有仓库 git fetch 均失败: ${fetchResult.stderr}`);
            return false;
        }
        log('git 仓库初始化完成（已获取远程对象，待签名验证通过后切换到 main）');
        return true;
    }
    /**
     * 测试单个仓库的连接延迟
     * @param repo 仓库配置
     * @returns 延迟（毫秒），失败返回 -1
     */
    async testRepoLatency(repo) {
        const startTime = Date.now();
        try {
            await axios_1.default.head(repo.testUrl, {
                timeout: 5000,
                maxRedirects: 3
            });
            return Date.now() - startTime;
        }
        catch {
            return -1;
        }
    }
    /**
     * 检测网络环境（国内/国外）
     */
    async detectNetworkRegion(onLog) {
        const log = (msg) => onLog?.(msg);
        try {
            const baiduTest = axios_1.default.head('https://www.baidu.com', { timeout: 3000 });
            const googleTest = axios_1.default.head('https://www.google.com', { timeout: 3000 });
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
        }
        catch {
            log('网络环境检测异常，使用默认配置');
            return 'unknown';
        }
    }
    /**
     * 获取仓库优先级顺序
     */
    getRepoOrder(region) {
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
    async selectBestRepo(onLog) {
        const log = (msg) => onLog?.(msg);
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
            }
            else {
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
    async isGitInstalled() {
        const result = await this.executeCommand('git', ['--version'], this.pluginPath);
        return result.code === 0 && result.stdout.toLowerCase().includes('git version');
    }
    /**
     * 检查命令是否存在
     */
    async commandExists(commandName) {
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'where' : 'sh';
        const args = isWin ? [commandName] : ['-c', `command -v ${commandName}`];
        const result = await this.executeCommand(cmd, args, this.pluginPath);
        return result.code === 0 && result.stdout.trim().length > 0;
    }
    /**
     * 执行 shell 命令行
     */
    async runShellCommand(commandLine, cwd, onOutput) {
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'cmd' : 'sh';
        const args = isWin ? ['/c', commandLine] : ['-c', commandLine];
        return this.executeCommand(cmd, args, cwd, onOutput);
    }
    /**
     * 获取可用的 sudo 前缀
     */
    async getSudoPrefix(onLog) {
        const log = (msg) => onLog?.(msg);
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
    async installGit(region, onLog) {
        const log = (msg) => onLog?.(msg);
        const platform = process.platform;
        // 安全策略：禁止 Web 应用使用 sudo 安装系统软件
        const installGuides = {
            linux: 'Linux 系统请使用包管理器手动安装 Git:\n  • Debian/Ubuntu: sudo apt-get install git\n  • CentOS/RHEL: sudo yum install git\n  • Fedora: sudo dnf install git\n  • Arch: sudo pacman -S git\n  • Alpine: sudo apk add git',
            darwin: 'macOS 系统请手动安装 Git:\n  • 方法1: 下载官方安装包 https://git-scm.com/download/mac\n  • 方法2: 使用 Homebrew: brew install git\n  • 方法3: 安装 Xcode Command Line Tools',
            win32: 'Windows 系统请手动安装 Git:\n  • 下载官方安装包: https://git-scm.com/download/win\n  • 或使用包管理器: winget install Git.Git'
        };
        const guide = installGuides[platform] || '请手动安装 Git';
        log(guide);
        return {
            ok: false,
            message: `需要手动安装 Git。${platform === 'linux' ? '请使用系统包管理器安装后重试。' : ''}`
        };
    }
    /**
     * 确保 git 已安装
     */
    async ensureGitInstalled(region, onLog) {
        const log = (msg) => onLog?.(msg);
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
     * 是否允许在一键更新中执行 npm install scripts
     * - 默认禁用（更安全）：避免依赖包中的 install/postinstall 脚本在服务器上执行
     * - 如确需启用：设置环境变量 AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS=1
     */
    allowNpmScriptsOnUpdate() {
        const raw = (process.env.AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS || '').trim();
        return raw === '1' || raw.toLowerCase() === 'true';
    }
    /**
     * 🔒 安装依赖（优先 npm ci，失败时回退 npm install；默认禁用 scripts）
     */
    async installDependencies(onOutput, timeoutMs = 300000) {
        const ignoreScripts = !this.allowNpmScriptsOnUpdate();
        const env = {
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
        const runNpm = async (args, usedCi) => {
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
            onOutput?.('npm ci 失败，回退到 npm install...');
            const installResult = await runNpm(['install'], false);
            return { ...installResult, ignoreScripts };
        }
        // 没有 lock：清理旧依赖，避免残留导致运行时异常
        try {
            const nodeModulesPath = path.join(this.pluginPath, 'node_modules');
            if (fs.existsSync(nodeModulesPath)) {
                onOutput?.('未找到 package-lock.json，正在清理旧依赖包...');
                await fsPromises.rm(nodeModulesPath, { recursive: true, force: true });
            }
        }
        catch {
            // ignore
        }
        const installResult = await runNpm(['install'], false);
        return { ...installResult, ignoreScripts };
    }
    /**
     * 🔒 原子化构建 dist：先构建到临时目录，再用 rename 原子替换
     */
    async buildPluginAtomically(onOutput, timeoutMs = 300000) {
        const distDir = path.join(this.pluginPath, 'dist');
        const tmpDir = path.join(this.pluginPath, `.dist.tmp.${process.pid}.${Date.now()}`);
        const backupDir = path.join(this.pluginPath, `.dist.backup.${process.pid}.${Date.now()}`);
        const safeRm = async (p) => {
            try {
                await fsPromises.rm(p, { recursive: true, force: true });
            }
            catch {
                // ignore
            }
        };
        // 清理可能残留的临时目录
        await safeRm(tmpDir);
        const buildResult = await this.executeCommand('npm', ['run', 'build:plugin', '--', '--outDir', tmpDir], this.pluginPath, onOutput, timeoutMs);
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
        }
        catch (err) {
            // 尝试恢复旧 dist（防御性：避免 dist 丢失）
            try {
                if (!fs.existsSync(distDir) && backupCreated && fs.existsSync(backupDir)) {
                    await fsPromises.rename(backupDir, distDir);
                }
            }
            catch {
                // ignore
            }
            await safeRm(tmpDir);
            return {
                code: 1,
                stdout: buildResult.stdout || '',
                stderr: `原子化构建替换失败: ${err instanceof Error ? err.message : '未知错误'}`
            };
        }
    }
    /**
     * 设置 git remote origin 为指定 URL
     */
    async setRemoteOrigin(url, onLog) {
        const log = (msg) => onLog?.(msg);
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
     * 🔒 验证 GPG 签名并检查指纹白名单
     */
    async verifyGPGSignature(ref, onLog) {
        const log = (msg) => onLog?.(msg);
        // 🔒 使用隔离的 GNUPGHOME（避免污染系统密钥环；也避免服务用户无写入 ~/.gnupg 导致验证失败）
        const gpgHomePrefix = path.join(os.tmpdir(), 'hydro-ai-helper-gpg-');
        let gpgHome = '';
        const safeRmDir = async (dir) => {
            try {
                if (dir) {
                    await fsPromises.rm(dir, { recursive: true, force: true });
                }
            }
            catch {
                // ignore
            }
        };
        try {
            gpgHome = await fsPromises.mkdtemp(gpgHomePrefix);
            try {
                await fsPromises.chmod(gpgHome, 0o700);
            }
            catch {
                // ignore
            }
            const env = { GNUPGHOME: gpgHome };
            // Step 0: 确保 gpg 可用
            const gpgVersion = await this.executeCommand('gpg', ['--version'], this.pluginPath, undefined, 15000, env);
            if (gpgVersion.code !== 0) {
                return {
                    valid: false,
                    error: '未检测到可用的 gpg（GnuPG）。为保证一键更新安全性（强制签名校验），请先安装 gpg 后重试。'
                };
            }
            // Step 1: 导入信任的公钥
            const publicKeyPath = path.join(this.pluginPath, 'assets/trusted-keys/publisher.asc');
            if (fs.existsSync(publicKeyPath)) {
                log('正在导入发布者公钥...');
                const importResult = await this.executeCommand('gpg', ['--batch', '--yes', '--import', publicKeyPath], this.pluginPath, undefined, 60000, env);
                if (importResult.code === 0) {
                    log('✓ 公钥导入完成');
                }
                else {
                    log(`公钥导入警告: ${(importResult.stderr || importResult.stdout || '').substring(0, 200)}`);
                }
            }
            else {
                log('⚠️  未找到发布者公钥文件（assets/trusted-keys/publisher.asc）。当前使用隔离的 GNUPGHOME，无法从系统密钥环继承公钥，签名验证可能失败；请修复公钥文件后重试。');
            }
            // Step 2: 验证 commit 签名并获取指纹
            // 🔒 使用 git verify-commit 而非 gpg（git 命令会调用 gpg）
            const gpgPath = this.getSafeCommandPath('gpg');
            const verifyResult = await this.executeCommand('git', ['-c', `gpg.program=${gpgPath}`, 'verify-commit', '--raw', ref], this.pluginPath, undefined, 60000, env);
            const combinedOutput = `${verifyResult.stdout || ''}\n${verifyResult.stderr || ''}`;
            // Step 3: 检查验证结果
            if (verifyResult.code !== 0) {
                // 无签名或签名无效
                if (combinedOutput.includes('no signature found') ||
                    combinedOutput.includes('no valid OpenPGP data found') ||
                    combinedOutput.includes('[GNUPG:] NODATA')) {
                    return {
                        valid: false,
                        error: '上游仓库未启用 GPG 签名。为确保代码来源可信，请要求插件作者启用 commit 签名。'
                    };
                }
                if (combinedOutput.includes('BAD signature') || combinedOutput.includes('[GNUPG:] BADSIG')) {
                    return {
                        valid: false,
                        error: 'GPG 签名无效（可能被篡改）。拒绝更新以保护系统安全。'
                    };
                }
                if (combinedOutput.includes('NO_PUBKEY') || combinedOutput.includes('缺少公钥')) {
                    return {
                        valid: false,
                        error: '无法验证签名：缺少公钥。请确认服务器已安装 gpg，且插件内置发布者公钥文件未缺失/未损坏。'
                    };
                }
                return {
                    valid: false,
                    error: `GPG 验证失败: ${(verifyResult.stderr || verifyResult.stdout || '').substring(0, 400)}`
                };
            }
            // Step 4: 提取签名指纹（优先 primary key fpr；完整 40 位，防止密钥 ID 碰撞）
            const { signingFingerprint, primaryFingerprint } = this.extractGpgFingerprints(combinedOutput);
            const fingerprint = primaryFingerprint || signingFingerprint;
            if (!fingerprint) {
                return {
                    valid: false,
                    error: '无法从签名中提取完整指纹。GPG 输出: ' + combinedOutput.substring(0, 200)
                };
            }
            if (primaryFingerprint && signingFingerprint && primaryFingerprint !== signingFingerprint) {
                log(`检测到签名指纹: ${signingFingerprint} (subkey)`);
                log(`检测到主密钥指纹: ${primaryFingerprint} (primary)`);
            }
            else {
                log(`检测到签名指纹: ${fingerprint}`);
            }
            // Step 5: 检查指纹白名单
            if (!this.TRUSTED_GPG_FINGERPRINTS.includes(fingerprint)) {
                return {
                    valid: false,
                    error: `签名指纹 ${fingerprint} 不在信任列表中。这可能意味着代码不是由官方发布者签名。`
                };
            }
            log(`✓ GPG 签名验证通过，代码来自可信发布者（${fingerprint}）`);
            return { valid: true };
        }
        catch (err) {
            return {
                valid: false,
                error: `GPG 验证异常: ${err instanceof Error ? err.message : '未知错误'}`
            };
        }
        finally {
            await safeRmDir(gpgHome);
        }
    }
    /**
     * 从 git verify-commit --raw 输出中提取指纹
     * - signingFingerprint: 签名子密钥指纹（可能为 subkey）
     * - primaryFingerprint: 主密钥指纹（若可解析到）
     */
    extractGpgFingerprints(output) {
        const lines = output.split(/\r?\n/);
        let signingFingerprint;
        let primaryFingerprint;
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
            if (!line.includes('[GNUPG:]'))
                continue;
            if (!line.includes('VALIDSIG'))
                continue;
            const parts = line.trim().split(/\s+/);
            const validSigIndex = parts.findIndex((p) => p === 'VALIDSIG');
            if (validSigIndex < 0)
                continue;
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
    executeCommand(command, args, cwd, onOutput, timeout, // 超时时间（毫秒）
    envOverrides) {
        return new Promise((resolve) => {
            // 🔒 使用安全命令路径（防止 PATH 劫持）
            const safeCommand = this.getSafeCommandPath(command);
            const env = {
                ...process.env,
                ...envOverrides,
                PATH: this.getSafePathEnv() // 🔒 最小化 PATH（并兼容 nvm/Homebrew）
            };
            // 🔒 清理 GIT_* 环境变量（防止 GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* 劫持）
            for (const key of Object.keys(env)) {
                if (key.startsWith('GIT_')) {
                    delete env[key];
                }
            }
            // 🔒 禁止 git 弹出凭据提示（非交互环境下防止阻塞）
            env.GIT_TERMINAL_PROMPT = '0';
            const proc = (0, child_process_1.spawn)(safeCommand, args, {
                cwd,
                shell: false, // 🔒 禁用 shell：防止命令注入风险
                env,
                // 🔒 让子进程成为新的进程组 leader，便于超时后 kill 整个子进程树（POSIX）
                detached: process.platform !== 'win32'
            });
            let stdout = '';
            let stderr = '';
            let timeoutHandle = null;
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
                            }
                            catch {
                                try {
                                    proc.kill('SIGTERM');
                                }
                                catch {
                                    // ignore
                                }
                            }
                        }
                        else {
                            // Windows 无法通过负 PID 杀进程组：先尝试 taskkill /T，失败再退回 kill 单进程
                            try {
                                (0, child_process_1.spawn)('taskkill', ['/pid', String(pid), '/T', '/F'], {
                                    cwd,
                                    shell: false,
                                    env
                                });
                            }
                            catch {
                                try {
                                    proc.kill('SIGTERM');
                                }
                                catch {
                                    // ignore
                                }
                            }
                        }
                        setTimeout(() => {
                            // SIGTERM 后 5 秒仍未退出：强制 KILL（仅在进程仍在运行时）
                            if (proc.exitCode !== null)
                                return;
                            if (process.platform !== 'win32') {
                                try {
                                    process.kill(-pid, 'SIGKILL');
                                }
                                catch {
                                    try {
                                        proc.kill('SIGKILL');
                                    }
                                    catch {
                                        // ignore
                                    }
                                }
                            }
                            else {
                                try {
                                    proc.kill('SIGKILL');
                                }
                                catch {
                                    // ignore
                                }
                            }
                        }, 5000); // 5秒后强制 KILL
                    }
                }, timeout);
            }
            proc.stdout?.on('data', (data) => {
                const line = data.toString();
                stdout += line;
                if (onOutput)
                    onOutput(line);
            });
            proc.stderr?.on('data', (data) => {
                const line = data.toString();
                stderr += line;
                if (onOutput)
                    onOutput(line);
            });
            proc.on('close', (code) => {
                if (timeoutHandle)
                    clearTimeout(timeoutHandle);
                if (killed) {
                    resolve({ code: 124, stdout, stderr: stderr + '\n命令执行超时被终止' });
                }
                else {
                    resolve({ code: code ?? 1, stdout, stderr });
                }
            });
            proc.on('error', (err) => {
                if (timeoutHandle)
                    clearTimeout(timeoutHandle);
                stderr += err.message;
                resolve({ code: 1, stdout, stderr });
            });
        });
    }
    /**
     * 🔒 完整回滚：代码 + 依赖 + dist（用于更新失败的安全兜底）
     */
    async rollback(backupCommit, onLog) {
        const log = (msg) => onLog(msg);
        if (!backupCommit)
            return;
        log(`正在回滚到版本 ${backupCommit.substring(0, 8)}...`);
        await this.executeCommand('git', ['reset', '--hard', backupCommit], this.pluginPath, (line) => log(line.trim()), 300000 // 🔒 5 分钟超时
        );
        log('代码已回滚到更新前的版本');
        // 🔒 完整回滚：清理并重装依赖（确保版本一致）
        log('正在清理依赖包...');
        try {
            const nodeModulesPath = path.join(this.pluginPath, 'node_modules');
            if (fs.existsSync(nodeModulesPath)) {
                await fsPromises.rm(nodeModulesPath, { recursive: true, force: true });
            }
            log('依赖包已清理');
        }
        catch (rmErr) {
            log(`清理依赖包警告: ${rmErr instanceof Error ? rmErr.message : '未知错误'}`);
        }
        log('正在重新安装依赖包...');
        const rollbackInstall = await this.installDependencies((line) => log(line.trim()), 300000 // 5分钟超时
        );
        if (rollbackInstall.code === 0) {
            log('依赖包已恢复');
        }
        else {
            log('⚠️  警告：依赖包重装失败，服务可能无法正常启动');
            return;
        }
        // 🔒 dist 回滚：确保产物与回滚后的代码一致
        log('正在重建 dist（原子化构建）...');
        const rebuild = await this.buildPluginAtomically((line) => log(line.trim()), 300000);
        if (rebuild.code === 0) {
            log('dist 重建完成');
            log('已完全回滚到更新前的状态');
        }
        else {
            log('⚠️  警告：dist 重建失败，服务可能无法正常启动');
        }
    }
    /**
     * 执行完整更新流程
     */
    async performUpdate(onProgress) {
        // 🔒 检查进程内更新锁：快速拒绝并发请求
        if (UpdateService.updateLock) {
            return {
                success: false,
                step: 'failed',
                message: '更新操作正在进行中（进程内锁），请等待当前更新完成后再试',
                logs: [],
                pluginPath: this.pluginPath,
                error: '并发更新被拒绝（进程内锁）'
            };
        }
        // 🔒 获取文件锁：支持 cluster 模式的跨进程锁
        const fileLockResult = await this.acquireFileLock();
        if (!fileLockResult.success) {
            return {
                success: false,
                step: 'failed',
                message: fileLockResult.message || '无法获取更新锁',
                logs: [],
                pluginPath: this.pluginPath,
                error: '并发更新被拒绝（文件锁）'
            };
        }
        // 设置进程内更新锁
        UpdateService.updateLock = true;
        const logs = [];
        const log = (step, message) => {
            logs.push(`[${step}] ${message}`);
            if (onProgress)
                onProgress(step, message);
        };
        // 用于失败回滚的备份 commit（在函数作用域声明）
        let backupCommit = '';
        // 🔒 成功更新时延后释放文件锁（等待 pm2 restart 完成，避免竞态窗口）
        let deferFileLockRelease = false;
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
            // Step 1.1: 写权限预检（尽早失败）
            log('detecting', '正在检查写入权限...');
            const writeCheck = await this.checkWritePermission((msg) => log('detecting', msg));
            if (!writeCheck.ok) {
                const msg = writeCheck.message || '写入权限检查失败';
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
            // Step 1.4: 🔒 确认当前 cwd 为 git 仓库根目录（防止路径/环境劫持）
            if (!validation.needsGitInit) {
                log('detecting', '正在验证 Git 仓库根目录...');
                const topLevelResult = await this.executeCommand('git', ['rev-parse', '--show-toplevel'], this.pluginPath);
                if (topLevelResult.code !== 0) {
                    const msg = `Git 仓库检测失败: ${topLevelResult.stderr || topLevelResult.stdout}`;
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
                const rawTopLevel = topLevelResult.stdout.trim();
                let realTopLevel = rawTopLevel;
                try {
                    realTopLevel = fs.realpathSync(rawTopLevel);
                }
                catch {
                    // ignore
                }
                if (realTopLevel !== this.pluginPath) {
                    const msg = `安全检查失败：插件路径不是 git 仓库根目录（toplevel: ${rawTopLevel}）`;
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
            }
            // Step 1.5: 选择最优仓库
            const orderedRepos = this.getRepoOrder(region);
            log('detecting', '正在测试仓库连接...');
            let selectedRepo = null;
            for (const repo of orderedRepos) {
                log('detecting', `测试 ${repo.name} 连接...`);
                const latency = await this.testRepoLatency(repo);
                if (latency > 0) {
                    log('detecting', `${repo.name} 延迟: ${latency}ms ✓`);
                    selectedRepo = { name: repo.name, url: repo.url, latency };
                    break;
                }
                else {
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
                const initSuccess = await this.initGitRepo(selectedRepo.url, (msg) => log('detecting', msg), orderedRepos);
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
                // 初始化完成后进入签名验证阶段（待验证通过后再切换工作区）
                log('pulling', '远程对象已获取完成，待签名验证通过后切换到最新版本');
            }
            else {
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
                const backupResult = await this.executeCommand('git', ['rev-parse', 'HEAD'], this.pluginPath);
                if (backupResult.code === 0) {
                    backupCommit = backupResult.stdout.trim();
                    log('pulling', `当前版本: ${backupCommit.substring(0, 8)}`);
                }
                else {
                    const detail = (backupResult.stderr || backupResult.stdout || '未知错误').trim();
                    const msg = `无法获取当前版本（无法建立回滚点），已中止更新: ${detail}`;
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
                // Step 2b: 重置本地更改，避免 pull 冲突
                log('pulling', '重置本地更改...');
                const resetResult = await this.executeCommand('git', ['reset', '--hard', 'HEAD'], this.pluginPath, (line) => log('pulling', line.trim()), 300000 // 🔒 5 分钟超时
                );
                if (resetResult.code !== 0) {
                    log('pulling', `git reset 警告: ${resetResult.stderr}`);
                }
                // Step 2c: Git fetch（避免 TOCTOU：先拉取对象，不切换工作区）
                log('pulling', '正在获取远程最新代码...');
                let fetchResult = await this.executeCommand('git', ['fetch', '--prune', 'origin', 'main'], this.pluginPath, (line) => log('pulling', line.trim()), 300000 // 🔒 5 分钟超时
                );
                // 🔒 fetch 失败时尝试回退到备选仓库
                if (fetchResult.code !== 0) {
                    log('pulling', `当前仓库 fetch 失败: ${fetchResult.stderr}`);
                    let fallbackSuccess = false;
                    for (const repo of orderedRepos) {
                        if (repo.url === selectedRepo.url)
                            continue;
                        log('pulling', `尝试回退到 ${repo.name} (${repo.url})...`);
                        const setResult = await this.setRemoteOrigin(repo.url, (msg) => log('pulling', msg));
                        if (!setResult)
                            continue;
                        fetchResult = await this.executeCommand('git', ['fetch', '--prune', 'origin', 'main'], this.pluginPath, (line) => log('pulling', line.trim()), 300000);
                        if (fetchResult.code === 0) {
                            log('pulling', `回退到 ${repo.name} 成功`);
                            fallbackSuccess = true;
                            break;
                        }
                        log('pulling', `${repo.name} fetch 也失败: ${fetchResult.stderr}`);
                    }
                    if (!fallbackSuccess) {
                        const errorMsg = `所有仓库 git fetch 均失败: ${fetchResult.stderr}`;
                        log('failed', errorMsg);
                        return {
                            success: false,
                            step: 'failed',
                            message: errorMsg,
                            logs,
                            pluginPath: this.pluginPath,
                            error: fetchResult.stderr
                        };
                    }
                }
                log('pulling', '远程代码获取完成');
            }
            // Step 2.4: 获取远程 main 的具体 commit hash（防止 TOCTOU：后续只对该 hash 做验证和切换）
            log('pulling', '正在解析远程版本...');
            const revParseResult = await this.executeCommand('git', ['rev-parse', '--verify', 'origin/main'], this.pluginPath, undefined, 15000);
            if (revParseResult.code !== 0) {
                const msg = `无法解析远程版本（origin/main）: ${revParseResult.stderr || revParseResult.stdout}`;
                log('failed', msg);
                return {
                    success: false,
                    step: 'failed',
                    message: msg,
                    logs,
                    pluginPath: this.pluginPath,
                    error: revParseResult.stderr || revParseResult.stdout || msg
                };
            }
            const targetCommit = revParseResult.stdout.trim();
            log('pulling', `远程版本: ${targetCommit.substring(0, 8)}`);
            // Step 2.5: GPG 签名验证（安全加固 - 强制验证 + 指纹白名单）
            log('pulling', '正在验证代码签名...');
            const verifyRef = targetCommit;
            const gpgVerifyResult = await this.verifyGPGSignature(verifyRef, (msg) => log('pulling', msg));
            if (!gpgVerifyResult.valid) {
                //🔒 强制 GPG 验证：拒绝所有未签名或签名无效的 commit
                const errorMsg = `代码签名验证失败: ${gpgVerifyResult.error}`;
                log('failed', errorMsg);
                // 无条件回滚到备份版本（如果存在）
                if (backupCommit) {
                    await this.rollback(backupCommit, (m) => log('failed', m));
                }
                else {
                    // 🔒 无备份 commit：无法可靠回滚。为避免破坏当前运行版本，拒绝继续并保持工作区不变。
                    log('failed', '⚠️  未能获取更新前的备份 commit，无法安全回滚。为保护当前版本，已中止更新且不会修改本地代码。');
                    log('failed', '建议：检查 git 仓库状态（例如 git status / git rev-parse HEAD）后重试更新。');
                }
                return {
                    success: false,
                    step: 'failed',
                    message: errorMsg,
                    logs,
                    pluginPath: this.pluginPath,
                    error: gpgVerifyResult.error
                };
            }
            log('pulling', '✓ GPG 签名验证通过，代码来源可信');
            // Step 2.6: 切换到已验证的远程版本（避免 TOCTOU）
            log('pulling', '正在切换到最新版本...');
            if (validation.needsGitInit) {
                // 新初始化的仓库中，yarn 安装的文件是 untracked 状态
                // 使用 git clean + checkout -f 强制切换，避免 untracked 文件冲突
                // 这是安全的：签名已验证通过，且 reset --hard 紧随其后会确保最终状态正确
                await this.executeCommand('git', ['clean', '-fd'], this.pluginPath, undefined, 60000);
                const checkoutResult = await this.executeCommand('git', ['checkout', '-f', '-B', 'main', targetCommit], this.pluginPath, (line) => log('pulling', line.trim()), 300000 // 🔒 5 分钟超时
                );
                if (checkoutResult.code !== 0) {
                    const errorMsg = `切换到 main 分支失败: ${checkoutResult.stderr}`;
                    log('failed', errorMsg);
                    return {
                        success: false,
                        step: 'failed',
                        message: errorMsg,
                        logs,
                        pluginPath: this.pluginPath,
                        error: checkoutResult.stderr
                    };
                }
            }
            const resetToVerified = await this.executeCommand('git', ['reset', '--hard', targetCommit], this.pluginPath, (line) => log('pulling', line.trim()), 300000 // 🔒 5 分钟超时
            );
            if (resetToVerified.code !== 0) {
                const errorMsg = `切换到最新版本失败: ${resetToVerified.stderr}`;
                log('failed', errorMsg);
                if (backupCommit) {
                    await this.rollback(backupCommit, (m) => log('failed', m));
                }
                return {
                    success: false,
                    step: 'failed',
                    message: errorMsg,
                    logs,
                    pluginPath: this.pluginPath,
                    error: resetToVerified.stderr
                };
            }
            log('pulling', '代码拉取完成');
            // Step 3: 安装依赖包（npm ci 优先；默认禁用 scripts）
            log('building', '正在安装依赖包...');
            const installResult = await this.installDependencies((line) => log('building', line.trim()), 300000 // 🔒 5 分钟超时
            );
            if (installResult.code !== 0) {
                const hint = installResult.ignoreScripts
                    ? '（提示：默认禁用 npm scripts 以提高安全性；如确需启用，请设置 AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS=1）'
                    : '';
                const errorMsg = `依赖安装失败${hint}: ${installResult.stderr}`;
                log('failed', errorMsg);
                // 🔒 完整回滚：代码 + 依赖
                if (backupCommit) {
                    await this.rollback(backupCommit, (m) => log('failed', m));
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
            // Step 4: 原子化构建 dist（添加超时防止挂起）
            log('building', '正在编译项目（原子化构建）...');
            const buildResult = await this.buildPluginAtomically((line) => log('building', line.trim()), 300000 // 🔒 5 分钟超时
            );
            if (buildResult.code !== 0) {
                const errorMsg = `npm run build:plugin 失败: ${buildResult.stderr}`;
                log('failed', errorMsg);
                // 🔒 完整回滚：代码 + 依赖
                if (backupCommit) {
                    await this.rollback(backupCommit, (m) => log('failed', m));
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
            // Step 5: 重启 HydroOJ 以应用更新
            // 参照 HydroOJ 官方实现 (packages/hydrooj/src/handler/manage.ts:85-88)
            log('restarting', '准备重启 HydroOJ（重启部署）...');
            // 延迟执行确保 HTTP 响应已发送（避免前端请求中断）
            const restartDelayMs = 15000;
            setTimeout(async () => {
                try {
                    // 检测 PM2 环境（使用官方方式）
                    if (!this.isRunningUnderPM2()) {
                        log('restarting', '未检测到 PM2 托管环境，请手动重启服务以使更新生效（pm2 restart hydrooj）');
                        await this.releaseFileLock();
                        return;
                    }
                    // 使用动态进程名（官方方式：process.env.name）
                    const processName = process.env.name || 'hydrooj';
                    log('restarting', `正在执行: pm2 reload "${processName}"`);
                    // 使用 exec 执行 pm2 reload（参照官方实现）
                    (0, child_process_1.exec)(`pm2 reload "${processName}"`, async (error, stdout, stderr) => {
                        if (error) {
                            const detail = (stderr || stdout || error.message || '').trim();
                            log('restarting', `pm2 reload 执行失败: ${detail || '未知错误'}`);
                            log('restarting', '将改用进程退出触发 PM2 自动重启');
                            await this.releaseFileLock();
                            // 兜底：直接退出让 PM2 自动拉起（参照 upgrade.ts:305）
                            setTimeout(() => {
                                process.exit(0);
                            }, 500);
                        }
                        else {
                            log('restarting', 'pm2 reload 已执行，服务即将重启');
                            await this.releaseFileLock();
                        }
                    });
                }
                catch (err) {
                    const detail = err instanceof Error ? err.message : String(err);
                    log('restarting', `重启执行异常: ${detail}`);
                    await this.releaseFileLock();
                    // 兜底：直接退出让 PM2 自动拉起
                    if (this.isRunningUnderPM2()) {
                        log('restarting', '将改用进程退出触发 PM2 自动重启');
                        setTimeout(() => {
                            process.exit(0);
                        }, 500);
                    }
                    else {
                        log('restarting', '请手动重启服务以使更新生效（pm2 restart hydrooj）');
                    }
                }
            }, restartDelayMs);
            deferFileLockRelease = true;
            log('restarting', `重启命令已安排，服务将在 ${Math.round(restartDelayMs / 1000)} 秒后重启`);
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
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : '未知错误';
            log('failed', errorMsg);
            // 🔒 异常兜底：若已建立回滚点，则尽最大努力回滚到更新前版本
            if (backupCommit) {
                try {
                    await this.rollback(backupCommit, (m) => log('failed', m));
                }
                catch (rollbackErr) {
                    const detail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
                    log('failed', `回滚异常: ${detail}`);
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
        }
        finally {
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
    getPluginInfo() {
        const validation = this.validatePluginPath();
        return {
            path: this.pluginPath,
            isValid: validation.valid, // needsGitInit 时 valid 也是 true
            message: validation.needsGitInit ? '需要初始化 git 仓库（将自动处理）' : validation.message
        };
    }
}
exports.UpdateService = UpdateService;
// 🔒 更新锁：防止并发更新（静态变量，进程内共享）
// 注意：此锁仅在单进程内有效，cluster 模式下依赖文件锁
UpdateService.updateLock = false;
//# sourceMappingURL=updateService.js.map
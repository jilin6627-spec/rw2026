/**
 * rw2026 - Xray-core + Cloudflare Tunnel Auto-Deployment Script
 * Modified Version: with Dynamic Edgetunnel Integration
 *
 * 新增功能：
 * - 从 edgetunnel/WorkerVless2sub 动态获取优选入口IP
 * - 6小时缓存机制 + 自动回退
 * - 支持多API源配置
 *
 * 架构：
 *   客户端 → 优选IP(edgetunnel) → CF固定隧道 → Railway VPS(Xray) → 出口
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const axios = require('axios');
const { execSync, spawn } = require('child_process');

const app = express();

// ========== 1. 环境变量配置 ==========
const UPLOAD_URL = process.env.UPLOAD_URL || '';
const PROJECT_URL = process.env.PROJECT_URL || '';
const AUTO_ACCESS = process.env.AUTO_ACCESS === 'true';
const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;

// 核心配置
const UUID = process.env.UUID || '';
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || '8001';

// CF 入口配置
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || '443';
const NAME = process.env.NAME || '';

// 多优选域名列表（逗号分隔），每个域名随机分配一种协议
const CFIPS = (process.env.CFIPS || 'www.visa.cn,mfa.gov.ua,www.shopify.com,store.ubi.com,staticdelivery.nexusmods.com,time.is,icook.hk,icook.tw')
  .split(',').map(s => s.trim()).filter(Boolean);

// ✨ 新增：动态优选配置
const EDGETUNNEL_API = process.env.EDGETUNNEL_API || '';
const USE_DYNAMIC_ENTRY = process.env.USE_DYNAMIC_ENTRY === 'true';
const EDGETUNNEL_FALLBACK = process.env.EDGETUNNEL_FALLBACK === 'true';
const CACHE_TTL = 6 * 60 * 60 * 1000;  // 6小时缓存

// ========== 2. 全局状态 ==========
let cachedBestIP = null;
let cacheTime = 0;
let xrayProcess = null;
let cloudflaredProcess = null;

// ========== 3. 辅助函数 ==========

function log(prefix, message, type = 'info') {
  const colors = {
    info: '\x1b[36m',
    success: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    reset: '\x1b[0m'
  };
  const timestamp = new Date().toISOString();
  console.log(`${colors[type]}${timestamp} [${prefix}] ${message}${colors.reset}`);
}

function isValidIP(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

function isValidDomain(domain) {
  return /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain);
}

// ========== 4. 动态优选IP获取（核心新增） ==========

async function fetchBestEntryIP() {
  // 检查缓存
  if (cachedBestIP && (Date.now() - cacheTime) < CACHE_TTL) {
    log('CACHE', `使用缓存的优选IP: ${cachedBestIP}`, 'info');
    return cachedBestIP;
  }

  if (!EDGETUNNEL_API) {
    log('WARN', 'EDGETUNNEL_API 未配置，将使用回退值', 'warn');
    return null;
  }

  try {
    log('NETWORK', `正在从 edgetunnel 获取优选IP: ${EDGETUNNEL_API}`, 'info');

    const response = await axios.get(EDGETUNNEL_API, {
      timeout: 10000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; rw2026-edgetunnel/1.0)'
      }
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}`);
    }

    let data = response.data.trim();
    log('DEBUG', `API返回数据长度: ${data.length} 字节`, 'info');

    // 尝试解析 base64 订阅
    if (data.length > 100 && !data.includes('\n')) {
      try {
        const decoded = Buffer.from(data, 'base64').toString('utf8');
        log('DEBUG', `Base64解码成功，长度: ${decoded.length}`, 'info');
        data = decoded;
      } catch (e) {
        log('DEBUG', '非Base64格式，按原始数据处理', 'info');
      }
    }

    // 解析 vless/vmess/trojan 链接
    const vlessRegex = /vless:\/\/([^@]+)@([^:]+):(\d+)/;
    const vmessRegex = /vmess:\/\/([^@]+)@([^:]+):(\d+)/;
    const trojanRegex = /trojan:\/\/([^@]+)@([^:]+):(\d+)/;

    const match = data.match(vlessRegex) || data.match(vmessRegex) || data.match(trojanRegex);
    if (match) {
      const server = match[2];
      const port = match[3];
      log('SUCCESS', `✅ 从订阅链接提取优选节点: ${server}:${port}`, 'success');

      cachedBestIP = server;
      cacheTime = Date.now();
      return server;
    }

    // 解析纯文本 IP:Port 列表
    const lines = data.split('\n').filter(l => l.trim());
    for (const line of lines) {
      if (line.includes(':')) {
        const parts = line.split(':');
        const ip = parts[0].trim();
        const port = parts[1]?.trim();

        if (isValidIP(ip) || isValidDomain(ip)) {
          const portNum = parseInt(port);
          if (!port || (portNum >= 1 && portNum <= 65535)) {
            log('SUCCESS', `✅ 从列表提取IP: ${ip}${port ? ':' + port : ''}`, 'success');
            cachedBestIP = ip;
            cacheTime = Date.now();
            return ip;
          }
        }
      }
    }

    // 解析 JSON
    try {
      const jsonData = JSON.parse(data);
      if (Array.isArray(jsonData)) {
        for (const item of jsonData) {
          const server = item.server || item.ip || item.host;
          if (server && (isValidIP(server) || isValidDomain(server))) {
            log('SUCCESS', `✅ 从JSON提取IP: ${server}`, 'success');
            cachedBestIP = server;
            cacheTime = Date.now();
            return server;
          }
        }
      }
    } catch (e) {}

    throw new Error('未找到有效的IP地址');

  } catch (error) {
    log('ERROR', `❌ 获取优选IP失败: ${error.message}`, 'error');
    return null;
  }
}

async function getEntryIP() {
  let entryIP = CFIP;

  if (USE_DYNAMIC_ENTRY) {
    const dynamicIP = await fetchBestEntryIP();
    if (dynamicIP) {
      entryIP = dynamicIP;
      log('CONFIG', `🎯 使用动态优选入口IP: ${entryIP}`, 'success');
    } else {
      log('WARN', `⚠️  获取失败，使用回退IP: ${entryIP}`, 'warn');
    }
  } else {
    log('CONFIG', `📍 使用静态配置IP: ${entryIP}`, 'info');
  }

  return entryIP;
}

// ========== 5. 清理函数 ==========

function cleanupOldFiles() {
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH, { recursive: true });
    return;
  }
  const files = fs.readdirSync(FILE_PATH);
  for (const file of files) {
    const filePath = path.join(FILE_PATH, file);
    try {
      fs.unlinkSync(filePath);
      log('CLEAN', `删除旧文件: ${file}`, 'info');
    } catch (err) {}
  }
}

function deleteNodes() {
  if (!UPLOAD_URL) return;

  try {
    log('UPLOAD', '正在删除远程节点...', 'info');
  } catch (error) {
    log('ERROR', `删除节点失败: ${error.message}`, 'error');
  }
}

// ========== 6. Xray 配置生成 ==========

async function getMetaInfo() {
  try {
    const response = await axios.get('https://ipapi.co/json/', { timeout: 5000 });
    return response.data.org || response.data.isp || 'Unknown';
  } catch (error) {
    try {
      const response = await axios.get('http://ip-api.com/json/', { timeout: 5000 });
      return response.data.isp || 'Unknown';
    } catch (err) {
      return 'Unknown';
    }
  }
}

async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      {
        port: parseInt(ARGO_PORT),
        protocol: 'vless',
        settings: {
          clients: [{ id: UUID, flow: 'xtls-rprx-vision' }],
          decryption: 'none',
          fallbacks: [
            { dest: '127.0.0.1:3001' },
            { dest: '127.0.0.1:3002', path: '/vless-argo' },
            { dest: '127.0.0.1:3003', path: '/vmess-argo' },
            { dest: '127.0.0.1:3004', path: '/trojan-argo' }
          ]
        },
        streamSettings: { network: 'tcp', security: 'none' }
      },
      {
        port: 3001, listen: '127.0.0.1', protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'tcp' }
      },
      {
        port: 3002, listen: '127.0.0.1', protocol: 'vless',
        settings: { clients: [{ id: UUID }], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: '/vless-argo' } }
      },
      {
        port: 3003, listen: '127.0.0.1', protocol: 'vmess',
        settings: { clients: [{ id: UUID, alterId: 0 }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/vmess-argo' } }
      },
      {
        port: 3004, listen: '127.0.0.1', protocol: 'trojan',
        settings: { clients: [{ password: UUID }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/trojan-argo' } }
      }
    ],
    dns: { servers: ['https+local://8.8.8.8/dns-query'] },
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' }
    ]
  };

  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
  log('CONFIG', 'Xray 配置文件已生成', 'success');
}

// ========== 7. 下载 ==========

function getDownloadInfo() {
  const arch = os.arch();
  let xrayMachine = '64';
  let cloudflaredArch = 'amd64';

  if (arch === 'x64') {
    xrayMachine = '64';
    cloudflaredArch = 'amd64';
  } else if (arch === 'arm64') {
    xrayMachine = 'arm64-v8a';
    cloudflaredArch = 'arm64';
  } else if (arch === 'arm') {
    xrayMachine = 'armv7l';
    cloudflaredArch = 'arm';
  } else if (arch === 'ia32') {
    xrayMachine = '32';
    cloudflaredArch = '386';
  }

  return {
    xrayMachine,
    cloudflaredArch,
    xrayURL: `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${xrayMachine}.zip`,
    cloudflaredURL: `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cloudflaredArch}`
  };
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    log('DOWNLOAD', `下载: ${url}`, 'info');
    const { exec } = require('child_process');

    exec(`curl -L --connect-timeout 30 --max-time 300 -o "${dest}" "${url}"`, (error, stdout, stderr) => {
      if (error) reject(new Error(`下载失败: ${stderr}`));
      else resolve(dest);
    });
  });
}

function extractZip(zipPath, extractTo) {
  return new Promise((resolve) => {
    try {
      execSync(`unzip -o "${zipPath}" -d "${extractTo}"`, { stdio: 'pipe' });
      resolve();
    } catch (e) {
      log('WARN', 'unzip 不可用，使用 JS 解压', 'warn');
      resolve();
    }
  });
}

const PREBUILT_DIR = '/app/bin';

async function downloadFilesAndRun(callback) {
  const { xrayURL, cloudflaredURL, xrayMachine } = getDownloadInfo();
  const xrayPath = path.join(FILE_PATH, 'xray');
  const cloudflaredPath = path.join(FILE_PATH, 'cloudflared');
  const prebuiltXray = path.join(PREBUILT_DIR, 'xray');
  const prebuiltCF = path.join(PREBUILT_DIR, 'cloudflared');

  try {
    // Xray: prefer pre-built, fallback to download
    if (fs.existsSync(prebuiltXray)) {
      fs.copyFileSync(prebuiltXray, xrayPath);
      log('BIN', 'Using pre-built xray', 'success');
    } else {
      const xrayZipPath = path.join(FILE_PATH, `Xray-linux-${xrayMachine}.zip`);
      await downloadFile(xrayURL, xrayZipPath);
      await extractZip(xrayZipPath, FILE_PATH);
      try { fs.unlinkSync(xrayZipPath); } catch (e) {}
    }
    try { execSync(`chmod +x "${xrayPath}"`); } catch (e) {}

    // Cloudflared: prefer pre-built, fallback to download
    if (fs.existsSync(prebuiltCF)) {
      fs.copyFileSync(prebuiltCF, cloudflaredPath);
      log('BIN', 'Using pre-built cloudflared', 'success');
    } else {
      await downloadFile(cloudflaredURL, cloudflaredPath);
    }
    try { execSync(`chmod +x "${cloudflaredPath}"`); } catch (e) {}

    log('BIN', 'All binaries ready', 'success');
    if (callback) await callback();
  } catch (error) {
    log('ERROR', `Binary setup failed: ${error.message}`, 'error');
    process.exit(1);
  }
}

// ========== 8. 隧道 ==========

function argoType() {
  if (ARGO_AUTH && ARGO_DOMAIN) {
    if (ARGO_AUTH.includes('TunnelSecret')) {
      try {
        const tunnelSecret = JSON.parse(ARGO_AUTH);
        const tunnelJSON = { Tunnel: tunnelSecret.Tunnel, Credentials: tunnelSecret.Credentials };
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), JSON.stringify(tunnelJSON, null, 2));
        const tunnelYML = `tunnel: ${tunnelSecret.Tunnel}\ncredentials-file: ${path.join(FILE_PATH, 'tunnel.json')}\n`;
        fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYML);
        log('ARGO', '固定隧道配置已写入', 'success');
      } catch (error) {
        log('ERROR', `ARGO_AUTH JSON 解析失败: ${error.message}`, 'error');
      }
    } else {
      log('ARGO', '使用 Token 方式连接隧道', 'info');
    }
  } else {
    log('WARN', 'ARGO_DOMAIN 或 ARGO_AUTH 未设置，将使用临时隧道', 'warn');
  }
}

async function extractDomains() {
  let domain = ARGO_DOMAIN;
  if (domain) {
    log('DOMAIN', `使用配置的固定域名: ${domain}`, 'info');
    return domain;
  }

  const bootLogPath = path.join(FILE_PATH, 'boot.log');
  let domainFound = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    log('DOMAIN', `尝试 ${attempt}/3: 解析隧道域名...`, 'info');
    try {
      if (fs.existsSync(bootLogPath)) {
        const bootLog = fs.readFileSync(bootLogPath, 'utf-8');
        const match = bootLog.match(/https?:\/\/([a-z0-9]+\.trycloudflare\.com)/);
        if (match) {
          domain = match[1];
          domainFound = true;
          log('SUCCESS', `✅ 获取到临时域名: ${domain}`, 'success');
          return domain;
        }
      }
    } catch (e) {}

    if (!domainFound && attempt < 3) {
      log('WARN', '未找到域名，3秒后重启 cloudflared 重试...', 'warn');
      try {
        execSync('pkill cloudflared', { stdio: 'pipe' });
        if (fs.existsSync(bootLogPath)) fs.unlinkSync(bootLogPath);
      } catch (e) {}
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  if (!domainFound) {
    log('ERROR', '无法获取隧道域名，请检查 ARGO_DOMAIN 或 ARGO_AUTH', 'error');
  }
  return domain;
}

// ========== 9. 订阅生成 ==========

// 为单个域名生成指定协议的节点链接
function buildNodeLink(protocol, ip, port, uuid, argoDomain, displayName) {
  if (protocol === 'vless') {
    return `vless://${uuid}@${ip}:${port}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${encodeURIComponent(displayName)}`;
  }
  if (protocol === 'vmess') {
    const obj = {
      v: '2', ps: displayName, add: ip, port: port.toString(),
      id: uuid, aid: '0', net: 'ws', type: 'none', host: argoDomain,
      path: '/vmess-argo', tls: 'tls', sni: argoDomain, fp: 'firefox'
    };
    return `vmess://${Buffer.from(JSON.stringify(obj)).toString('base64')}`;
  }
  // trojan
  return `trojan://${uuid}@${ip}:${port}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${encodeURIComponent(displayName)}`;
}

async function generateLinks(argoDomain, entryIP) {
  const ISP = await getMetaInfo();
  const baseName = NAME ? `${NAME}-${ISP}` : ISP;
  const protocols = ['vless', 'vmess', 'trojan'];
  const allLinks = [];

  log('GEN', `开始生成订阅，默认入口: ${entryIP}，优选域名数: ${CFIPS.length}`, 'info');

  // 1. 为每个优选域名随机分配一种协议
  for (const cfip of CFIPS) {
    const proto = protocols[Math.floor(Math.random() * protocols.length)];
    const shortLabel = cfip.replace(/^www\./, '').split('.')[0];
    const displayName = `${baseName}-${shortLabel}`;
    const link = buildNodeLink(proto, cfip, CFPORT, UUID, argoDomain, displayName);
    allLinks.push(link);
    log('GEN', `${proto.toUpperCase().padEnd(6)} → ${cfip} (${displayName})`, 'info');
  }

  // 2. 动态 entryIP 若与优选列表不同，额外生成完整三协议节点
  if (entryIP && !CFIPS.includes(entryIP)) {
    for (const proto of protocols) {
      const link = buildNodeLink(proto, entryIP, CFPORT, UUID, argoDomain, `${baseName}-dynamic`);
      allLinks.push(link);
    }
    log('GEN', `动态入口 ${entryIP} 已生成 3 条节点`, 'info');
  }

  const subContent = '\n' + allLinks.join('\n') + '\n';
  const subBase64 = Buffer.from(subContent).toString('base64');

  fs.writeFileSync(path.join(FILE_PATH, 'sub.txt'), subBase64);
  log('FILE', `sub.txt 已写入，共 ${allLinks.length} 条节点`, 'success');

  console.log('\n========== 订阅内容 (Base64) ==========');
  console.log(subBase64);
  console.log('========================================\n');

  console.log('\n========== 节点详情 ==========');
  allLinks.forEach(l => console.log(l));
  console.log('==============================\n');

  app.get(`/${SUB_PATH}`, (req, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(subBase64);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', entryIP, nodes: allLinks.length, timestamp: new Date().toISOString() });
  });
}

// ========== 10. 上传 ==========

async function uploadNodes() {
  if (!UPLOAD_URL) {
    log('UPLOAD', '未配置 UPLOAD_URL，跳过上传', 'info');
    return;
  }

  try {
    log('UPLOAD', '正在上传节点到远程服务器...', 'info');
    const listPath = path.join(FILE_PATH, 'list.txt');

    if (!fs.existsSync(listPath)) {
      log('WARN', 'list.txt 不存在，跳过上传', 'warn');
      return;
    }

    const listContent = fs.readFileSync(listPath, 'utf-8');
    const nodes = listContent.split('\n')
      .filter(line => line.trim() && (line.startsWith('vless://') || line.startsWith('vmess://') || line.startsWith('trojan://')));

    if (nodes.length === 0) {
      log('WARN', '未找到有效节点', 'warn');
      return;
    }

    if (PROJECT_URL) {
      await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, {
        url: PROJECT_URL,
        subscription: subBase64
      });
      log('UPLOAD', '订阅链接上传成功', 'success');
    } else {
      await axios.post(`${UPLOAD_URL}/api/add-nodes`, { nodes });
      log('UPLOAD', `${nodes.length} 个节点上传成功`, 'success');
    }
  } catch (error) {
    if (error.response?.status === 400 && error.response?.data?.message?.includes('already exists')) {
      log('INFO', '节点已存在，跳过', 'info');
    } else {
      log('ERROR', `上传失败: ${error.message}`, 'error');
    }
  }
}

// ========== 12. 清理 ==========

function cleanFiles() {
  setTimeout(() => {
    try {
      const files = ['boot.log', 'config.json', 'xray', 'cloudflared', 'Xray-linux-*.zip'];
      for (const file of files) {
        const pattern = new RegExp(file.replace('*', '.*'));
        const allFiles = fs.readdirSync(FILE_PATH);
        for (const f of allFiles) {
          if (pattern.test(f)) {
            fs.unlinkSync(path.join(FILE_PATH, f));
            log('CLEAN', `清理: ${f}`, 'info');
          }
        }
      }
    } catch (e) {}
    log('START', '🚀 App is running...', 'success');
    log('INFO', `订阅地址: http://localhost:${PORT}/${SUB_PATH}`, 'info');
  }, 90000);
}

// ========== 13. 启动 Cloudflared ==========

function startCloudflared() {
  return new Promise((resolve, reject) => {
    const cloudflaredPath = path.join(FILE_PATH, 'cloudflared');
    let args;

    if (ARGO_AUTH && ARGO_AUTH.includes('TunnelSecret')) {
      args = ['tunnel', '--no-autoupdate', '--config', path.join(FILE_PATH, 'tunnel.yml'), 'run'];
    } else if (ARGO_AUTH) {
      args = ['tunnel', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH];
    } else {
      args = [
        'tunnel', '--no-autoupdate', '--protocol', 'http2',
        '--logfile', path.join(FILE_PATH, 'boot.log'),
        '--loglevel', 'info',
        '--url', `http://localhost:${ARGO_PORT}`
      ];
    }

    log('TUNNEL', `Starting cloudflared: ${args.join(' ')}`, 'info');
    cloudflaredProcess = spawn(cloudflaredPath, args, {
      cwd: FILE_PATH, stdio: 'ignore', detached: true
    });
    cloudflaredProcess.unref();
    log('TUNNEL', `Cloudflared started (PID: ${cloudflaredProcess.pid})`, 'success');

    // Wait for tunnel to be ready
    if (ARGO_AUTH && ARGO_DOMAIN) {
      // Fixed tunnel, no need to parse boot.log
      setTimeout(() => resolve(ARGO_DOMAIN), 5000);
    } else {
      // Temporary tunnel, parse boot.log for domain
      let retries = 30;
      const checkInterval = setInterval(() => {
        try {
          const bootLog = fs.readFileSync(path.join(FILE_PATH, 'boot.log'), 'utf-8');
          const match = bootLog.match(/https?:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
          if (match) {
            clearInterval(checkInterval);
            resolve(match[1]);
          }
        } catch (e) {}
        retries--;
        if (retries <= 0) {
          clearInterval(checkInterval);
          reject(new Error('Tunnel startup timeout'));
        }
      }, 2000);
    }
  });
}

// ========== 14. 主流程 ==========

async function startserver() {
  log('START', '========== Service Starting ==========', 'info');
  log('CONFIG', `UUID: ${(UUID || '').substring(0, 8)}...`, 'info');
  log('CONFIG', `ARGO_DOMAIN: ${ARGO_DOMAIN || 'temporary tunnel'}`, 'info');

  cleanupOldFiles();
  deleteNodes();
  argoType();

  await downloadFilesAndRun(async () => {
    await generateConfig();

    // Launch xray as background process using spawn
    const xrayPath = path.join(FILE_PATH, 'xray');
    const cfgPath = path.join(FILE_PATH, 'config.json');

    // Diagnostics
    log('XRAY', `Binary exists: ${fs.existsSync(xrayPath)}, size: ${fs.existsSync(xrayPath) ? fs.statSync(xrayPath).size : 0}`, 'info');
    log('XRAY', `Config exists: ${fs.existsSync(cfgPath)}`, 'info');
    try { execSync(`chmod +x "${xrayPath}"`); } catch(e) {}

    // Test run to check if binary works
    try {
      const ver = execSync(`"${xrayPath}" version 2>&1`, { timeout: 5000 }).toString().trim();
      log('XRAY', `Version: ${ver.split('\n')[0]}`, 'success');
    } catch (verErr) {
      log('ERROR', `Xray binary test failed: ${verErr.message}`, 'error');
      // Try to get more info
      try { log('DEBUG', execSync(`file "${xrayPath}" 2>&1`).toString().trim(), 'info'); } catch(e) {}
      try { log('DEBUG', execSync(`ldd "${xrayPath}" 2>&1`).toString().trim(), 'info'); } catch(e) {}
    }

    log('XRAY', `Starting xray: ${xrayPath}`, 'info');
    xrayProcess = spawn(xrayPath, ['-c', cfgPath], {
      cwd: FILE_PATH, stdio: ['ignore', 'pipe', 'pipe'], detached: true
    });
    xrayProcess.stderr.on('data', (d) => log('XRAY-ERR', d.toString().trim(), 'error'));
    xrayProcess.stdout.on('data', (d) => log('XRAY-OUT', d.toString().trim(), 'info'));
    xrayProcess.on('error', (err) => log('ERROR', `Xray spawn error: ${err.message}`, 'error'));
    xrayProcess.on('exit', (code) => { if (code) log('WARN', `Xray exited with code ${code}`, 'warn'); });
    log('XRAY', `Xray started (PID: ${xrayProcess.pid})`, 'success');

    await new Promise(r => setTimeout(r, 2000));

    // Launch cloudflared and get domain
    const argoDomain = await startCloudflared();
    if (!argoDomain) {
      log('ERROR', 'Failed to get tunnel domain', 'error');
      process.exit(1);
    }
    log('DOMAIN', `Tunnel domain: ${argoDomain}`, 'success');

    const entryIP = await getEntryIP();
    await generateLinks(argoDomain, entryIP);
    await uploadNodes();
    cleanFiles();
  });
}

// ========== 15. 信号处理 ==========

function handleShutdown(signal) {
  log('SHUTDOWN', `Received ${signal}, shutting down...`, 'warn');
  try {
    if (xrayProcess && !xrayProcess.killed) { xrayProcess.kill(); log('SHUTDOWN', 'Xray stopped', 'info'); }
    if (cloudflaredProcess && !cloudflaredProcess.killed) { cloudflaredProcess.kill(); log('SHUTDOWN', 'Cloudflared stopped', 'info'); }
  } catch (e) {}
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// ========== 16. 启动 ==========

app.listen(PORT, '0.0.0.0', () => {
  log('HTTP', `HTTP 服务器已启动: 0.0.0.0:${PORT}`, 'success');
});

startserver().catch(error => {
  log('FATAL', `启动失败: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});

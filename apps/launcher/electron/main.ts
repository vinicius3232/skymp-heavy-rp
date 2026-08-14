import { app, BrowserWindow, ipcMain, dialog, screen } from 'electron';
import path from 'path';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { URL } from 'url';
import { parsePluginsTxt, parsePluginHeader, compareMods, analyzePlugins, parseCccTxt, analyzeCreationClub } from './parity.mjs';
import {
  parseVoiceManifest, decideVoiceAction, verifyHash, helperArgs,
  voiceConfigForClient, shutdownOrder, sanitizeVoicePreferences,
  VOICE_STAMP_FILENAME, VOICE_INSTALL_DIR, VOICE_HELPER_EXE
} from './voice-dist.mjs';

// ─── Constants & Env ───
// Estes valores são substituídos em tempo de build pelo `define` do
// vite.config.ts — em runtime não existe `.env` do lado do app empacotado.
// VITE_DISCORD_CLIENT_SECRET foi removido de propósito: o secret vive só no
// painel web (ver POST /api/launcher/oauth/exchange).
const DISCORD_CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID || '';
const DISCORD_REDIRECT_URI = process.env.VITE_DISCORD_REDIRECT_URI || 'http://localhost:19847/callback';
const SERVER_IP = process.env.VITE_SERVER_IP || '127.0.0.1';
// Default 7777 pra bater com o "port" de skymp/config/server-settings.*.json.
// O default anterior era 7757, que nao existia em lugar nenhum do lado servidor.
const SERVER_PORT = parseInt(process.env.VITE_SERVER_PORT || '7777', 10);
const API_PORT = parseInt(process.env.VITE_API_PORT || '7758', 10);
const DIST_REPO = process.env.VITE_GITHUB_DIST_REPO || '';
const PANEL_URL = (process.env.VITE_PANEL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const AUTH_FILE = path.join(app.getPath('userData'), 'auth.json');
const LAUNCHER_CONFIG_FILE = path.join(app.getPath('userData'), 'launcher-config.json');
const CLIENT_VERSION_FILENAME = 'skymp_client_version.txt';
const MODS_VERSION_FILENAME = 'skymp_mods_version.txt';
const MODS_PARTS_FILENAME = 'skymp_mods_parts.json';

let mainWindow: BrowserWindow | null = null;

type LauncherConfig = {
  gamePath?: string;
  display?: {
    width?: number;
    height?: number;
    mode?: 'borderless' | 'windowed' | 'fullscreen';
  };
  /** Preferências de máquina. Nunca credencial, nunca estado de jogo. */
  voice?: ReturnType<typeof sanitizeVoicePreferences>;
};

/**
 * O processo do `voice-helper.exe` desta execução.
 *
 * Módulo, e não por-janela, porque o desligamento precisa alcançá-lo de todos os
 * caminhos de saída — fechar a janela, `kill-game`, e `before-quit`. Um helper
 * que sobrevive ao launcher é um processo invisível segurando o microfone.
 */
let voiceHelperProcess: ReturnType<typeof spawn> | null = null;
let voiceControlPort = 0;
let voicePairingToken = '';

type PluginHeader = {
  masters: string[];
  isMaster: boolean;
  isLight: boolean;
  error?: string;
};

// [VOIP-NOTHROTTLE] - Previne gargalos no jogo quando em background
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 1024,
    minHeight: 640,
    title: "Skyrim Heavy RP Launcher",
    icon: path.join(__dirname, '../public/logo.png'),
    resizable: true,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // ─── Navigation hardening ───
  // The main window carries the full electronAPI preload, so it must never be
  // allowed to navigate to (or open) an arbitrary/attacker-controlled origin.
  const allowedOrigin = process.env.VITE_DEV_SERVER_URL
    ? new URL(process.env.VITE_DEV_SERVER_URL).origin
    : 'file://';

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      const isAllowed = process.env.VITE_DEV_SERVER_URL
        ? target.origin === allowedOrigin
        : target.protocol === 'file:';
      if (!isAllowed) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => {
    // No window.open/target=_blank navigation is allowed from the main window.
    // The Discord OAuth popup is created explicitly by the discord-login
    // handler via its own hardened BrowserWindow, not via window.open.
    return { action: 'deny' };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * O helper NÃO pode sobreviver ao launcher.
 *
 * Um `voice-helper.exe` órfão é um processo sem janela segurando o microfone
 * pelo WASAPI — indistinguível, para quem olha o gerenciador de tarefas, de um
 * gravador. A política de privacidade do projeto proíbe captura invisível, e
 * esta linha é onde ela é cumprida no caminho mais provável: o jogador fechar o
 * launcher e ir embora.
 *
 * `event.preventDefault()` porque `stopVoiceHelper` é assíncrono e o `quit`
 * padrão não esperaria por ele.
 */
let saindo = false;
app.on('before-quit', (event) => {
  if (saindo) return;
  saindo = true;
  event.preventDefault();
  stopVoiceHelper().finally(() => app.quit());
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ─── Window Controls ───
ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

// ─── Local Config ───
function readLauncherConfig(): LauncherConfig {
  try {
    if (fs.existsSync(LAUNCHER_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(LAUNCHER_CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading launcher config:', e);
  }
  return {};
}

function writeLauncherConfig(config: LauncherConfig) {
  const dir = path.dirname(LAUNCHER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LAUNCHER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

ipcMain.handle('get-launcher-config', async () => readLauncherConfig());

ipcMain.handle('save-game-path', async (_event, folderPath) => {
  const check = await validateGamePath(folderPath);
  if (!check.ok) return check;
  const config = readLauncherConfig();
  config.gamePath = folderPath;
  writeLauncherConfig(config);
  return { ok: true, reason: 'ok' };
});

function validateGamePath(folderPath: string) {
  if (!folderPath) return { ok: false, reason: 'empty' };
  const has = (f: string) => {
    try { return fs.existsSync(path.join(folderPath, f)); } catch { return false; }
  };
  if (!has('SkyrimSE.exe')) return { ok: false, reason: 'no-skyrim' };
  let isGog = has('Galaxy64.dll') || has('Galaxy.dll');
  if (!isGog) {
    try { isGog = fs.readdirSync(folderPath).some((n) => /^goggame-.*\.info$/i.test(n)); } catch {}
  }
  if (isGog) return { ok: false, reason: 'gog' };
  return { ok: true, reason: 'ok' };
}

// ─── Game Path & Validation ───
ipcMain.handle('select-game-path', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Selecione a pasta do Skyrim (onde está o SkyrimSE.exe)'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('check-game-path', async (_event, folderPath) => {
  return validateGamePath(folderPath);
});

// ─── Skyrim INI Repair ───
function skyrimDocumentsDir() {
  return path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition');
}

function readIniSection(iniPath: string, section: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const lines = fs.readFileSync(iniPath, 'utf8').split(/\r?\n/);
    let inSec = false;
    const hdr = `[${section}]`.toLowerCase();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inSec = trimmed.toLowerCase() === hdr;
        continue;
      }
      if (!inSec) continue;
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
    }
  } catch {}
  return out;
}

function updateIniSection(iniPath: string, section: string, values: Record<string, string | number>) {
  let raw = '';
  try { if (fs.existsSync(iniPath)) raw = fs.readFileSync(iniPath, 'utf8'); } catch {}
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  const wanted: Record<string, { key: string; value: string; done: boolean }> = {};
  for (const key of Object.keys(values)) {
    wanted[key.toLowerCase()] = { key, value: String(values[key]), done: false };
  }

  const hdr = `[${section}]`.toLowerCase();
  let inSection = false;
  let sectionEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = trimmed.toLowerCase() === hdr;
      continue;
    }
    if (!inSection) continue;
    const eq = lines[i].indexOf('=');
    if (eq <= 0) continue;
    const key = lines[i].slice(0, eq).trim().toLowerCase();
    if (wanted[key] && !wanted[key].done) {
      lines[i] = `${wanted[key].key}=${wanted[key].value}`;
      wanted[key].done = true;
    }
  }

  const pending = Object.values(wanted).filter((item) => !item.done).map((item) => `${item.key}=${item.value}`);
  if (inSection) {
    const at = sectionEnd === -1 ? lines.length : sectionEnd;
    if (pending.length) lines.splice(at, 0, ...pending);
  } else {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(`[${section}]`, ...Object.values(wanted).map((item) => `${item.key}=${item.value}`));
  }

  const dir = path.dirname(iniPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(iniPath, lines.join('\r\n'));
}

function iniDisplayKeys(width: number, height: number, mode: string) {
  const fullscreen = mode === 'fullscreen' ? 1 : 0;
  const borderless = mode === 'windowed' || mode === 'fullscreen' ? 0 : 1;
  return { 'iSize W': width, 'iSize H': height, 'bFull Screen': fullscreen, 'bBorderless': borderless };
}

ipcMain.handle('ensure-skyrim-ini', async (_event, opts) => {
  try {
    const dir = skyrimDocumentsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const prefsPath = path.join(dir, 'SkyrimPrefs.ini');
    const iniPath = path.join(dir, 'Skyrim.ini');

    if (opts?.repairOnly && fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const hasRes = parseInt(display['isize w'], 10) > 0 && parseInt(display['isize h'], 10) > 0;
      const hasMode = 'bborderless' in display || 'bfull screen' in display;
      if (hasRes && hasMode) {
        if (!fs.existsSync(iniPath)) {
          fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
        }
        return { ok: true, skipped: true };
      }
    }

    let width = parseInt(opts?.width, 10);
    let height = parseInt(opts?.height, 10);
    if (!width || !height) {
      try {
        const display = screen.getPrimaryDisplay();
        width = Math.round(display.size.width * display.scaleFactor);
        height = Math.round(display.size.height * display.scaleFactor);
      } catch {}
    }
    if (!width || !height) {
      width = 1920;
      height = 1080;
    }
    const mode = opts?.mode || 'borderless';
    updateIniSection(prefsPath, 'Display', iniDisplayKeys(width, height, mode));
    if (!fs.existsSync(iniPath)) {
      fs.writeFileSync(iniPath, ['[General]', 'sLanguage=ENGLISH', 'uGridsToLoad=5', 'uExterior Cell Buffer=36', ''].join('\r\n'));
    }

    const config = readLauncherConfig();
    config.display = { width, height, mode };
    writeLauncherConfig(config);
    return { ok: true, width, height, mode };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-display-settings', async () => {
  const result: { displays: Array<{ width: number; height: number }>; current: any } = { displays: [], current: null };
  try {
    const seen = new Set<string>();
    const push = (width: number, height: number) => {
      const key = `${width}x${height}`;
      if (width && height && !seen.has(key)) {
        seen.add(key);
        result.displays.push({ width, height });
      }
    };
    try {
      for (const display of screen.getAllDisplays()) {
        push(Math.round(display.size.width * display.scaleFactor), Math.round(display.size.height * display.scaleFactor));
      }
    } catch {}
    for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1080], [1600, 900], [1366, 768], [1280, 720]]) {
      push(width, height);
    }
    result.displays.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    const prefsPath = path.join(skyrimDocumentsDir(), 'SkyrimPrefs.ini');
    if (fs.existsSync(prefsPath)) {
      const display = readIniSection(prefsPath, 'Display');
      const width = parseInt(display['isize w'], 10);
      const height = parseInt(display['isize h'], 10);
      const fullscreen = display['bfull screen'] === '1';
      const borderless = display['bborderless'] === '1';
      result.current = { width: width || null, height: height || null, mode: fullscreen ? 'fullscreen' : (borderless ? 'borderless' : 'windowed') };
    }
  } catch (e: any) {
    return { ...result, error: e.message };
  }
  return result;
});

// ─── Auth Flow ───
function readAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading auth file:', e);
  }
  return null;
}

function writeAuthFile(data: any) {
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error writing auth file:', e);
  }
}

function clearAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      fs.unlinkSync(AUTH_FILE);
    }
  } catch {}
}


function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

/**
 * POST de JSON para uma URL arbitrária (http ou https). Diferente de
 * `postJsonToApi`, que é fixo no host/porta do servidor de jogo — o painel web
 * costuma ficar em outro host/porta (VITE_PANEL_URL).
 */
function postJsonToUrl(url: string, body: any): Promise<{ status: number, data: any }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve({ status: 0, data: null }); return; }

    const transport = parsed.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode || 500, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode || 500, data: null }); }
      });
    });

    req.on('error', () => resolve({ status: 0, data: null }));
    req.write(postData);
    req.end();
  });
}

function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(httpGetJson(new URL(res.headers.location, url).toString()));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(20000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function downloadToFile(url: string, destPath: string, onProgress?: (percent: number) => void, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!url.startsWith('https:')) {
      reject(new Error(`Download bloqueado: esquema de URL nao seguro (${url})`));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'Skyrim-Heavy-RP-Launcher' } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Muitos redirecionamentos'));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        if (!nextUrl.startsWith('https:')) {
          reject(new Error(`Download bloqueado: redirecionamento para esquema inseguro (${nextUrl})`));
          return;
        }
        downloadToFile(nextUrl, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ao baixar arquivo`));
        return;
      }
      const total = parseInt(String(res.headers['content-length'] || '0'), 10);
      let received = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total) onProgress(Math.floor((received / total) * 100));
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout no download')));
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function extractZip(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let stderr = '';
    tar.stderr.on('data', data => stderr += data.toString());
    tar.on('error', () => {
      const escape = (value: string) => value.replace(/'/g, "''");
      const ps = spawn('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${escape(zipPath)}' -DestinationPath '${escape(destDir)}' -Force`], { windowsHide: true });
      let psErr = '';
      ps.stderr.on('data', data => psErr += data.toString());
      ps.on('error', reject);
      ps.on('close', code => code === 0 ? resolve() : reject(new Error(psErr || `Expand-Archive saiu com codigo ${code}`)));
    });
    tar.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `tar saiu com codigo ${code}`)));
  });
}

function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq SkyrimSE.exe" /NH', { windowsHide: true }, (_err, stdout) => {
      resolve(/SkyrimSE\.exe/i.test(stdout || ''));
    });
  });
}

function killGameProcesses(): Promise<void> {
  return new Promise((resolve) => {
    exec(
      'taskkill /F /T /IM SkyrimSE.exe & taskkill /F /T /IM skse64_loader.exe & ' +
      'taskkill /F /IM "SkyrimPlatformCEF.exe.hidden" & taskkill /F /IM "SkyrimPlatformCEF.exe"',
      { windowsHide: true },
      () => resolve()
    );
  });
}

function readStamp(gamePath: string, filename: string) {
  try {
    const stampPath = path.join(gamePath, filename);
    if (fs.existsSync(stampPath)) return fs.readFileSync(stampPath, 'utf8').trim();
  } catch {}
  return null;
}

function writeStamp(gamePath: string, filename: string, value: string) {
  fs.writeFileSync(path.join(gamePath, filename), String(value).trim());
}

function readInstalledModsParts(gamePath: string): Record<string, string | null> {
  try {
    const partsPath = path.join(gamePath, MODS_PARTS_FILENAME);
    if (fs.existsSync(partsPath)) return JSON.parse(fs.readFileSync(partsPath, 'utf8')) || {};
  } catch {}
  return {};
}

function writeInstalledModsParts(gamePath: string, value: Record<string, string | null>) {
  fs.writeFileSync(path.join(gamePath, MODS_PARTS_FILENAME), JSON.stringify(value, null, 2));
}

function clientManifestUrl() {
  return DIST_REPO ? `https://github.com/${DIST_REPO}/releases/latest/download/client-update.json` : '';
}

function modsManifestUrl() {
  return DIST_REPO ? `https://github.com/${DIST_REPO}/releases/download/mods/mods-dist.json` : '';
}

// ─── Voz ───────────────────────────────────────────────────────────────────
//
// A decisão de o QUE fazer vive em `voice-dist.mjs`, sem I/O e coberta por
// teste. O que está aqui é só o efeito: disco, rede, processo. A divisão é a
// mesma do `parity.mjs`, e existe porque nada disto seria testável dentro de um
// `ipcMain.handle` que precisa de um Electron, um servidor e um jogo abertos.

function voiceManifestUrl() {
  return DIST_REPO ? `https://github.com/${DIST_REPO}/releases/download/voice/voice-dist.json` : '';
}

function voiceHelperPath(gamePath: string) {
  return path.join(gamePath, ...VOICE_INSTALL_DIR.split('/'), VOICE_HELPER_EXE);
}

function readVoicePreferences(): ReturnType<typeof sanitizeVoicePreferences> {
  return sanitizeVoicePreferences(readLauncherConfig().voice);
}

/**
 * Uma porta de loopback livre para o canal de controle do helper.
 *
 * Pedida ao SO (porta 0) e devolvida, em vez de um número fixo: uma porta fixa
 * colide com qualquer outra coisa que já a tenha, e a colisão apareceria como
 * "a voz não funciona nesta máquina" — o sintoma mais caro de diagnosticar.
 */
function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('sem porta livre'))));
    });
  });
}

/**
 * Mata o helper. Idempotente — `stop` num processo já morto é sucesso.
 *
 * Chamado de todos os caminhos de saída porque o helper segura o microfone pelo
 * WASAPI: deixá-lo vivo depois do jogo é um microfone aberto que ninguém vê.
 */
function stopVoiceHelper(): Promise<void> {
  return new Promise((resolve) => {
    const proc = voiceHelperProcess;
    voiceHelperProcess = null;
    voiceControlPort = 0;
    voicePairingToken = '';
    if (!proc || proc.killed || proc.exitCode !== null) {
      // Rede de segurança: um helper órfão de uma execução anterior (launcher
      // fechado à força, crash) não seria alcançado pelo handle acima.
      exec(`taskkill /F /IM "${VOICE_HELPER_EXE}"`, { windowsHide: true }, () => resolve());
      return;
    }
    try { proc.kill(); } catch {}
    exec(`taskkill /F /T /PID ${proc.pid}`, { windowsHide: true }, () => resolve());
  });
}

/**
 * Sobe o helper e devolve o que a CEF precisa saber para entregar o ticket.
 *
 * **Nunca lança.** Voz que não sobe é voz ausente, e voz ausente não pode
 * impedir alguém de entrar no jogo — é a mesma regra do gateway do gamemode,
 * aplicada ao lado do cliente.
 */
async function startVoiceHelper(gamePath: string): Promise<{ started: boolean; reason: string }> {
  await stopVoiceHelper();

  const prefs = readVoicePreferences();
  if (!prefs.enabled) return { started: false, reason: 'o jogador desligou a voz nas preferências' };

  const exe = voiceHelperPath(gamePath);
  if (!fs.existsSync(exe)) return { started: false, reason: 'voice-helper.exe não está instalado' };

  try {
    voiceControlPort = await pickFreeLoopbackPort();
    // Novo a cada execução, só em memória e no config local. É o que impede
    // qualquer outro processo da máquina de mandar um ticket ao helper.
    voicePairingToken = crypto.randomBytes(24).toString('hex');

    const args = helperArgs({ controlPort: voiceControlPort, pairingToken: voicePairingToken });
    const proc = spawn(exe, args, {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: 'ignore',
      // `detached: false` para o helper morrer junto se o launcher for derrubado
      // de um jeito que não passa pelo `before-quit`.
      detached: false
    });
    proc.on('exit', () => { if (voiceHelperProcess === proc) voiceHelperProcess = null; });
    proc.on('error', () => { if (voiceHelperProcess === proc) voiceHelperProcess = null; });
    voiceHelperProcess = proc;
    return { started: true, reason: `helper iniciado na porta ${voiceControlPort}` };
  } catch (e: any) {
    voiceControlPort = 0;
    voicePairingToken = '';
    return { started: false, reason: `falha ao iniciar o helper: ${e && e.message}` };
  }
}

function crashlogDirs() {
  const skseDir = path.join(app.getPath('documents'), 'My Games', 'Skyrim Special Edition', 'SKSE');
  return [skseDir, path.join(skseDir, 'Crashlogs')];
}

function collectRecentCrashLogs(limit = 2) {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const files: Array<{ name: string; fullPath: string; mtime: number }> = [];
  for (const dir of crashlogDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (!/^crash-.*\.(log|txt)$/i.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      if (!stat.isFile() || stat.mtimeMs < since) continue;
      files.push({ name: entry, fullPath, mtime: stat.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function postJsonToApi(pathname: string, body: any): Promise<any> {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body);
    const req = http.request({
      hostname: SERVER_IP,
      port: API_PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: res.statusCode && res.statusCode < 300, status: res.statusCode }); }
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('discord-login', async () => {
  return new Promise((resolve) => {
    const oauthState = crypto.randomBytes(16).toString('hex');
    let settled = false;
    const finish = (value: any) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const callbackServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', 'http://localhost:19847');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (!state || state !== oauthState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro: parâmetro state inválido ou ausente.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro: código de autorização não recebido.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        // A troca de `code` por token roda no painel web, não aqui: o client
        // secret do Discord não pode viajar dentro de um instalador que os
        // jogadores baixam. Ver POST /api/launcher/oauth/exchange em
        // apps/web/server.js e docs/technical/LAUNCHER_DISTRIBUTION.md.
        const exchange = await postJsonToUrl(`${PANEL_URL}/api/launcher/oauth/exchange`, {
          code,
          redirect_uri: DISCORD_REDIRECT_URI,
        });

        if (exchange.status !== 200 || !exchange.data || !exchange.data.discordId) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Erro ao concluir o login. Verifique se o painel do servidor está acessível.</h1>');
          callbackServer.close();
          finish(null);
          return;
        }

        const user = exchange.data;
        const authData = {
          discordId: user.discordId,
          username: user.username,
          globalName: user.globalName || user.username,
          avatar: user.avatar || null,
          // Prova de que este Discord autenticou de fato, emitida pelo painel.
          // É o que a fila (apps/game-api) exige — `discordId` sozinho é público
          // e não prova nada. Vem ausente se a conta ainda não existe no painel
          // (jogador que nunca pediu whitelist).
          launchTicket: user.launchTicket || null,
          loginDate: new Date().toISOString(),
        };

        writeAuthFile(authData);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#c9a227;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
              <div style="text-align:center;">
                <h1>✅ Login realizado com sucesso!</h1>
                <p style="color:#d6d3d1;">Bem-vindo, ${escapeHtml(authData.globalName)}! Pode fechar esta janela.</p>
              </div>
            </body>
          </html>
        `);

        callbackServer.close();
        if (authWindow && !authWindow.isDestroyed()) {
          authWindow.close();
        }
        finish(authData);
      } catch (err) {
        console.error('OAuth2 callback error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Erro interno.</h1>');
        callbackServer.close();
        finish(null);
      }
    });

    callbackServer.listen(19847, '127.0.0.1', () => {
      console.log('OAuth2 callback server listening on 127.0.0.1:19847');
    });

    const authUrl = `https://discord.com/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&scope=identify&state=${oauthState}`;

    let authWindow: BrowserWindow | null = new BrowserWindow({
      width: 500,
      height: 750,
      parent: mainWindow || undefined,
      modal: !!mainWindow,
      title: 'Entrar com Discord',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        // No preload script: this window only performs the Discord OAuth
        // flow and must never get access to electronAPI.
      }
    });

    authWindow.setMenuBarVisibility(false);
    authWindow.loadURL(authUrl);

    authWindow.on('closed', () => {
      authWindow = null;
      callbackServer.close(() => {});
      // If the window was closed before the OAuth callback fired, don't leave
      // the caller hanging until the 5 minute timeout below.
      finish(null);
    });

    setTimeout(() => {
      callbackServer.close(() => {});
      if (authWindow && !authWindow.isDestroyed()) {
        authWindow.close();
      }
      finish(null);
    }, 5 * 60 * 1000);
  });
});

ipcMain.handle('discord-logout', async () => {
  clearAuthFile();
  return true;
});

ipcMain.handle('get-auth-status', async () => {
  const auth = readAuthFile();
  if (!auth || !auth.discordId) return null;
  return {
    discordId: auth.discordId,
    username: auth.username,
    globalName: auth.globalName,
    avatar: auth.avatar,
    loginDate: auth.loginDate,
  };
});

// ─── Queue System ───
//
// A fila é autenticada por ticket, não por `discordId`: discordId é público, e
// mandá-lo como prova de identidade deixaria qualquer um entrar na fila no
// lugar de outro jogador. O ticket inicial vem do painel no login; cada consulta
// consome o ticket atual e recebe o próximo (`pollTicket`), então um ticket
// interceptado já está gasto quando chega em outras mãos.

/**
 * Guarda o ticket da próxima consulta de fila. Vive só em memória de propósito:
 * é de uso único e curto, não faz sentido persistir entre execuções.
 */
let currentQueueTicket: string | null = null;

function nextQueueTicket(): string | null {
  const auth = readAuthFile();
  return currentQueueTicket || (auth && auth.launchTicket) || null;
}

function rememberQueueTicket(response: any) {
  if (response && typeof response.pollTicket === 'string') {
    currentQueueTicket = response.pollTicket;
    delete response.pollTicket; // o renderer não precisa nem deve ver o ticket
  }
  return response;
}

ipcMain.handle('join-queue', async () => {
  const ticket = nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/join`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// O ticket vai no corpo do POST, igual ao `join-queue` acima. Já foi query
// string de um GET: query string entra em log de acesso e de proxy, e o ticket
// é credencial — quem o tem consulta a fila como aquela conta. Ver
// `SEC-QS-01` em docs/roadmap/ECOSYSTEM_ADAPTATION_ROADMAP.md.
ipcMain.handle('poll-queue', async () => {
  const ticket = nextQueueTicket();
  if (!ticket) return { status: 'error', message: 'not_authenticated' };

  const response = await postJsonToUrl(
    `http://${SERVER_IP}:${API_PORT}/api/queue/status`,
    { ticket }
  );

  if (response.status === 0) return { status: 'error', message: 'connection_failed' };
  if (!response.data) return { status: 'error', message: 'invalid_response' };
  return rememberQueueTicket(response.data);
});

// ─── Mod Manager ───
function listDataPlugins(folderPath: string) {
  const dataPath = path.join(folderPath, 'Data');
  if (!fs.existsSync(dataPath)) return [];
  return fs.readdirSync(dataPath).filter(file =>
    file.toLowerCase().endsWith('.esp') ||
    file.toLowerCase().endsWith('.esl') ||
    file.toLowerCase().endsWith('.esm')
  );
}

function readPluginHeader(filePath: string): PluginHeader {
  // O I/O fica aqui; o parsing vive em parity.mjs, testado com plugin
  // sintetico. Lemos so o comeco do arquivo: o bloco de masters fica no
  // cabecalho, e um .esm de Skyrim tem centenas de MB.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    if (head.length >= 8) {
      const dataSize = head.readUInt32LE(4);
      const cap = Math.min(dataSize, 1024 * 1024);
      const corpo = Buffer.alloc(cap);
      fs.readSync(fd, corpo, 0, cap, 24);
      return parsePluginHeader(Buffer.concat([head, corpo]));
    }
    return parsePluginHeader(head);
  } catch (e: any) {
    return { masters: [], isMaster: false, isLight: false, error: e.message };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

ipcMain.handle('get-local-plugins', async (_event, folderPath) => {
  if (!folderPath) return { plugins: [], pluginsTxt: [] };
  try {
    const plugins = listDataPlugins(folderPath);
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtPath = path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
    const pluginsTxt = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8'))
      : [];
    return { plugins, pluginsTxt };
  } catch {
    return { plugins: [], pluginsTxt: [] };
  }
});

ipcMain.handle('verify-mods', async (_event, folderPath) => {
  if (!folderPath) return { success: false, error: "Caminho do jogo inválido." };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { success: false, error: "Pasta Data não encontrada." };

    const modsJson: any = await new Promise((resolve) => {
      http.get(`http://${SERVER_IP}:${API_PORT}/mods.json`, (res) => {
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!modsJson || !modsJson.mods) {
      return { success: false, error: "Falha ao baixar mods.json do servidor. Servidor pode estar offline." };
    }

    const allFiles = fs.readdirSync(dataPath);
    const hashOf = (filename: string) => {
      const h = crypto.createHash('md5');
      h.update(fs.readFileSync(path.join(dataPath, filename)));
      return h.digest('hex');
    };

    const resultado = compareMods({ serverMods: modsJson.mods, localFiles: allFiles, hashOf });
    if (!resultado.success) return resultado;

    return { success: true, loadOrder: modsJson.loadOrder };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('analyze-plugins', async (_event, folderPath, serverLoadOrder) => {
  if (!folderPath) return { ok: false, problems: ['Caminho do jogo invalido.'], plugins: [] };
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return { ok: false, problems: ['Pasta Data nao encontrada.'], plugins: [] };

    // A load order real vem do plugins.txt, nao dos arquivos presentes em
    // Data/: um plugin no disco e desativado nao ocupa indice e nao desloca
    // FormID nenhum. Sem o arquivo, parity.mjs cai para os arquivos presentes,
    // que e a direcao segura.
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtPath = path.join(localAppData, 'Skyrim Special Edition', 'plugins.txt');
    const enabledPlugins = fs.existsSync(pluginsTxtPath)
      ? parsePluginsTxt(fs.readFileSync(pluginsTxtPath, 'utf8')).filter(p => p.enabled).map(p => p.name)
      : undefined;

    const localPlugins = listDataPlugins(folderPath);

    const resultado = analyzePlugins({
      localPlugins,
      serverLoadOrder,
      enabledPlugins,
      readHeader: (nome: string) => readPluginHeader(path.join(dataPath, nome))
    });

    // Creation Club nao passa pelo plugins.txt: o Skyrim AE le o Skyrim.ccc e
    // carrega sozinho o que estiver listado e presente em Data/. Sao plugins
    // que ocupam indice de load order e que a checagem acima nao enxerga.
    //
    // O arquivo fica na raiz do jogo, ao lado do executavel — nao em Data/. E
    // o conteudo dele varia conforme o que a conta Steam possui, entao dois
    // testadores podem carregar listas diferentes sem ter escolhido nada.
    const cccPath = path.join(folderPath, 'Skyrim.ccc');
    const cccEntries = fs.existsSync(cccPath)
      ? parseCccTxt(fs.readFileSync(cccPath, 'utf8'))
      : [];

    const cc = analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder });

    return {
      ...resultado,
      ok: resultado.ok && cc.ok,
      problems: [...resultado.problems, ...cc.problems],
      creationClub: cc.effective
    };
  } catch (e: any) {
    return { ok: false, problems: [e.message], plugins: [] };
  }
});

ipcMain.handle('sync-loadorder', async (_event, folderPath, serverLoadOrder) => {
  if (!folderPath || !Array.isArray(serverLoadOrder)) return false;
  try {
    const dataPath = path.join(folderPath, 'Data');
    if (!fs.existsSync(dataPath)) return false;

    const allFiles = fs.readdirSync(dataPath);
    const diskPlugins = allFiles.filter(f => f.toLowerCase().endsWith('.esp') || f.toLowerCase().endsWith('.esl') || f.toLowerCase().endsWith('.esm'));

    const resultLines = [
      '# This file is managed by Skyrim Heavy RP Launcher.',
      '# Do not modify manually.'
    ];

    for (const plugin of serverLoadOrder) {
      const match = diskPlugins.find(p => p.toLowerCase() === plugin.toLowerCase());
      if (match) resultLines.push('*' + match);
    }

    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const pluginsTxtDir = path.join(localAppData, 'Skyrim Special Edition');
    if (!fs.existsSync(pluginsTxtDir)) fs.mkdirSync(pluginsTxtDir, { recursive: true });
    
    fs.writeFileSync(path.join(pluginsTxtDir, 'plugins.txt'), resultLines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('is-game-running', async () => isGameRunning());

ipcMain.handle('kill-game', async () => {
  // A ordem vem de `shutdownOrder()` e não é arbitrária: o helper segura o
  // microfone, e matar o jogo primeiro deixaria uma janela — curta, mas real —
  // com o jogo fechado e o microfone ainda aberto.
  for (const alvo of shutdownOrder()) {
    if (alvo === 'voice-helper') await stopVoiceHelper();
    else await killGameProcesses();
  }
  return true;
});

ipcMain.handle('check-client-update', async (_event, gamePath) => {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  const manifest = await httpGetJson(clientManifestUrl());
  if (!manifest || !manifest.clientVersion) return { updateAvailable: false, error: 'Manifesto de cliente indisponivel.' };
  const installedVersion = gamePath ? readStamp(gamePath, CLIENT_VERSION_FILENAME) : null;
  return {
    updateAvailable: installedVersion !== manifest.clientVersion,
    installedVersion,
    version: manifest.clientVersion,
    notes: manifest.notes || '',
    sizeBytes: manifest.sizeBytes || 0
  };
});

ipcMain.handle('install-client-update', async (_event, gamePath) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_client_update.zip');
  try {
    const manifest = await httpGetJson(clientManifestUrl());
    if (!manifest || !manifest.downloadUrl) return { success: false, error: 'Manifesto de cliente invalido.' };
    send('download', 0);
    await downloadToFile(manifest.downloadUrl, tmpZip, percent => send('download', percent));
    if (!manifest.sha256) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'Manifesto de cliente sem SHA256: verificacao de integridade obrigatoria ausente.' };
    }
    send('verify', 0);
    const actual = await sha256File(tmpZip);
    if (actual.toLowerCase() !== String(manifest.sha256).toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: 'SHA256 do cliente nao confere.' };
    }
    send('verify', 100);
    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));
    send('extract', 0);
    await extractZip(tmpZip, gamePath);
    send('extract', 100);
    writeStamp(gamePath, CLIENT_VERSION_FILENAME, manifest.clientVersion);
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: true, version: manifest.clientVersion };
  } catch (e: any) {
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: false, error: e.message };
  }
});

ipcMain.handle('check-voice-update', async (_event, gamePath) => {
  const prefs = readVoicePreferences();
  const raw = DIST_REPO ? await httpGetJson(voiceManifestUrl()).catch(() => null) : null;
  const parsed = parseVoiceManifest(raw);
  const decision = decideVoiceAction({
    parsed,
    installedVersion: gamePath ? readStamp(gamePath, VOICE_STAMP_FILENAME) : null,
    exePresent: gamePath ? fs.existsSync(voiceHelperPath(gamePath)) : false,
    clientVersion: gamePath ? readStamp(gamePath, CLIENT_VERSION_FILENAME) : null,
    voiceEnabled: prefs.enabled
  });
  return {
    ...decision,
    updateAvailable: decision.action === 'install' || decision.action === 'update' || decision.action === 'reinstall',
    installedVersion: gamePath ? readStamp(gamePath, VOICE_STAMP_FILENAME) : null
  };
});

ipcMain.handle('install-voice-update', async (_event, gamePath) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar a voz.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_voice_update.zip');
  try {
    const parsed = parseVoiceManifest(await httpGetJson(voiceManifestUrl()));
    // Manifesto ruim NAO impede o jogo: a voz simplesmente nao instala. Quem
    // decide isso e `decideVoiceAction`; aqui so nao se prossegue.
    if (parsed.ok !== true) return { success: false, error: parsed.reason };

    // O helper precisa estar parado antes de o arquivo ser substituido — no
    // Windows um .exe em execucao nao pode ser sobrescrito, e a extracao
    // falharia no meio deixando a instalacao pela metade.
    await stopVoiceHelper();

    send('download', 0);
    await downloadToFile(parsed.manifest.downloadUrl, tmpZip, percent => send('download', percent));

    send('verify', 0);
    const conferencia = verifyHash(parsed.manifest.sha256, await sha256File(tmpZip));
    if (!conferencia.ok) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { success: false, error: `Integridade da voz: ${conferencia.reason}` };
    }
    send('verify', 100);

    const destino = path.join(gamePath, ...VOICE_INSTALL_DIR.split('/'));
    if (!fs.existsSync(destino)) fs.mkdirSync(destino, { recursive: true });
    send('extract', 0);
    await extractZip(tmpZip, destino);
    send('extract', 100);

    writeStamp(gamePath, VOICE_STAMP_FILENAME, parsed.manifest.voiceVersion);
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: true, version: parsed.manifest.voiceVersion };
  } catch (e: any) {
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-voice-preferences', async () => readVoicePreferences());

ipcMain.handle('save-voice-preferences', async (_event, raw) => {
  const config = readLauncherConfig();
  config.voice = sanitizeVoicePreferences(raw);
  writeLauncherConfig(config);
  return config.voice;
});

/** Diagnóstico do lado do launcher. Sem ticket, sem credencial. */
ipcMain.handle('get-voice-status', async (_event, gamePath) => ({
  enabled: readVoicePreferences().enabled,
  installedVersion: gamePath ? readStamp(gamePath, VOICE_STAMP_FILENAME) : null,
  exePresent: gamePath ? fs.existsSync(voiceHelperPath(gamePath)) : false,
  helperRunning: voiceHelperProcess !== null && voiceHelperProcess.exitCode === null,
  controlPort: voiceControlPort || null
}));

ipcMain.handle('check-mods-update', async (_event, gamePath) => {
  if (!DIST_REPO) return { updateAvailable: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };
  const manifest = await httpGetJson(modsManifestUrl());
  if (!manifest || !manifest.modsVersion) return { updateAvailable: false, error: 'Manifesto de mods indisponivel.' };
  const installedVersion = gamePath ? readStamp(gamePath, MODS_VERSION_FILENAME) : null;
  return {
    updateAvailable: installedVersion !== manifest.modsVersion,
    installedVersion,
    version: manifest.modsVersion,
    notes: manifest.notes || '',
    mandatory: !!manifest.mandatory,
    sizeBytes: manifest.sizeBytes || 0
  };
});

ipcMain.handle('install-mods-update', async (_event, gamePath, force) => {
  if (!gamePath) return { success: false, error: 'Caminho do jogo invalido.' };
  if (await isGameRunning()) return { success: false, gameRunning: true, error: 'O jogo esta aberto. Feche antes de atualizar mods.' };
  if (!DIST_REPO) return { success: false, error: 'VITE_GITHUB_DIST_REPO nao configurado.' };

  const send = (phase: string, percent: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mods-update-progress', { phase, percent });
  };
  const tmpZip = path.join(app.getPath('temp'), 'skymp_mods_update.zip');
  try {
    const manifest = await httpGetJson(modsManifestUrl());
    if (!manifest || (!manifest.downloadUrl && !Array.isArray(manifest.parts))) return { success: false, error: 'Manifesto de mods invalido.' };
    const installedVersion = readStamp(gamePath, MODS_VERSION_FILENAME);
    if (!force && installedVersion === manifest.modsVersion) {
      return { success: true, version: manifest.modsVersion, alreadyCurrent: true };
    }

    const parts = Array.isArray(manifest.parts) && manifest.parts.length > 0
      ? manifest.parts
      : [{ url: manifest.downloadUrl, sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, contentSig: manifest.contentSig, name: 'single' }];
    const installedParts = force ? {} : readInstalledModsParts(gamePath);
    const finalParts: Record<string, string | null> = {};

    await killGameProcesses();
    await new Promise(resolve => setTimeout(resolve, 900));

    let downloaded = 0;
    let skipped = 0;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const partKey = part.name || part.url;
      finalParts[partKey] = part.contentSig || null;
      const base = Math.round((index / parts.length) * 100);
      const span = Math.max(1, Math.round(100 / parts.length));
      if (!force && part.contentSig && installedParts[partKey] === part.contentSig) {
        skipped += 1;
        send('extract', Math.min(100, base + span));
        continue;
      }
      downloaded += 1;
      send('download', base);
      await downloadToFile(part.url, tmpZip, percent => send('download', Math.min(100, base + Math.round(percent * span / 100))));
      if (!part.sha256) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `Parte ${index + 1} sem SHA256: verificacao de integridade obrigatoria ausente.` };
      }
      send('verify', base);
      const actual = await sha256File(tmpZip);
      if (actual.toLowerCase() !== String(part.sha256).toLowerCase()) {
        try { fs.unlinkSync(tmpZip); } catch {}
        return { success: false, error: `SHA256 dos mods nao confere na parte ${index + 1}.` };
      }
      send('extract', base);
      await extractZip(tmpZip, gamePath);
      try { fs.unlinkSync(tmpZip); } catch {}
    }

    send('extract', 100);
    writeInstalledModsParts(gamePath, finalParts);
    writeStamp(gamePath, MODS_VERSION_FILENAME, manifest.modsVersion);
    return { success: true, version: manifest.modsVersion, downloaded, skipped };
  } catch (e: any) {
    try { fs.unlinkSync(tmpZip); } catch {}
    return { success: false, error: e.message };
  }
});

// ─── Game Launch ───
ipcMain.handle('get-recent-crashes', async () => {
  return collectRecentCrashLogs(5).map(file => ({
    name: file.name,
    mtime: file.mtime
  }));
});

ipcMain.handle('report-recent-crashes', async () => {
  const auth = readAuthFile();
  const config = readLauncherConfig();
  const crashes = collectRecentCrashLogs(2);
  if (crashes.length === 0) return { ok: true, sent: 0 };

  const payload = {
    discordId: auth?.discordId || null,
    username: auth?.globalName || auth?.username || null,
    clientVersion: config.gamePath ? readStamp(config.gamePath, CLIENT_VERSION_FILENAME) : null,
    launcherVersion: app.getVersion(),
    crashes: crashes.map(file => {
      const raw = fs.readFileSync(file.fullPath);
      const maxBytes = 60 * 1024;
      const content = raw.length > maxBytes
        ? Buffer.concat([raw.subarray(0, maxBytes), Buffer.from('\n...[truncado pelo launcher]')]).toString('utf8')
        : raw.toString('utf8');
      return { filename: file.name, mtime: file.mtime, content };
    })
  };

  const result = await postJsonToApi('/api/crashes/client', payload);
  return { ok: !!result?.ok || result?.status === 'ok', sent: crashes.length, response: result };
});

ipcMain.handle('launch-game', async (_event, folderPath, ticket) => {
  if (!folderPath) return false;
  const exePath = path.join(folderPath, 'skse64_loader.exe');
  if (!fs.existsSync(exePath)) return false;

  try {
    const auth = readAuthFile();
    if (auth && auth.discordId) {
      const configPath = path.join(folderPath, 'Data', 'Platform', 'Plugins', 'skymp_config.json');
      let config: any = {};
      if (fs.existsSync(configPath)) {
        try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
      }
      
      config.session = `ticket:${ticket || ''}`;
      config.serverAddress = `${SERVER_IP}:${SERVER_PORT}`;
      config.discordId = auth.discordId;
      delete config.profileId;

      // A voz sobe ANTES do jogo, para que a porta de controle e o segredo de
      // pareamento já estejam no config quando a CEF ler o arquivo. Ao
      // contrário, o primeiro `/voz` da sessão não teria para onde mandar o
      // ticket.
      //
      // `startVoiceHelper` nunca lança: se a voz não subir, o objeto abaixo diz
      // `helperRunning: false` e o jogo abre igual. VOICE FAILURE NEVER GAME
      // FAILURE começa aqui, no lado do cliente.
      const voz = await startVoiceHelper(folderPath);
      if (voz.started) {
        Object.assign(config, voiceConfigForClient({
          controlPort: voiceControlPort,
          pairingToken: voicePairingToken,
          voiceVersion: readStamp(folderPath, VOICE_STAMP_FILENAME),
          helperRunning: true
        }));
      } else {
        // Sem helper não há canal, e escrever uma URL com porta 0 seria pior que
        // não escrever nada: a CEF tentaria falar com ela e o erro apareceria
        // longe daqui. O que fica é a ausência, dita por extenso.
        config.voice = { helperRunning: false, reason: voz.reason, pushToTalk: true };
        console.warn('[voice] helper não iniciado:', voz.reason);
      }


      const configDir = path.dirname(configPath);
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const clientSettingsPath = path.join(folderPath, 'Data', 'Platform', 'Plugins', 'skymp5-client-settings.txt');
      let clientSettings: any = {};
      if (fs.existsSync(clientSettingsPath)) {
        try { clientSettings = JSON.parse(fs.readFileSync(clientSettingsPath, 'utf8')); } catch {}
      }
      if (!clientSettings.gameData) clientSettings.gameData = {};
      
      delete clientSettings.gameData.token;
      delete clientSettings.gameData.session;
      
      clientSettings.gameData.profileId = parseInt(auth.discordId.slice(-8), 10) || 0;
      clientSettings.gameData.launcherTicket = String(ticket || '');
      clientSettings['server-ip'] = SERVER_IP;
      clientSettings['server-port'] = SERVER_PORT;
      clientSettings['master'] = '';
      
      fs.writeFileSync(clientSettingsPath, JSON.stringify(clientSettings, null, 2));
    }
  } catch (e) {
    console.error('Error injecting session:', e);
  }

  exec('taskkill /F /T /IM SkyrimSE.exe & taskkill /F /T /IM skse64_loader.exe & taskkill /F /IM "SkyrimPlatformCEF.exe.hidden" & taskkill /F /IM "SkyrimPlatformCEF.exe"', () => {
    exec(`"${exePath}"`, { cwd: folderPath });
  });

  return true;
});

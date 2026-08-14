import { contextBridge, ipcRenderer } from 'electron';

const api = {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowClose: () => ipcRenderer.send('window-close'),
  getLauncherConfig: () => ipcRenderer.invoke('get-launcher-config'),
  saveGamePath: (folderPath: string) => ipcRenderer.invoke('save-game-path', folderPath),
  selectGamePath: () => ipcRenderer.invoke('select-game-path'),
  checkGamePath: (folderPath: string) => ipcRenderer.invoke('check-game-path', folderPath),
  ensureSkyrimIni: (opts?: any) => ipcRenderer.invoke('ensure-skyrim-ini', opts),
  getDisplaySettings: () => ipcRenderer.invoke('get-display-settings'),
  discordLogin: () => ipcRenderer.invoke('discord-login'),
  discordLogout: () => ipcRenderer.invoke('discord-logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  joinQueue: () => ipcRenderer.invoke('join-queue'),
  pollQueue: () => ipcRenderer.invoke('poll-queue'),
  getLocalPlugins: (folderPath: string) => ipcRenderer.invoke('get-local-plugins', folderPath),
  verifyMods: (folderPath: string) => ipcRenderer.invoke('verify-mods', folderPath),
  analyzePlugins: (folderPath: string, serverLoadOrder?: string[]) => ipcRenderer.invoke('analyze-plugins', folderPath, serverLoadOrder),
  syncLoadorder: (folderPath: string, serverLoadOrder: string[]) => ipcRenderer.invoke('sync-loadorder', folderPath, serverLoadOrder),
  isGameRunning: () => ipcRenderer.invoke('is-game-running'),
  killGame: () => ipcRenderer.invoke('kill-game'),
  checkClientUpdate: (folderPath: string) => ipcRenderer.invoke('check-client-update', folderPath),
  installClientUpdate: (folderPath: string) => ipcRenderer.invoke('install-client-update', folderPath),
  checkModsUpdate: (folderPath: string) => ipcRenderer.invoke('check-mods-update', folderPath),
  installModsUpdate: (folderPath: string, force?: boolean) => ipcRenderer.invoke('install-mods-update', folderPath, force),
  // Voz. Nenhum destes canais carrega ticket ou credencial de servidor: o
  // ticket é emitido dentro do jogo e vai da CEF direto ao helper, sem passar
  // pelo renderer do launcher.
  checkVoiceUpdate: (folderPath: string) => ipcRenderer.invoke('check-voice-update', folderPath),
  installVoiceUpdate: (folderPath: string) => ipcRenderer.invoke('install-voice-update', folderPath),
  getVoicePreferences: () => ipcRenderer.invoke('get-voice-preferences'),
  saveVoicePreferences: (prefs: any) => ipcRenderer.invoke('save-voice-preferences', prefs),
  getVoiceStatus: (folderPath: string) => ipcRenderer.invoke('get-voice-status', folderPath),
  getRecentCrashes: () => ipcRenderer.invoke('get-recent-crashes'),
  reportRecentCrashes: () => ipcRenderer.invoke('report-recent-crashes'),
  onUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (_event, value) => callback(value));
  },
  onModsUpdateProgress: (callback: (value: any) => void) => {
    ipcRenderer.removeAllListeners('mods-update-progress');
    ipcRenderer.on('mods-update-progress', (_event, value) => callback(value));
  },
  launchGame: (folderPath: string, ticket: string) => ipcRenderer.invoke('launch-game', folderPath, ticket)
};

contextBridge.exposeInMainWorld('electronAPI', api);

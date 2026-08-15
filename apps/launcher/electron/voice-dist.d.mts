/**
 * Tipos de `voice-dist.mjs`.
 *
 * Mesmo arranjo do `parity.d.mts`: o módulo é JS puro para que `node --test`
 * rode sem passo de build, e esta declaração é o que mantém o `main.ts`
 * typechecked ao importá-lo.
 */

export const VOICE_STAMP_FILENAME: string;
export const VOICE_INSTALL_DIR: string;
export const VOICE_HELPER_EXE: string;

export interface VoiceManifest {
  voiceVersion: string;
  downloadUrl: string;
  sha256: string;
  sizeBytes: number | null;
  minClientVersion: string | null;
  protocolVersion: number | null;
  mandatory: boolean;
  notes: string;
}

export type ParsedVoiceManifest =
  | { ok: true; manifest: VoiceManifest }
  | { ok: false; reason: string };

export function parseVoiceManifest(raw: unknown): ParsedVoiceManifest;

export function compareVersions(a: string, b: string): number;

export function decideVoiceAction(args: {
  parsed: ParsedVoiceManifest;
  installedVersion: string | null;
  exePresent: boolean;
  clientVersion?: string | null;
  voiceEnabled?: boolean;
}): {
  action: 'skip' | 'install' | 'update' | 'reinstall' | 'ok' | 'blocked';
  reason: string;
  targetVersion?: string;
  mandatory?: boolean;
};

export function verifyHash(expected: string, actual: string): { ok: boolean; reason?: string };

export function helperArgs(args: {
  controlPort: number;
  pairingToken: string;
  logLevel?: string;
  /** pid do launcher; o helper sai quando ele morrer. Omitido = sem guarda. */
  parentPid?: number;
}): string[];

export function voiceConfigForClient(args: {
  controlPort: number;
  pairingToken: string;
  voiceVersion: string | null;
  helperRunning: boolean;
}): {
  voice: {
    helperControlUrl: string;
    pairingToken: string;
    voiceVersion: string | null;
    helperRunning: boolean;
    pushToTalk: boolean;
  };
};

export function shutdownOrder(): string[];

export function sanitizeVoicePreferences(raw: unknown): {
  enabled: boolean;
  inputDeviceId: string | null;
  outputVolume: number;
  inputGain: number;
  pushToTalk: boolean;
};

// アプリ・フォルダのパスコード（feature-spec.md §2-1、§2-3）
// パスコードは平文で保存せず、ソルト付きハッシュを Keychain（expo-secure-store）に置く。
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const APP_KEY = 'passcode.app';
const folderKey = (folderId: number) => `passcode.folder.${folderId}`;

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;

type Stored = { salt: string; hash: string };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPasscode(passcode: string, salt: string): Promise<string> {
  // ストレッチングで総当たりを遅くする
  let digest = `${salt}:${passcode}`;
  for (let i = 0; i < 1000; i++) {
    digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, digest);
  }
  return digest;
}

async function save(key: string, passcode: string) {
  if (!/^\d{4}(\d{2})?$/.test(passcode)) {
    throw new Error('パスコードは4桁または6桁の数字にしてください');
  }
  const salt = toHex(Crypto.getRandomBytes(16));
  const value: Stored = { salt, hash: await hashPasscode(passcode, salt) };
  await SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function load(key: string): Promise<Stored | null> {
  const raw = await SecureStore.getItemAsync(key);
  return raw ? (JSON.parse(raw) as Stored) : null;
}

// 連続失敗の管理（アプリ実行中のみ保持）
const failures = new Map<string, { count: number; until: number }>();

export type VerifyResult = { ok: true } | { ok: false; lockedForMs: number; remaining: number };

async function verify(key: string, passcode: string): Promise<VerifyResult> {
  const state = failures.get(key) ?? { count: 0, until: 0 };
  const now = Date.now();
  if (state.until > now) {
    return { ok: false, lockedForMs: state.until - now, remaining: 0 };
  }
  const stored = await load(key);
  if (stored && (await hashPasscode(passcode, stored.salt)) === stored.hash) {
    failures.delete(key);
    return { ok: true };
  }
  const count = state.count + 1;
  if (count >= MAX_ATTEMPTS) {
    failures.set(key, { count: 0, until: now + LOCKOUT_MS });
    return { ok: false, lockedForMs: LOCKOUT_MS, remaining: 0 };
  }
  failures.set(key, { count, until: 0 });
  return { ok: false, lockedForMs: 0, remaining: MAX_ATTEMPTS - count };
}

export const appPasscode = {
  isSet: async () => (await load(APP_KEY)) != null,
  set: (passcode: string) => save(APP_KEY, passcode),
  clear: () => SecureStore.deleteItemAsync(APP_KEY),
  verify: (passcode: string) => verify(APP_KEY, passcode),
};

export const folderPasscode = {
  isSet: async (folderId: number) => (await load(folderKey(folderId))) != null,
  set: (folderId: number, passcode: string) => save(folderKey(folderId), passcode),
  clear: (folderId: number) => SecureStore.deleteItemAsync(folderKey(folderId)),
  verify: (folderId: number, passcode: string) => verify(folderKey(folderId), passcode),
};

export async function authenticateWithBiometrics(reason: string): Promise<boolean> {
  if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) {
    return false;
  }
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: reason,
    cancelLabel: 'パスコードを使う',
    disableDeviceFallback: true,
  });
  return result.success;
}

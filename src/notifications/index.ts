// ダウンロード・変換が終わったときのローカル通知（feature-spec.md §2-8）。アプリを開いているときは出さない
import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }),
});

let asked = false;

// 初めてダウンロードを始めたときに許可を求める
export async function ensureNotificationPermission() {
  if (asked) return;
  asked = true;
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.status === 'undetermined') await Notifications.requestPermissionsAsync();
  } catch {
    // 通知が使えなくても保存は続ける
  }
}

export async function notifyFinished(title: string, body: string) {
  if (AppState.currentState === 'active') return;
  try {
    await Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: null });
  } catch {
    // 許可がない等。通知できなくても保存は成功している
  }
}

// フォルダのロック解除状態。アプリがバックグラウンドに回るまで維持する（feature-spec.md §2-3）
import { AppState } from 'react-native';

const unlocked = new Set<number>();

AppState.addEventListener('change', (state) => {
  if (state === 'background') unlocked.clear();
});

export const folderUnlock = {
  isUnlocked: (folderId: number) => unlocked.has(folderId),
  unlock: (folderId: number) => {
    unlocked.add(folderId);
  },
  forget: (folderId: number) => {
    unlocked.delete(folderId);
  },
};

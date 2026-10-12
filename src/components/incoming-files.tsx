import { File, Paths } from 'expo-file-system';
import { useSQLiteContext } from 'expo-sqlite';
import { MediaTools } from 'media-tools';
import { useEffect } from 'react';
import { Alert } from 'react-native';

import { UNSORTED_FOLDER_ID } from '@/db/schema';
import { notifyJobsChanged } from '@/download/store';
import { onIncomingFiles, takeIncomingFiles } from '@/library/incoming';
import { importFiles } from '@/library/media-actions';

// 「このアプリで開く」で渡されたファイルを「未分類」に取り込む
export function IncomingFiles() {
  const db = useSQLiteContext();

  useEffect(() => {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        for (let uris = takeIncomingFiles(); uris.length > 0; uris = takeIncomingFiles()) {
          const assets = [];
          for (const [i, uri] of uris.entries()) {
            const name = decodeURIComponent(uri.split('/').pop() ?? 'file');
            const temp = new File(Paths.cache, `incoming-${Date.now()}-${i}-${name}`);
            try {
              if (MediaTools) await MediaTools.copySecurityScoped(uri, temp.uri);
              else new File(uri).copy(temp);
              assets.push({ uri: temp.uri, name });
            } catch {
              Alert.alert('取り込めませんでした', name);
            }
          }
          if (assets.length === 0) continue;
          const result = await importFiles(db, UNSORTED_FOLDER_ID, assets);
          notifyJobsChanged();
          if (result.imported > 0) {
            Alert.alert('取り込みました', `${result.imported}件を「未分類」に追加しました。`);
          }
          if (result.skipped.length > 0) {
            Alert.alert('対応していない形式です', result.skipped.join('\n'));
          }
        }
      } finally {
        running = false;
      }
    };
    run();
    return onIncomingFiles(run);
  }, [db]);

  return null;
}

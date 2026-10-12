// カメラロールから追加した写真を見る画面。左右にスワイプで同じフォルダの写真を切り替える
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { listMedia, type MediaItem } from '@/db/library';
import { mediaFile } from '@/download/storage';
import { colors } from '@/theme';

export default function PhotoScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const params = useLocalSearchParams<{ id: string; folderId?: string }>();
  const startId = Number(params.id);
  const folderId = Number(params.folderId ?? 0);
  const [photos, setPhotos] = useState<MediaItem[] | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listMedia(db, folderId, 'photo', { key: 'created_at', dir: 'desc' }).then((list) => {
      if (cancelled) return;
      setPhotos(list);
      setIndex(Math.max(0, list.findIndex((p) => p.id === startId)));
    });
    return () => {
      cancelled = true;
    };
  }, [db, folderId, startId]);

  const current = photos?.[index];

  return (
    <View style={styles.screen}>
      {photos ? (
        <FlatList
          data={photos}
          keyExtractor={(item) => String(item.id)}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <Image source={{ uri: mediaFile(item.filePath).uri }} style={{ width, height }} contentFit="contain" />
          )}
        />
      ) : null}

      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="閉じる" onPress={() => router.back()} style={styles.close}>
          <SymbolView name="xmark" tintColor={colors.text} size={18} weight="semibold" />
        </Pressable>
        <View style={styles.titleWrap}>
          <AppText variant="bodyBold" numberOfLines={1}>
            {current?.title ?? ''}
          </AppText>
          {photos && photos.length > 1 ? (
            <AppText variant="small" tone="secondary">
              {index + 1} / {photos.length}
            </AppText>
          ) : null}
        </View>
        <View style={styles.close} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  topBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flex: 1, alignItems: 'center' },
});

import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import type { DownloadStatus } from '@/db/downloads';
import { cancelJob, pauseJob, resumeJob } from '@/download/engine';
import { onJobsChanged, useLiveProgress } from '@/download/store';
import { colors, placeholderTint, radius } from '@/theme';

type Job = {
  id: number;
  title: string | null;
  kind: string;
  output: string;
  status: DownloadStatus;
  progress: number;
  error: string | null;
};

const ACTIVE: DownloadStatus[] = ['queued', 'downloading', 'paused', 'converting', 'error', 'blocked'];

export default function DownloadsScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const live = useLiveProgress();
  const [jobs, setJobs] = useState<Job[]>([]);

  const load = useCallback(async () => {
    setJobs(await db.getAllAsync<Job>('SELECT id, title, kind, output, status, progress, error FROM downloads ORDER BY created_at DESC LIMIT 200'));
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  useEffect(() => onJobsChanged(load), [load]);

  const active = jobs.filter((j) => ACTIVE.includes(j.status));
  const done = jobs.filter((j) => j.status === 'done');

  const clearHistory = () => {
    Alert.alert('完了の履歴を消去', '保存した動画は消えません。', [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '消去',
        style: 'destructive',
        onPress: async () => {
          await db.runAsync("DELETE FROM downloads WHERE status = 'done'");
          load();
        },
      },
    ]);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <AppText variant="largeTitle" accessibilityRole="header" style={styles.title}>
        ダウンロード
      </AppText>
      <SectionList
        sections={[
          { key: 'active', title: `進行中・${active.length}件`, data: active },
          { key: 'done', title: '完了', data: done },
        ]}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <AppText variant="caption" tone="secondary" style={styles.sectionTitle}>
              {section.title}
            </AppText>
            {section.key === 'done' && done.length > 0 ? (
              <Pressable accessibilityRole="button" onPress={clearHistory} style={styles.clearButton}>
                <AppText variant="caption" tone="secondary">
                  履歴を消去
                </AppText>
              </Pressable>
            ) : null}
          </View>
        )}
        renderItem={({ item, section }) =>
          section.key === 'active' ? (
            <ActiveRow
              job={item}
              fraction={live[item.id]?.fraction ?? item.progress}
              detail={live[item.id]?.detail}
              onPause={() => pauseJob(db, item.id)}
              onResume={() => resumeJob(db, item.id)}
              onCancel={() => cancelJob(db, item.id)}
            />
          ) : (
            <DoneRow job={item} />
          )
        }
        ListFooterComponent={
          <View style={styles.notice}>
            <AppText variant="small" style={styles.noticeText}>
              保護（DRM・暗号化）された動画は保存できません。権利者の許諾があるコンテンツのみ保存してください。
            </AppText>
          </View>
        }
      />
    </View>
  );
}

function statusText(job: Job, detail?: string): { text: string; color: string } {
  switch (job.status) {
    case 'queued':
      return { text: '待機中', color: colors.textSecondary };
    case 'downloading':
      return { text: `ダウンロード中${detail ? `・${detail}` : ''}`, color: colors.textSecondary };
    case 'paused':
      return { text: '一時停止中', color: colors.textSecondary };
    case 'converting':
      return { text: '変換中', color: colors.info };
    case 'blocked':
      return { text: job.error ?? '保存できません', color: colors.dangerText };
    case 'error':
      return { text: `失敗：${job.error ?? '不明なエラー'}`, color: colors.dangerText };
    default:
      return { text: '', color: colors.textSecondary };
  }
}

function ActiveRow({
  job,
  fraction,
  detail,
  onPause,
  onResume,
  onCancel,
}: {
  job: Job;
  fraction: number;
  detail?: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const status = statusText(job, detail);
  const canPause = job.status === 'downloading' || job.status === 'queued';
  const canResume = job.status === 'paused' || job.status === 'error';
  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={[styles.thumb, { backgroundColor: placeholderTint(job.id) }]} />
        <View style={styles.cardText}>
          <AppText variant="bodyBold" numberOfLines={1}>
            {job.title ?? '無題'}
          </AppText>
          <AppText variant="small" numberOfLines={2} style={{ color: status.color }}>
            {status.text}
          </AppText>
        </View>
        {canPause ? <RoundButton icon="pause.fill" label="一時停止" onPress={onPause} /> : null}
        {canResume ? <RoundButton icon="arrow.clockwise" label="再開" onPress={onResume} /> : null}
        <RoundButton icon="xmark" label={job.status === 'blocked' ? '削除' : 'キャンセル'} onPress={onCancel} />
      </View>
      {job.status !== 'blocked' ? (
        <View style={styles.track}>
          <View style={[styles.bar, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
      ) : null}
    </View>
  );
}

function RoundButton({ icon, label, onPress }: { icon: 'pause.fill' | 'arrow.clockwise' | 'xmark'; label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.roundButton}>
      <SymbolView name={icon} tintColor={colors.text} size={14} weight="bold" />
    </Pressable>
  );
}

function DoneRow({ job }: { job: Job }) {
  return (
    <View style={styles.doneRow}>
      <View style={[styles.thumb, { backgroundColor: placeholderTint(job.id) }]} />
      <View style={styles.cardText}>
        <AppText variant="body" numberOfLines={1}>
          {job.title ?? '無題'}
        </AppText>
        <AppText variant="small" tone="secondary">
          {job.output === 'video' ? '動画' : `音声 ${job.output}`}・未分類
        </AppText>
      </View>
      <SymbolView name="checkmark" tintColor={colors.success} size={18} weight="bold" accessibilityLabel="完了" />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  title: { paddingHorizontal: 20, paddingBottom: 12 },
  list: { paddingHorizontal: 16, paddingBottom: 120, gap: 10 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 12, paddingBottom: 4 },
  sectionTitle: { paddingHorizontal: 4, fontWeight: '700' },
  clearButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 12, gap: 10 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 72, height: 40, borderRadius: 6 },
  cardText: { flex: 1, gap: 2 },
  roundButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#2A2D34',
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: { height: 4, backgroundColor: '#2E3138', borderRadius: 2 },
  bar: { height: 4, backgroundColor: colors.accent, borderRadius: 2 },
  doneRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 4 },
  notice: { marginTop: 24, padding: 12, borderRadius: radius.md, backgroundColor: colors.dangerSurface },
  noticeText: { color: colors.dangerText, lineHeight: 19 },
});

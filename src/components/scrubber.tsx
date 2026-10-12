import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import { AppText } from '@/components/app-text';
import { colors } from '@/theme';
import { formatDuration } from '@/utils/format';

// ドラッグ・タップでシークできる再生バー
export function Scrubber({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);

  const toSeconds = (x: number) => (width <= 0 || duration <= 0 ? 0 : Math.min(duration, Math.max(0, (x / width) * duration)));

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => setDragging(toSeconds(e.x)))
    .onUpdate((e) => setDragging(toSeconds(e.x)))
    .onEnd((e) => onSeek(toSeconds(e.x)))
    .onFinalize(() => setDragging(null));

  const shown = dragging ?? position;
  const fraction = duration > 0 ? Math.min(1, shown / duration) : 0;

  return (
    <View>
      <GestureDetector gesture={pan}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="再生位置"
          accessibilityValue={{ text: `${formatDuration(shown)} / ${formatDuration(duration)}` }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) =>
            onSeek(Math.min(duration, Math.max(0, position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))))
          }
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          style={styles.hitArea}>
          <View pointerEvents="none" style={[styles.track, dragging != null && styles.trackActive]}>
            <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
          </View>
          <View
            pointerEvents="none"
            style={[styles.knob, dragging != null && styles.knobActive, { left: fraction * width - (dragging != null ? 9 : 6) }]}
          />
        </View>
      </GestureDetector>
      <View style={styles.times}>
        <AppText variant="small" tone="secondary">
          {formatDuration(shown)}
        </AppText>
        <AppText variant="small" tone="secondary">
          -{formatDuration(Math.max(0, duration - shown))}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hitArea: { height: 32, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: '#33363D', overflow: 'hidden' },
  trackActive: { height: 8, borderRadius: 4 },
  fill: { height: '100%', backgroundColor: colors.accent },
  knob: { position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: colors.text },
  knobActive: { width: 18, height: 18, borderRadius: 9 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
});

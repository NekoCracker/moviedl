import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors, radius } from '@/theme';

const HANDLE = 22;
const MIN_LENGTH_SEC = 1;

// トリミング範囲を選ぶ2つのつまみ付きバー。position は現在の再生位置の表示用。
export function RangeSlider({
  duration,
  start,
  end,
  position,
  onChange,
  onScrub,
}: {
  duration: number;
  start: number;
  end: number;
  position: number;
  onChange: (start: number, end: number) => void;
  // つまみを動かしている間、その位置をプレビューする
  onScrub: (seconds: number) => void;
}) {
  const [width, setWidth] = useState(0);
  // ドラッグを始めたときのつまみの位置
  const origin = useSharedValue(0);

  const move = (which: 'start' | 'end', from: number, dx: number) => {
    if (width <= 0 || duration <= 0) return;
    const value = from + (dx / width) * duration;
    if (which === 'start') {
      const next = Math.min(Math.max(0, value), end - MIN_LENGTH_SEC);
      onChange(next, end);
      onScrub(next);
    } else {
      const next = Math.max(Math.min(duration, value), start + MIN_LENGTH_SEC);
      onChange(start, next);
      onScrub(next);
    }
  };

  const startPan = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      origin.set(start);
    })
    .onUpdate((e) => {
      scheduleOnRN(move, 'start', origin.get(), e.translationX);
    });
  const endPan = Gesture.Pan()
    .minDistance(0)
    .onBegin(() => {
      origin.set(end);
    })
    .onUpdate((e) => {
      scheduleOnRN(move, 'end', origin.get(), e.translationX);
    });

  const x = (sec: number) => (duration > 0 ? (sec / duration) * width : 0);
  const step = Math.max(0.5, duration / 100);

  return (
    <View
      style={styles.wrap}
      onLayout={(e: LayoutChangeEvent) =>
        setWidth(e.nativeEvent.layout.width - HANDLE)
      }
    >
      <View style={[styles.track, { left: HANDLE / 2, right: HANDLE / 2 }]} />
      <View
        style={[
          styles.selected,
          {
            left: HANDLE / 2 + x(start),
            width: Math.max(0, x(end) - x(start)),
          },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.playhead,
          {
            left: HANDLE / 2 + x(Math.min(Math.max(position, start), end)) - 1,
          },
        ]}
      />
      <GestureDetector gesture={startPan}>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="開始位置"
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const next =
              start + (e.nativeEvent.actionName === 'increment' ? step : -step);
            onChange(Math.min(Math.max(0, next), end - MIN_LENGTH_SEC), end);
          }}
          style={[styles.handle, { left: x(start) }]}
        >
          <View style={styles.grip} />
        </View>
      </GestureDetector>
      <GestureDetector gesture={endPan}>
        <View
          accessibilityRole="adjustable"
          accessibilityLabel="終了位置"
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(e) => {
            const next =
              end + (e.nativeEvent.actionName === 'increment' ? step : -step);
            onChange(
              start,
              Math.max(Math.min(duration, next), start + MIN_LENGTH_SEC),
            );
          }}
          style={[styles.handle, { left: x(end) }]}
        >
          <View style={styles.grip} />
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: 56, justifyContent: 'center' },
  track: {
    position: 'absolute',
    height: 40,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  selected: {
    position: 'absolute',
    height: 40,
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: colors.accent,
    backgroundColor: 'rgba(255,138,61,0.15)',
  },
  playhead: {
    position: 'absolute',
    width: 2,
    height: 48,
    backgroundColor: colors.text,
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: 52,
    borderRadius: 6,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grip: {
    width: 3,
    height: 18,
    borderRadius: 2,
    backgroundColor: colors.onAccent,
  },
});

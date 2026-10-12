import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { PasscodePad } from '@/components/passcode-pad';
import { authenticateWithBiometrics, folderPasscode } from '@/security/passcode';
import { colors } from '@/theme';

export type FolderPasscodeMode = 'unlock' | 'set' | 'remove';

type Step = { kind: 'verify' } | { kind: 'enter' } | { kind: 'confirm'; first: string };

// フォルダのパスコード入力（解除・設定・削除）。成功したら onDone を呼ぶ。
export function FolderPasscodeModal({
  folder,
  mode,
  onCancel,
  onDone,
}: {
  folder: { id: number; name: string } | null;
  mode: FolderPasscodeMode;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <Modal visible={folder != null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      {folder ? <Body key={`${folder.id}-${mode}`} folder={folder} mode={mode} onCancel={onCancel} onDone={onDone} /> : null}
    </Modal>
  );
}

function Body({
  folder,
  mode,
  onCancel,
  onDone,
}: {
  folder: { id: number; name: string };
  mode: FolderPasscodeMode;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>(mode === 'set' ? { kind: 'enter' } : { kind: 'verify' });
  const [error, setError] = useState<string | null>(null);

  const finishVerified = async () => {
    if (mode === 'remove') await folderPasscode.clear(folder.id);
    onDone();
  };

  const onComplete = async (code: string) => {
    if (step.kind === 'verify') {
      const result = await folderPasscode.verify(folder.id, code);
      if (result.ok) {
        setError(null);
        await finishVerified();
      } else if (result.lockedForMs > 0) {
        setError(`${Math.ceil(result.lockedForMs / 1000)}秒後にもう一度お試しください`);
      } else {
        setError(`パスコードが違います（あと${result.remaining}回）`);
      }
      return;
    }
    if (step.kind === 'enter') {
      setError(null);
      setStep({ kind: 'confirm', first: code });
      return;
    }
    if (code !== step.first) {
      setStep({ kind: 'enter' });
      setError('一致しませんでした。もう一度入力してください');
      return;
    }
    await folderPasscode.set(folder.id, code);
    onDone();
  };

  const onBiometrics = async () => {
    if (await authenticateWithBiometrics(`「${folder.name}」のロックを解除`)) {
      await finishVerified();
    }
  };

  const title =
    step.kind === 'verify'
      ? `「${folder.name}」のパスコード`
      : step.kind === 'enter'
        ? '新しいパスコード'
        : 'もう一度入力';
  const message =
    step.kind === 'verify'
      ? mode === 'remove'
        ? 'ロックを外すには、今のパスコードを入力してください。'
        : undefined
      : 'このフォルダを開くときに使う4桁の数字です。忘れると中の動画を見られなくなります。';

  return (
    <View style={styles.screen}>
      <Pressable accessibilityRole="button" onPress={onCancel} style={styles.cancel}>
        <AppText variant="body" tone="accent">
          キャンセル
        </AppText>
      </Pressable>
      <PasscodePad
        title={title}
        message={message}
        onComplete={onComplete}
        onBiometrics={step.kind === 'verify' ? onBiometrics : undefined}
        error={error}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, paddingTop: 16 },
  cancel: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, marginBottom: 32 },
});

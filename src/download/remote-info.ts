// 検出リストに出す長さとサイズ（feature-spec.md §2-8）。
// ファイルはサーバーが返すサイズ、HLS はプレイリストの長さとビットレートからの見積もり
import type { DetectedMedia } from '@/browser/detector';
import { parsePlaylist, pickVariant } from '@/download/hls';

export type RemoteInfo = {
  durationSec: number | null;
  sizeBytes: number | null;
  // HLS のサイズは見積もり
  estimated: boolean;
};

const cache = new Map<string, Promise<RemoteInfo>>();

export function remoteInfo(media: DetectedMedia): Promise<RemoteInfo> {
  let found = cache.get(media.url);
  if (!found) {
    found = (media.kind === 'hls' ? hlsInfo(media) : fileInfo(media)).catch(() => ({ durationSec: null, sizeBytes: null, estimated: false }));
    cache.set(media.url, found);
  }
  return found;
}

function headers(media: DetectedMedia): Record<string, string> {
  return { Referer: media.pageUrl };
}

async function contentLength(url: string, extra: Record<string, string>): Promise<number | null> {
  try {
    const head = await fetch(url, { method: 'HEAD', headers: extra });
    const length = Number(head.headers.get('content-length'));
    if (head.ok && length > 0) return length;
  } catch {
    // HEAD を受け付けないサーバーがあるので、1バイトだけ取得して全体のサイズを見る
  }
  const res = await fetch(url, { headers: { ...extra, Range: 'bytes=0-0' } });
  const range = res.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : NaN;
  if (total > 0) return total;
  const length = Number(res.headers.get('content-length'));
  return res.status === 200 && length > 1 ? length : null;
}

async function fileInfo(media: DetectedMedia): Promise<RemoteInfo> {
  return { durationSec: media.durationSec ?? null, sizeBytes: await contentLength(media.url, headers(media)), estimated: false };
}

async function fetchText(url: string, media: DetectedMedia) {
  const res = await fetch(url, { headers: headers(media) });
  if (!res.ok) throw new Error(String(res.status));
  return res.text();
}

async function hlsInfo(media: DetectedMedia): Promise<RemoteInfo> {
  const first = parsePlaylist(await fetchText(media.url, media), media.url);
  let bandwidth = 0;
  let playlist;
  if (first.type === 'master') {
    // ダウンロード時と同じ（一番高い）画質で見積もる
    const variant = pickVariant(first.variants, null);
    if (!variant) return { durationSec: null, sizeBytes: null, estimated: false };
    bandwidth = variant.bandwidth;
    const second = parsePlaylist(await fetchText(variant.url, media), variant.url);
    if (second.type !== 'media') return { durationSec: null, sizeBytes: null, estimated: false };
    playlist = second.playlist;
  } else {
    playlist = first.playlist;
  }
  const durationSec = playlist.live ? null : playlist.totalDurationSec;
  if (!durationSec) return { durationSec: null, sizeBytes: null, estimated: false };
  if (bandwidth > 0) return { durationSec, sizeBytes: Math.round((bandwidth / 8) * durationSec), estimated: true };
  // 画質の一覧が無いときは、最初の区間の大きさ × 区間数で見積もる
  const firstSegment = playlist.segments[0];
  const segmentBytes = firstSegment ? await contentLength(firstSegment.url, headers(media)).catch(() => null) : null;
  return {
    durationSec,
    sizeBytes: segmentBytes && firstSegment ? Math.round((segmentBytes / Math.max(1, firstSegment.durationSec)) * durationSec) : null,
    estimated: true,
  };
}

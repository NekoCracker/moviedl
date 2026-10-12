// HLS（m3u8）プレイリストの解析。ネットワークやファイル操作を含まない純粋な関数だけを置く。

export type HlsVariant = {
  url: string;
  bandwidth: number;
  width: number | null;
  height: number | null;
  label: string;
};

export type HlsSegment = {
  url: string;
  durationSec: number;
};

export type HlsMediaPlaylist = {
  segments: HlsSegment[];
  // fMP4 のときの初期化セグメント（#EXT-X-MAP）。MPEG-TS なら null
  initUrl: string | null;
  totalDurationSec: number;
  // AES-128 / SAMPLE-AES / FairPlay などで保護されている
  encrypted: boolean;
  // #EXT-X-ENDLIST が無い（ライブ配信）
  live: boolean;
};

export type ParsedPlaylist =
  | { type: 'master'; variants: HlsVariant[] }
  | { type: 'media'; playlist: HlsMediaPlaylist };

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return attrs;
}

export function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') {
    throw new Error('HLSプレイリストではありません');
  }

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const attrs = parseAttributes(lines[i].slice('#EXT-X-STREAM-INF:'.length));
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) continue;
      const [w, h] = (attrs.RESOLUTION ?? '').split('x').map(Number);
      const height = Number.isFinite(h) && h > 0 ? h : null;
      const bandwidth = Number(attrs.BANDWIDTH ?? 0);
      variants.push({
        url: resolve(uri, baseUrl),
        bandwidth,
        width: Number.isFinite(w) && w > 0 ? w : null,
        height,
        label: height ? `${height}p` : `${Math.round(bandwidth / 1000)}kbps`,
      });
    }
    variants.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
    return { type: 'master', variants };
  }

  const segments: HlsSegment[] = [];
  let initUrl: string | null = null;
  let encrypted = false;
  let pendingDuration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      const method = parseAttributes(line.slice(line.indexOf(':') + 1)).METHOD ?? '';
      if (method && method !== 'NONE') {
        encrypted = true;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const uri = parseAttributes(line.slice('#EXT-X-MAP:'.length)).URI;
      if (uri) initUrl = resolve(uri, baseUrl);
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolve(line, baseUrl), durationSec: pendingDuration });
      pendingDuration = 0;
    }
  }

  return {
    type: 'media',
    playlist: {
      segments,
      initUrl,
      totalDurationSec: segments.reduce((sum, s) => sum + s.durationSec, 0),
      encrypted,
      live: !lines.includes('#EXT-X-ENDLIST'),
    },
  };
}

// 希望の高さ以下で一番高い画質を選ぶ。無ければ一番低い画質。
export function pickVariant(variants: HlsVariant[], maxHeight: number | null): HlsVariant | null {
  if (variants.length === 0) return null;
  if (maxHeight == null) return variants[0];
  return variants.find((v) => (v.height ?? 0) <= maxHeight) ?? variants[variants.length - 1];
}

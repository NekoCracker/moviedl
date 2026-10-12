// ブックマークやタブのサムネイル代わりに使う、ホスト名と頭文字
export function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match ? match[1].replace(/^www\./, '') : url;
}

export function initialOf(title: string | null, url: string): string {
  const source = (title?.trim() || hostOf(url)).trim();
  return source ? Array.from(source)[0].toUpperCase() : '?';
}

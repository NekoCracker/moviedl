// WebView に注入する動画検出スクリプト。
// ページ上で素直に見える動画URL（<video>/<source> の src、通信で読み込まれる mp4・m3u8 等）だけを拾う。
// サイト固有の難読化の解読や、DRM・暗号化の回避は行わない（feature-spec.md §0）。

export type DetectedKind = 'hls' | 'file';

export type DetectedMedia = {
  url: string;
  kind: DetectedKind;
  container: string | null;
  pageUrl: string;
  pageTitle: string;
  poster: string | null;
  // ページの <video> から分かったときだけ入る
  durationSec?: number | null;
};

export type DetectorMessage =
  | { type: 'media-found'; media: DetectedMedia }
  | { type: 'drm-detected'; pageUrl: string }
  | { type: 'link-menu'; url: string };

export const detectorScript = `
(function () {
  if (window.__vsDetector) { return; }
  window.__vsDetector = true;
  // Cloudflare の確認（Turnstile）の枠の中では何もしない。fetch などを書き換えていると確認が通らない
  if (location.hostname === 'challenges.cloudflare.com' || (window.top !== window && !location.hostname)) { return; }

  var seen = {};
  var FILE_EXT = /\\.(mp4|m4v|mov|webm|mkv|flv|avi|ts|m4a|mp3)(\\?|#|$)/i;
  var HLS_EXT = /\\.m3u8(\\?|#|$)/i;
  var SKIP = /\\.(m4s)(\\?|#|$)|\\/seg(ment)?[-_]?\\d+|\\.ts\\?.*(seg|chunk)/i;

  function post(msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  }

  function absolute(url) {
    try { return new URL(url, document.baseURI).href; } catch (e) { return null; }
  }

  function containerOf(url) {
    var m = url.match(/\\.([a-z0-9]{2,4})(\\?|#|$)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // ポスター画像が無いときの代わり: ページ内の <video poster>、無ければ og:image / twitter:image
  function pagePoster() {
    try {
      var v = document.querySelector('video[poster]');
      if (v && v.getAttribute('poster')) { return v.getAttribute('poster'); }
      var m = document.querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]');
      return m && m.getAttribute('content');
    } catch (e) { return null; }
  }

  var reported = {};

  function send(media) {
    post({ type: 'media-found', media: media });
  }

  // fetch/XHR で見つけた時点ではまだ DOM が無いことがあるので、あとでポスターを補う
  function fillPosters() {
    var p = pagePoster();
    if (!p) { return; }
    var abs = absolute(p);
    for (var key in reported) {
      var m = reported[key];
      if (!m.poster && abs) {
        m.poster = abs;
        send(m);
      }
    }
  }
  document.addEventListener('DOMContentLoaded', fillPosters);
  window.addEventListener('load', fillPosters);

  function report(rawUrl, contentType, poster, duration) {
    if (!rawUrl || typeof rawUrl !== 'string') { return; }
    if (rawUrl.indexOf('blob:') === 0 || rawUrl.indexOf('data:') === 0) { return; }
    var url = absolute(rawUrl);
    if (!url) { return; }
    if (seen[url]) {
      // あとから長さが分かったら知らせる
      var known = reported[url];
      if (known && !known.durationSec && duration > 0 && isFinite(duration)) {
        known.durationSec = duration;
        send(known);
      }
      return;
    }
    var type = (contentType || '').toLowerCase();
    var kind = null;
    if (HLS_EXT.test(url) || type.indexOf('mpegurl') !== -1) {
      kind = 'hls';
    } else if (!SKIP.test(url) && (FILE_EXT.test(url) || type.indexOf('video/') === 0 || type.indexOf('audio/') === 0)) {
      kind = 'file';
    }
    if (!kind) { return; }
    seen[url] = true;
    var p = poster || pagePoster();
    var media = {
      url: url,
      kind: kind,
      container: kind === 'hls' ? 'm3u8' : containerOf(url),
      pageUrl: location.href,
      pageTitle: document.title || location.hostname,
      poster: p ? absolute(p) : null,
      durationSec: duration > 0 && isFinite(duration) ? duration : null
    };
    reported[url] = media;
    send(media);
  }

  function scanMediaElement(el) {
    var poster = el.getAttribute && el.getAttribute('poster');
    if (poster) { fillPosters(); }
    var duration = el.duration;
    report(el.currentSrc || el.src, el.getAttribute && el.getAttribute('type'), poster, duration);
    var sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
    for (var i = 0; i < sources.length; i++) {
      report(sources[i].src, sources[i].getAttribute('type'), poster, duration);
    }
  }

  function scanDocument() {
    var media = document.querySelectorAll('video, audio');
    for (var i = 0; i < media.length; i++) { scanMediaElement(media[i]); }
  }

  ['loadedmetadata', 'durationchange', 'play', 'loadstart'].forEach(function (name) {
    document.addEventListener(name, function (e) {
      var t = e.target;
      if (t && (t.tagName === 'VIDEO' || t.tagName === 'AUDIO')) { scanMediaElement(t); }
    }, true);
  });

  // 読み込まれた通信のURLは、ページの関数を書き換えずに Resource Timing から拾う（読み込み前の分もまとめて届く）
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) { report(entry.name, null, null); });
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}

  // Cloudflare の確認（Turnstile を含む）があるページでは、fetch などを書き換えると確認が通らないことがある。
  // そのため書き換えはページの読み込みが終わってから、確認の気配が無いときだけ行う
  function hasChallenge() {
    if (window._cf_chl_opt || window.turnstile) { return true; }
    var scripts = document.scripts;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (src.indexOf('/cdn-cgi/challenge-platform/') !== -1 || src.indexOf('challenges.cloudflare.com') !== -1) { return true; }
    }
    return !!document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #challenge-form');
  }

  // URLに拡張子が無い動画は、応答の Content-Type を見ないと分からないので、fetch/XHR の結果を見る
  function hookNetwork() {
    if (hasChallenge()) { return; }
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        return origFetch.apply(this, arguments).then(function (res) {
          try { report(res.url, res.headers.get('content-type'), null); } catch (e) {}
          return res;
        });
      };
    }
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vsUrl = url;
      this.addEventListener('load', function () {
        try { report(this.responseURL || this.__vsUrl, this.getResponseHeader('content-type'), null); } catch (e) {}
      });
      return origOpen.apply(this, arguments);
    };
    // DRM（EME）を使うページは保存対象外として通知する
    if (navigator.requestMediaKeySystemAccess) {
      var origEme = navigator.requestMediaKeySystemAccess.bind(navigator);
      navigator.requestMediaKeySystemAccess = function () {
        post({ type: 'drm-detected', pageUrl: location.href });
        return origEme.apply(null, arguments);
      };
    }
  }
  if (document.readyState === 'complete') {
    hookNetwork();
  } else {
    window.addEventListener('load', hookNetwork);
  }

  function start() {
    scanDocument();
    new MutationObserver(scanDocument).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
true;
`;

// リンクの長押しで「新しいタブで開く」などのメニューを出すためのスクリプト。
// iOS 標準のリンクプレビューは使わず（allowsLinkPreview=false）、長押しされたリンクのURLだけをアプリに送る。
export const linkMenuScript = `
(function () {
  if (window.top !== window || window.__vsLinkMenu) { return; }
  window.__vsLinkMenu = true;
  var timer = null, startX = 0, startY = 0, suppressClick = false;
  try {
    var style = document.createElement('style');
    style.textContent = 'a[href]{-webkit-touch-callout:none}';
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
  function cancel() { if (timer) { clearTimeout(timer); timer = null; } }
  document.addEventListener('touchstart', function (e) {
    cancel();
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !/^https?:/i.test(a.href)) { return; }
    var t = e.touches[0]; startX = t.clientX; startY = t.clientY;
    timer = setTimeout(function () {
      timer = null;
      suppressClick = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'link-menu', url: a.href }));
    }, 550);
  }, { passive: true, capture: true });
  document.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) { cancel(); }
  }, { passive: true, capture: true });
  document.addEventListener('touchend', cancel, { capture: true });
  document.addEventListener('touchcancel', cancel, { capture: true });
  // 長押しのあとに指を離したときのクリックでページ移動しないようにする
  document.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });
  document.addEventListener('touchstart', function () { suppressClick = false; }, { passive: true });
})();
true;
`;

export function parseDetectorMessage(data: string): DetectorMessage | null {
  try {
    const msg = JSON.parse(data) as { type?: string };
    if (msg.type === 'media-found' || msg.type === 'drm-detected' || msg.type === 'link-menu') {
      return msg as DetectorMessage;
    }
  } catch {
    // ページ側のスクリプトが送ってきた無関係なメッセージは無視する
  }
  return null;
}

export function toNavigableUrl(input: string): string {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  if (!/\s/.test(text) && /^[^\s/]+\.[^\s/]{2,}(\/.*)?$/.test(text)) {
    return `https://${text}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

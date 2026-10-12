#!/usr/bin/env bash
# MediaToolsCore.xcframework を作る（macOS + Xcode が必要。GitHub Actions の macOS ランナーで実行する）
#
# 中身: mt_core.c + FFmpeg（LGPL 構成）+ dav1d（BSD）+ LAME（LGPL）を1つの動的フレームワークにまとめ、
# mt_probe / mt_convert / mt_concat だけを公開する。FFmpeg のシンボルは外に出さないので、
# VLCKit が内蔵している FFmpeg と衝突しない。LGPL の再リンク要件は「動的フレームワークとして差し替え可能」で満たす。
set -euo pipefail

FFMPEG_VERSION=7.1.1
DAV1D_VERSION=1.5.1
LAME_VERSION=3.100
MIN_IOS=15.1

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-$HERE/.build}"
OUT="${OUT:-$HERE/dist}"
JOBS="$(sysctl -n hw.ncpu)"
mkdir -p "$WORK/src" "$OUT"

fetch() {
  local url="$1" dest="$2"
  if [ ! -d "$dest" ]; then
    curl -fsSL --retry 5 "$url" -o "$dest.tar"
    mkdir -p "$dest"
    tar -xf "$dest.tar" -C "$dest" --strip-components=1
  fi
}

fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$WORK/src/ffmpeg"
fetch "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.gz" "$WORK/src/dav1d"
fetch "https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz" "$WORK/src/lame"

build_slice() {
  local name="$1" sdk="$2" target="$3"
  local prefix="$WORK/$name"
  local sysroot
  sysroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  local cc
  cc="$(xcrun --sdk "$sdk" --find clang)"
  local cflags="-target $target -isysroot $sysroot -O2 -fPIC"
  mkdir -p "$prefix"

  # ---- dav1d（AV1 デコーダ）
  if [ ! -f "$prefix/lib/libdav1d.a" ]; then
    cat > "$WORK/$name.meson" <<EOF
[binaries]
c = '$cc'
ar = '$(xcrun --sdk "$sdk" --find ar)'
strip = '$(xcrun --sdk "$sdk" --find strip)'
[built-in options]
c_args = ['-target', '$target', '-isysroot', '$sysroot']
c_link_args = ['-target', '$target', '-isysroot', '$sysroot']
[host_machine]
system = 'darwin'
subsystem = 'ios'
cpu_family = 'aarch64'
cpu = 'arm64'
endian = 'little'
EOF
    rm -rf "$WORK/dav1d-$name"
    meson setup "$WORK/dav1d-$name" "$WORK/src/dav1d" --cross-file "$WORK/$name.meson" --prefix "$prefix" \
      --libdir lib --default-library static --buildtype release \
      -Denable_tools=false -Denable_tests=false -Denable_examples=false -Dbitdepths=8,16
    ninja -C "$WORK/dav1d-$name" install
  fi

  # ---- LAME（MP3 エンコーダ）
  if [ ! -f "$prefix/lib/libmp3lame.a" ]; then
    rm -rf "$WORK/lame-$name" && cp -R "$WORK/src/lame" "$WORK/lame-$name"
    # 3.100 の既知の問題: 存在しない関数がシンボル一覧に入っている
    sed -i '' '/lame_init_old/d' "$WORK/lame-$name/include/libmp3lame.sym" || true
    (
      cd "$WORK/lame-$name"
      # CPP にも sysroot を渡さないと、標準ヘッダが「無い」と判定されて壊れたコードになる
      CC="$cc" CPP="$cc -E" CPPFLAGS="-target $target -isysroot $sysroot" CFLAGS="$cflags" \
        LDFLAGS="-target $target -isysroot $sysroot" \
        ./configure --host=aarch64-apple-darwin --prefix="$prefix" --disable-shared --enable-static \
        --disable-frontend --disable-decoder --disable-gtktest
      make -j"$JOBS" && make install
    )
  fi

  # ---- FFmpeg（必要な形式だけ有効にした LGPL 構成）
  if [ ! -f "$prefix/lib/libavformat.a" ]; then
    rm -rf "$WORK/ffmpeg-$name" && mkdir -p "$WORK/ffmpeg-$name"
    (
      cd "$WORK/ffmpeg-$name"
      PKG_CONFIG_PATH="$prefix/lib/pkgconfig" PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" \
      "$WORK/src/ffmpeg/configure" \
        --prefix="$prefix" \
        --enable-cross-compile --target-os=darwin --arch=aarch64 \
        --cc="$cc" --sysroot="$sysroot" \
        --extra-cflags="$cflags -I$prefix/include -Wno-unused-command-line-argument" \
        --extra-ldflags="-target $target -isysroot $sysroot -L$prefix/lib" \
        --pkg-config=pkg-config --pkg-config-flags=--static \
        --disable-programs --disable-doc --disable-debug --disable-shared --enable-static --enable-pic \
        --disable-autodetect --disable-everything --disable-network --disable-avdevice --disable-avfilter \
        --enable-zlib --enable-videotoolbox --enable-libdav1d --enable-libmp3lame \
        --enable-protocol=file \
        --enable-demuxer=mov,matroska,flv,avi,mpegts,mpegps,mp3,aac,ogg,wav,flac,asf,concat,h264,hevc,m4v \
        --enable-muxer=mp4,ipod,mov,mp3 \
        --enable-decoder=h264,hevc,vp8,vp9,libdav1d,mpeg4,mpeg1video,mpeg2video,msmpeg4v3,wmv2,wmv3,vc1,flv,theora,h263 \
        --enable-decoder=aac,aac_latm,mp3,mp3float,mp2,opus,vorbis,flac,ac3,eac3,alac,wmav2,pcm_s16le,pcm_s24le,pcm_f32le,pcm_u8,pcm_s16be \
        --enable-encoder=h264_videotoolbox,aac,libmp3lame \
        --enable-parser=h264,hevc,vp8,vp9,av1,aac,aac_latm,mpegaudio,opus,vorbis,flac,ac3,mpeg4video,mpegvideo,vc1,h263 \
        --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb,vp9_superframe_split,extract_extradata
      make -j"$JOBS" && make install
    )
  fi

  # ---- mt_core を足して1つの動的ライブラリにする
  local fw="$WORK/fw-$name/MediaToolsCore.framework"
  rm -rf "$WORK/fw-$name" && mkdir -p "$fw/Headers" "$fw/Modules"
  "$cc" $cflags -I"$prefix/include" -fvisibility=hidden -c "$HERE/mt_core.c" -o "$WORK/mt_core-$name.o"
  printf '_mt_probe\n_mt_convert\n_mt_concat\n' > "$WORK/exports.txt"
  "$cc" -target "$target" -isysroot "$sysroot" -dynamiclib \
    -install_name @rpath/MediaToolsCore.framework/MediaToolsCore \
    -Wl,-exported_symbols_list,"$WORK/exports.txt" -Wl,-dead_strip \
    "$WORK/mt_core-$name.o" -L"$prefix/lib" \
    -lavformat -lavcodec -lswscale -lswresample -lavutil -ldav1d -lmp3lame -lz \
    -framework VideoToolbox -framework CoreMedia -framework CoreVideo -framework CoreFoundation -framework CoreServices \
    -o "$fw/MediaToolsCore"
  cp "$HERE/mt_core.h" "$fw/Headers/"
  cat > "$fw/Modules/module.modulemap" <<'EOF'
framework module MediaToolsCore {
  umbrella header "mt_core.h"
  export *
}
EOF
  local platform="iPhoneOS"
  [ "$sdk" = "iphonesimulator" ] && platform="iPhoneSimulator"
  cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>MediaToolsCore</string>
  <key>CFBundleIdentifier</key><string>com.nekocracker.moviedl.MediaToolsCore</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>MediaToolsCore</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$(cat "$HERE/VERSION")</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
  <key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
EOF
  echo "built $fw"
}

build_slice ios-arm64 iphoneos "arm64-apple-ios$MIN_IOS"
build_slice ios-arm64-simulator iphonesimulator "arm64-apple-ios$MIN_IOS-simulator"

rm -rf "$OUT/MediaToolsCore.xcframework"
xcodebuild -create-xcframework \
  -framework "$WORK/fw-ios-arm64/MediaToolsCore.framework" \
  -framework "$WORK/fw-ios-arm64-simulator/MediaToolsCore.framework" \
  -output "$OUT/MediaToolsCore.xcframework"

# ライセンス表記とソース入手先（LGPL の要件）
mkdir -p "$OUT/licenses"
cp "$WORK/src/ffmpeg/COPYING.LGPLv2.1" "$OUT/licenses/FFmpeg-LGPL-2.1.txt"
cp "$WORK/src/dav1d/COPYING" "$OUT/licenses/dav1d-BSD.txt"
cp "$WORK/src/lame/COPYING" "$OUT/licenses/LAME-LGPL.txt"
cat > "$OUT/licenses/SOURCES.txt" <<EOF
FFmpeg $FFMPEG_VERSION  https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
dav1d $DAV1D_VERSION     https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.gz
LAME $LAME_VERSION       https://downloads.sourceforge.net/project/lame/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz
Build script: modules/media-tools/core/build-ios.sh
EOF

(cd "$OUT" && rm -f MediaToolsCore.xcframework.zip && zip -qry MediaToolsCore.xcframework.zip MediaToolsCore.xcframework licenses)
echo "done: $OUT/MediaToolsCore.xcframework.zip"

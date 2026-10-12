require 'json'
require 'fileutils'

# 変換エンジン（MediaToolsCore.xcframework）は GitHub Actions でビルドして Release に置いている
# （.github/workflows/media-tools-core.yml）。pod install のときに、まだなければダウンロードする。
core_version = File.read(File.join(__dir__, '..', 'core', 'VERSION')).strip
frameworks_dir = File.join(__dir__, 'Frameworks')
xcframework = File.join(frameworks_dir, 'MediaToolsCore.xcframework')
stamp = File.join(frameworks_dir, '.version')
unless File.exist?(xcframework) && File.exist?(stamp) && File.read(stamp).strip == core_version
  url = "https://github.com/NekoCracker/moviedl/releases/download/media-tools-core-v#{core_version}/MediaToolsCore.xcframework.zip"
  FileUtils.rm_rf(frameworks_dir)
  FileUtils.mkdir_p(frameworks_dir)
  zip = File.join(frameworks_dir, 'core.zip')
  system('curl', '-fsSL', '--retry', '5', '-o', zip, url) || raise("MediaToolsCore をダウンロードできません: #{url}")
  system('unzip', '-q', zip, '-d', frameworks_dir) || raise('MediaToolsCore を展開できません')
  FileUtils.rm_f(zip)
  File.write(stamp, core_version)
end

Pod::Spec.new do |s|
  s.name           = 'MediaTools'
  s.version        = core_version
  s.summary        = '動画・音声の変換（FFmpeg）と VLC 再生'
  s.description    = 'MP4/M4A/MP3 への変換、閲覧データの削除、VLCKit による WebM/MKV などの再生'
  s.author         = ''
  s.homepage       = 'https://github.com/NekoCracker/moviedl'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'MobileVLCKit', '~> 3.6.0'

  s.vendored_frameworks = 'Frameworks/MediaToolsCore.xcframework'
  s.frameworks = 'WebKit', 'BackgroundTasks', 'MediaPlayer', 'AVFoundation'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '*.{h,m,swift}'
end

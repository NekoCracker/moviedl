import ExpoModulesCore
import Foundation
import MediaToolsCore
import UIKit
import WebKit

// 変換（MediaToolsCore = FFmpeg + mt_core）、閲覧データの削除、iCloud バックアップからの除外
public final class MediaToolsModule: Module {
  private let queue = DispatchQueue(label: "com.nekocracker.moviedl.media-tools", qos: .userInitiated)
  private var jobs: [String: ConvertJob] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("MediaTools")

    Events("onConvertProgress")

    OnCreate {
      ConvertBackgroundTasks.shared.registerIfNeeded()
    }

    AsyncFunction("probe") { (uri: String, promise: Promise) in
      let path = Self.path(from: uri)
      self.queue.async {
        var result = MTProbeResult()
        var error = [CChar](repeating: 0, count: 512)
        let status = mt_probe(path, &result, &error, Int32(error.count))
        if status != Int32(MT_OK) {
          promise.reject("ERR_PROBE", String(cString: error))
          return
        }
        promise.resolve([
          "durationSec": result.duration_sec,
          "hasVideo": result.has_video != 0,
          "hasAudio": result.has_audio != 0,
          "width": Int(result.width),
          "height": Int(result.height),
          "videoCodec": Self.string(from: &result.video_codec),
          "audioCodec": Self.string(from: &result.audio_codec),
          "container": Self.string(from: &result.container),
        ])
      }
    }

    // 戻り値: "done" | "cancelled"。失敗は reject
    AsyncFunction("convert") { (jobId: String, options: ConvertOptions, promise: Promise) in
      let job = ConvertJob(id: jobId) { [weak self] fraction in
        self?.sendEvent("onConvertProgress", ["jobId": jobId, "fraction": fraction])
        ConvertBackgroundTasks.shared.update(jobId: jobId, fraction: fraction)
      }
      self.store(job)
      ConvertBackgroundTasks.shared.begin(jobId: jobId, title: options.title, onExpire: { job.cancel() })
      self.queue.async {
        let result = job.run(options: options)
        self.remove(jobId)
        ConvertBackgroundTasks.shared.end(jobId: jobId, success: result.status == Int32(MT_OK))
        switch result.status {
        case Int32(MT_OK): promise.resolve("done")
        case Int32(MT_CANCELLED): promise.resolve("cancelled")
        default: promise.reject("ERR_CONVERT", result.error)
        }
      }
    }

    AsyncFunction("concat") { (jobId: String, inputs: [String], output: String, promise: Promise) in
      let job = ConvertJob(id: jobId, onProgress: { _ in })
      self.store(job)
      self.queue.async {
        let result = job.concat(inputs: inputs.map(Self.path(from:)), output: Self.path(from: output))
        self.remove(jobId)
        switch result.status {
        case Int32(MT_OK): promise.resolve("done")
        case Int32(MT_CANCELLED): promise.resolve("cancelled")
        default: promise.reject("ERR_CONCAT", result.error)
        }
      }
    }

    // timeSec 付近の1フレームを JPEG で output に書き出す（サムネイル。WebM・MKV・AV1 も扱える）
    AsyncFunction("thumbnail") { (uri: String, timeSec: Double, maxWidth: Int, output: String, promise: Promise) in
      let path = Self.path(from: uri)
      let outPath = Self.path(from: output)
      self.queue.async {
        var pixels: UnsafeMutablePointer<UInt8>?
        var width: Int32 = 0
        var height: Int32 = 0
        var error = [CChar](repeating: 0, count: 512)
        let status = mt_frame(path, timeSec, Int32(maxWidth), &pixels, &width, &height, &error, Int32(error.count))
        guard status == Int32(MT_OK), let pixels else {
          promise.reject("ERR_THUMBNAIL", String(cString: error))
          return
        }
        defer { mt_free(pixels) }
        let w = Int(width), h = Int(height)
        guard
          let provider = CGDataProvider(data: Data(bytes: pixels, count: w * h * 4) as CFData),
          let image = CGImage(
            width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent),
          let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.75)
        else {
          promise.reject("ERR_THUMBNAIL", "画像を作れませんでした")
          return
        }
        do {
          try jpeg.write(to: URL(fileURLWithPath: outPath), options: .atomic)
          promise.resolve(nil)
        } catch {
          promise.reject("ERR_THUMBNAIL", error.localizedDescription)
        }
      }
    }

    Function("cancel") { (jobId: String) in
      self.lock.lock()
      let job = self.jobs[jobId]
      self.lock.unlock()
      job?.cancel()
    }

    // 変換を始める前に、発熱・電池残量を確かめる（feature-spec.md §2-12）
    Function("deviceCondition") { () -> [String: Any] in
      Thread.isMainThread ? MainActor.assumeIsolated { Self.deviceCondition() } : DispatchQueue.main.sync { MainActor.assumeIsolated { Self.deviceCondition() } }
    }

    // iOS 26 以降で、アプリを閉じても変換を続けられるか
    Function("supportsContinuedProcessing") { () -> Bool in
      ConvertBackgroundTasks.shared.isSupported
    }

    Function("excludeFromBackup") { (uri: String) in
      var url = URL(fileURLWithPath: Self.path(from: uri))
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
    }

    // types: "cache" | "cookies"。sinceMs より後に作られたデータを消す（null ならすべて）
    AsyncFunction("clearWebsiteData") { (types: [String], sinceMs: Double?, promise: Promise) in
      var dataTypes = Set<String>()
      if types.contains("cache") {
        dataTypes.formUnion([WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache])
      }
      if types.contains("cookies") {
        dataTypes.formUnion([
          WKWebsiteDataTypeCookies, WKWebsiteDataTypeLocalStorage, WKWebsiteDataTypeSessionStorage,
          WKWebsiteDataTypeIndexedDBDatabases, WKWebsiteDataTypeWebSQLDatabases,
          WKWebsiteDataTypeServiceWorkerRegistrations,
        ])
      }
      let since = sinceMs.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date.distantPast
      DispatchQueue.main.async {
        if types.contains("cookies") {
          // WebView と共有している URLSession 側の Cookie も消す
          HTTPCookieStorage.shared.removeCookies(since: since)
        }
        WKWebsiteDataStore.default().removeData(ofTypes: dataTypes, modifiedSince: since) {
          promise.resolve(nil)
        }
      }
    }

    // WebView のキャッシュ等が使っている容量（バイト。おおよその値）
    AsyncFunction("websiteDataSize") { () -> Double in
      let fm = FileManager.default
      let library = fm.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      let bundleId = Bundle.main.bundleIdentifier ?? ""
      let dirs = [
        library.appendingPathComponent("WebKit"),
        library.appendingPathComponent("Cookies"),
        caches.appendingPathComponent("WebKit"),
        caches.appendingPathComponent(bundleId).appendingPathComponent("WebKit"),
      ]
      return Double(dirs.reduce(0) { $0 + Self.directorySize($1) })
    }
  }

  private func store(_ job: ConvertJob) {
    lock.lock()
    jobs[job.id] = job
    lock.unlock()
  }

  private func remove(_ id: String) {
    lock.lock()
    jobs[id] = nil
    lock.unlock()
  }

  @MainActor static func deviceCondition() -> [String: Any] {
    let info = ProcessInfo.processInfo
    let thermal: String
    switch info.thermalState {
    case .nominal: thermal = "nominal"
    case .fair: thermal = "fair"
    case .serious: thermal = "serious"
    case .critical: thermal = "critical"
    @unknown default: thermal = "nominal"
    }
    let device = UIDevice.current
    device.isBatteryMonitoringEnabled = true
    return [
      "thermal": thermal,
      // 取得できないときは -1
      "batteryLevel": Double(device.batteryLevel),
      "charging": device.batteryState == .charging || device.batteryState == .full,
      "lowPowerMode": info.isLowPowerModeEnabled,
    ]
  }

  static func path(from uri: String) -> String {
    if uri.hasPrefix("file://"), let url = URL(string: uri) {
      return url.path
    }
    return uri
  }

  static func string<T>(from tuple: inout T) -> String {
    withUnsafePointer(to: &tuple) {
      $0.withMemoryRebound(to: CChar.self, capacity: MemoryLayout<T>.size) { String(cString: $0) }
    }
  }

  static func directorySize(_ url: URL) -> Int {
    guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.totalFileAllocatedSizeKey])
    else { return 0 }
    var total = 0
    for case let file as URL in enumerator {
      total += (try? file.resourceValues(forKeys: [.totalFileAllocatedSizeKey]).totalFileAllocatedSize) ?? 0
    }
    return total
  }
}

struct ConvertOptions: Record {
  @Field var input: String = ""
  @Field var output: String = ""
  // "mp4" | "m4a" | "mp3"
  @Field var mode: String = "mp4"
  @Field var startSec: Double = -1
  @Field var endSec: Double = -1
  @Field var forceEncode: Bool = false
  @Field var videoBitrate: Int = 0
  @Field var audioBitrate: Int = 0
  @Field var maxHeight: Int = 0
  // バックグラウンド処理の表示に使う
  @Field var title: String = "動画を変換しています"
}

final class ConvertJob {
  let id: String
  private let onProgress: (Double) -> Void
  private let cancelFlag = UnsafeMutablePointer<Int32>.allocate(capacity: 1)
  private var lastSent: (time: TimeInterval, fraction: Double) = (0, -1)

  init(id: String, onProgress: @escaping (Double) -> Void) {
    self.id = id
    self.onProgress = onProgress
    cancelFlag.initialize(to: 0)
  }

  deinit {
    cancelFlag.deallocate()
  }

  func cancel() {
    cancelFlag.pointee = 1
  }

  fileprivate func report(_ fraction: Double) {
    // JS へのイベントは 0.25 秒・1% ごとに間引く
    let now = Date().timeIntervalSince1970
    if fraction < 1, now - lastSent.time < 0.25 || abs(fraction - lastSent.fraction) < 0.01 { return }
    lastSent = (now, fraction)
    onProgress(fraction)
  }

  func run(options: ConvertOptions) -> (status: Int32, error: String) {
    var error = [CChar](repeating: 0, count: 1024)
    let mode: MTMode = options.mode == "mp3" ? MT_MODE_MP3 : options.mode == "m4a" ? MT_MODE_M4A : MT_MODE_MP4
    let input = MediaToolsModule.path(from: options.input)
    let output = MediaToolsModule.path(from: options.output)
    let context = Unmanaged.passUnretained(self).toOpaque()
    let status: Int32 = input.withCString { inputPtr in
      output.withCString { outputPtr in
        "h264_videotoolbox".withCString { encoderPtr in
          var opts = MTConvertOptions(
            input: inputPtr,
            output: outputPtr,
            mode: mode,
            start_sec: options.startSec,
            end_sec: options.endSec,
            force_encode: options.forceEncode ? 1 : 0,
            video_bitrate: Int32(options.videoBitrate),
            audio_bitrate: Int32(options.audioBitrate),
            max_height: Int32(options.maxHeight),
            video_encoder: encoderPtr
          )
          return mt_convert(&opts, { ctx, fraction in
            guard let ctx else { return }
            Unmanaged<ConvertJob>.fromOpaque(ctx).takeUnretainedValue().report(fraction)
          }, context, cancelFlag, &error, Int32(error.count))
        }
      }
    }
    return (status, String(cString: error))
  }

  func concat(inputs: [String], output: String) -> (status: Int32, error: String) {
    var error = [CChar](repeating: 0, count: 1024)
    let cStrings = inputs.map { strdup($0) }
    defer { cStrings.forEach { free($0) } }
    var pointers: [UnsafePointer<CChar>?] = cStrings.map { UnsafePointer($0) }
    let status = pointers.withUnsafeMutableBufferPointer { buffer in
      mt_concat(buffer.baseAddress, Int32(inputs.count), output, cancelFlag, &error, Int32(error.count))
    }
    return (status, String(cString: error))
  }
}

import BackgroundTasks
import Foundation
import UIKit

// 変換中にアプリを閉じたときの扱い（feature-spec.md §2-12）
// - iOS 26 以降: BGContinuedProcessingTask で、進捗をシステムに表示しながら続ける
// - それより前: 少しだけ延長（beginBackgroundTask）し、時間切れになったら中断する。JS 側は次に開いたときに続きから再開する
final class ConvertBackgroundTasks {
  static let shared = ConvertBackgroundTasks()

  private let identifierPrefix = (Bundle.main.bundleIdentifier ?? "com.nekocracker.moviedl") + ".convert"
  private let lock = NSLock()
  private var registered = false
  private var legacyTasks: [String: UIBackgroundTaskIdentifier] = [:]
  private var expireHandlers: [String: () -> Void] = [:]
  // iOS 26 の BGContinuedProcessingTask（型を iOS 26 に依存させないため AnyObject で持つ）
  private var continuedTasks: [String: AnyObject] = [:]
  private var latestFraction: [String: Double] = [:]

  var isSupported: Bool {
    if #available(iOS 26.0, *) { return true }
    return false
  }

  func registerIfNeeded() {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      lock.lock()
      defer { lock.unlock() }
      if registered { return }
      registered = true
      // 末尾が .* の識別子は、続く名前ごとに同じ処理で受け取れる
      _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: "\(identifierPrefix).*", using: nil) { [weak self] task in
        guard let self, let task = task as? BGContinuedProcessingTask else {
          task.setTaskCompleted(success: false)
          return
        }
        self.attach(task)
      }
    }
    #endif
  }

  func begin(jobId: String, title: String, onExpire: @escaping () -> Void) {
    lock.lock()
    expireHandlers[jobId] = onExpire
    lock.unlock()

    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      registerIfNeeded()
      let request = BGContinuedProcessingTaskRequest(
        identifier: "\(identifierPrefix).\(Self.sanitize(jobId))",
        title: title,
        subtitle: "0%"
      )
      request.strategy = .queue
      do {
        try BGTaskScheduler.shared.submit(request)
        return
      } catch {
        // 送れなければ従来の方法にする
      }
    }
    #endif

    DispatchQueue.main.async {
      let id = UIApplication.shared.beginBackgroundTask(withName: "convert-\(jobId)") { [weak self] in
        self?.expire(jobId: jobId)
      }
      self.lock.lock()
      self.legacyTasks[jobId] = id
      self.lock.unlock()
    }
  }

  func update(jobId: String, fraction: Double) {
    lock.lock()
    latestFraction[jobId] = fraction
    let task = continuedTasks[jobId]
    lock.unlock()
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      task.progress.totalUnitCount = 1000
      task.progress.completedUnitCount = Int64(fraction * 1000)
      task.updateTitle(task.title, subtitle: "\(Int(fraction * 100))%")
    }
    #endif
  }

  func end(jobId: String, success: Bool) {
    lock.lock()
    let legacy = legacyTasks.removeValue(forKey: jobId)
    let task = continuedTasks.removeValue(forKey: jobId)
    expireHandlers[jobId] = nil
    latestFraction[jobId] = nil
    lock.unlock()
    if let legacy {
      DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(legacy) }
    }
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      task.setTaskCompleted(success: success)
    }
    #endif
  }

  private func expire(jobId: String) {
    lock.lock()
    let handler = expireHandlers[jobId]
    let legacy = legacyTasks.removeValue(forKey: jobId)
    lock.unlock()
    handler?()
    if let legacy {
      UIApplication.shared.endBackgroundTask(legacy)
    }
  }

  #if compiler(>=6.2)
  @available(iOS 26.0, *)
  private func attach(_ task: BGContinuedProcessingTask) {
    let jobId = String(task.identifier.dropFirst(identifierPrefix.count + 1))
    lock.lock()
    let known = expireHandlers.keys.first { Self.sanitize($0) == jobId }
    if let known { continuedTasks[known] = task }
    let fraction = known.flatMap { latestFraction[$0] } ?? 0
    lock.unlock()
    guard let known else {
      // 変換がもう終わっていた
      task.setTaskCompleted(success: true)
      return
    }
    task.progress.totalUnitCount = 1000
    task.progress.completedUnitCount = Int64(fraction * 1000)
    task.expirationHandler = { [weak self] in
      self?.expire(jobId: known)
    }
  }
  #endif

  private static func sanitize(_ id: String) -> String {
    String(id.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "-" })
  }
}

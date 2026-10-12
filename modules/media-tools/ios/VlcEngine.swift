import AVFoundation
import Foundation
import MediaPlayer
import MobileVLCKit
import UIKit

// iOS 標準プレイヤーで再生できない形式（WebM・MKV・FLV・AVI など）を VLCKit で再生する（feature-spec.md §2-12）
// プレイヤーは1つだけ。映像を出す View は付け外しでき、外していても音声は再生を続ける（ミニプレイヤー・バックグラウンド再生）
final class VlcEngine: NSObject, VLCMediaPlayerDelegate {
  static let shared = VlcEngine()

  // JS へ送るイベント（VlcModule が設定する）
  var onEvent: ((String, [String: Any]) -> Void)?

  private let player = VLCMediaPlayer()
  private weak var drawableView: UIView?
  private var pendingSeekMs: Int32?
  private var title = ""
  private var rate: Float = 1
  private var lastTimeEvent: TimeInterval = 0
  private var remoteCommandsInstalled = false
  private var remoteTargets: [Any] = []
  private var artwork: MPMediaItemArtwork?
  // 電話などで中断される前に再生していたか（終わったら再開する）
  private var wasPlayingBeforeInterruption = false

  override init() {
    super.init()
    player.delegate = self
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(handleInterruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
    center.addObserver(self, selector: #selector(handleRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
  }

  // MARK: - 中断・イヤホン

  @objc private func handleInterruption(_ notification: Notification) {
    guard player.media != nil,
      let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    DispatchQueue.main.async {
      switch type {
      case .began:
        self.wasPlayingBeforeInterruption = self.player.isPlaying
        if self.player.isPlaying { self.pause() }
      case .ended:
        let optionsRaw = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        if self.wasPlayingBeforeInterruption && AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume) {
          self.play()
        }
        self.wasPlayingBeforeInterruption = false
      @unknown default:
        break
      }
    }
  }

  // イヤホンが抜けたら一時停止する（iOS 標準の動き）
  @objc private func handleRouteChange(_ notification: Notification) {
    guard let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
    else { return }
    DispatchQueue.main.async {
      if self.player.isPlaying { self.pause() }
    }
  }

  // MARK: - 操作

  func load(uri: String, title: String, artworkUri: String?, startSec: Double, autoplay: Bool) {
    guard let url = URL(string: uri) else { return }
    self.title = title
    artwork = nil
    if let artworkUri, let artworkURL = URL(string: artworkUri), let image = UIImage(contentsOfFile: artworkURL.path) {
      artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }
    player.stop()
    player.media = VLCMedia(url: url)
    pendingSeekMs = startSec > 0 ? Int32(startSec * 1000) : nil
    activateAudioSession()
    installRemoteCommands()
    if let view = drawableView { player.drawable = view }
    if autoplay { player.play() }
    updateNowPlaying()
  }

  func play() {
    activateAudioSession()
    player.play()
  }

  func pause() {
    player.pause()
  }

  func stop() {
    player.stop()
    player.media = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    uninstallRemoteCommands()
  }

  func seek(to seconds: Double) {
    let ms = Int32(max(0, seconds) * 1000)
    if player.isPlaying || player.state == .paused {
      player.time = VLCTime(int: ms)
    } else {
      pendingSeekMs = ms
    }
    updateNowPlaying()
  }

  func setRate(_ value: Float) {
    rate = value
    player.rate = value
    updateNowPlaying()
  }

  var currentTime: Double { Double(player.time.intValue) / 1000 }
  var duration: Double { Double(player.media?.length.intValue ?? 0) / 1000 }
  var isPlaying: Bool { player.isPlaying }

  // MARK: - 映像の表示先

  func attach(_ view: UIView) {
    drawableView = view
    player.drawable = view
  }

  func detach(_ view: UIView) {
    guard drawableView === view else { return }
    drawableView = nil
    player.drawable = nil
  }

  // MARK: - VLCMediaPlayerDelegate

  func mediaPlayerStateChanged(_ aNotification: Notification) {
    switch player.state {
    case .playing:
      if let ms = pendingSeekMs {
        pendingSeekMs = nil
        player.time = VLCTime(int: ms)
      }
      if player.rate != rate { player.rate = rate }
      onEvent?("onVlcPlayingChange", ["isPlaying": true])
      onEvent?("onVlcLoad", ["duration": duration])
    case .paused, .stopped:
      onEvent?("onVlcPlayingChange", ["isPlaying": false])
    case .ended:
      onEvent?("onVlcPlayingChange", ["isPlaying": false])
      onEvent?("onVlcEnd", [:])
    case .error:
      onEvent?("onVlcPlayingChange", ["isPlaying": false])
      onEvent?("onVlcError", ["message": "再生できませんでした"])
    default:
      break
    }
    updateNowPlaying()
  }

  func mediaPlayerTimeChanged(_ aNotification: Notification) {
    let now = Date().timeIntervalSince1970
    if now - lastTimeEvent < 0.5 { return }
    lastTimeEvent = now
    onEvent?("onVlcTimeUpdate", ["currentTime": currentTime, "duration": duration])
    updateNowPlaying()
  }

  // MARK: - ロック画面・コントロールセンター

  private func activateAudioSession() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .moviePlayback)
    try? session.setActive(true)
  }

  private func updateNowPlaying() {
    guard player.media != nil else { return }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyPlaybackDuration: duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
      MPNowPlayingInfoPropertyPlaybackRate: player.isPlaying ? Double(rate) : 0,
    ]
    if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  private func installRemoteCommands() {
    if remoteCommandsInstalled { return }
    remoteCommandsInstalled = true
    let center = MPRemoteCommandCenter.shared()
    remoteTargets = [
      center.playCommand.addTarget { [weak self] _ in
        self?.play()
        return .success
      },
      center.pauseCommand.addTarget { [weak self] _ in
        self?.pause()
        return .success
      },
      center.togglePlayPauseCommand.addTarget { [weak self] _ in
        guard let self else { return .commandFailed }
        self.player.isPlaying ? self.pause() : self.play()
        return .success
      },
      center.nextTrackCommand.addTarget { [weak self] _ in
        self?.onEvent?("onVlcRemoteCommand", ["command": "next"])
        return .success
      },
      center.previousTrackCommand.addTarget { [weak self] _ in
        self?.onEvent?("onVlcRemoteCommand", ["command": "previous"])
        return .success
      },
      center.changePlaybackPositionCommand.addTarget { [weak self] event in
        guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
        self?.seek(to: event.positionTime)
        return .success
      },
    ]
  }

  private func uninstallRemoteCommands() {
    guard remoteCommandsInstalled else { return }
    let center = MPRemoteCommandCenter.shared()
    let commands: [MPRemoteCommand] = [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
      center.nextTrackCommand, center.previousTrackCommand, center.changePlaybackPositionCommand,
    ]
    for (command, target) in zip(commands, remoteTargets) {
      command.removeTarget(target)
    }
    remoteTargets = []
    remoteCommandsInstalled = false
  }
}

import ExpoModulesCore
import UIKit

// VlcEngine を JS から操作するためのモジュールと、映像を表示する View
// 操作は UIKit（VLC の描画先）に触れるのでメインスレッドで動かす。runOnQueue は AsyncFunction にしか付けられない
public final class VlcModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VlcPlayer")

    Events("onVlcPlayingChange", "onVlcLoad", "onVlcTimeUpdate", "onVlcEnd", "onVlcError", "onVlcRemoteCommand")

    OnStartObserving {
      VlcEngine.shared.onEvent = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnStopObserving {
      VlcEngine.shared.onEvent = nil
    }

    AsyncFunction("load") { (uri: String, title: String, artworkUri: String?, startSec: Double, autoplay: Bool) in
      VlcEngine.shared.load(uri: uri, title: title, artworkUri: artworkUri, startSec: startSec, autoplay: autoplay)
    }.runOnQueue(.main)

    AsyncFunction("play") {
      VlcEngine.shared.play()
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      VlcEngine.shared.pause()
    }.runOnQueue(.main)

    AsyncFunction("stop") {
      VlcEngine.shared.stop()
    }.runOnQueue(.main)

    AsyncFunction("seek") { (seconds: Double) in
      VlcEngine.shared.seek(to: seconds)
    }.runOnQueue(.main)

    AsyncFunction("setRate") { (rate: Double) in
      VlcEngine.shared.setRate(Float(rate))
    }.runOnQueue(.main)

    AsyncFunction("getStatus") { () -> [String: Any] in
      ["currentTime": VlcEngine.shared.currentTime, "duration": VlcEngine.shared.duration, "isPlaying": VlcEngine.shared.isPlaying]
    }.runOnQueue(.main)

    View(VlcVideoView.self) {}
  }
}

// 置いてある間だけ VLC の映像をここに映す
public final class VlcVideoView: ExpoView {
  private let videoView = UIView()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    videoView.backgroundColor = .black
    videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    videoView.frame = bounds
    addSubview(videoView)
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      VlcEngine.shared.attach(videoView)
    } else {
      VlcEngine.shared.detach(videoView)
    }
  }
}

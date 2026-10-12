import Foundation
import UIKit
import Capacitor
import Yodo1MasCore

/// Yodo1 MAS for Soapcube Racing: full-screen (interstitial) ads only. Same calls as the Android side:
///   start({appKey}), isLoaded() -> {loaded}, showInterstitial({placement}) -> {shown},
///   privacyOptions() -> {required}, showPrivacyOptions(); events "interstitialLoaded" / "interstitialFailedToLoad".
/// The MAS calls follow Yodo1's own iOS reference module (Objective-C). Apart from initMas (whose Swift form is in Yodo1's
/// iOS guide), they are made by their Objective-C names, so this file doesn't depend on how a given MAS 4.x version
/// spells them in Swift.
@objc(Yodo1MasPlugin)
public class Yodo1MasPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "Yodo1MasPlugin"
    public let jsName = "Yodo1Mas"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isLoaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showInterstitial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "privacyOptions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPrivacyOptions", returnType: CAPPluginReturnPromise),
    ]

    private var started = false, starting = false, loaded = false
    private var retries = 0
    private var showCall: CAPPluginCall?

    /// an MAS object by its Objective-C class name and class method (e.g. "Yodo1MasInterstitialAd", "sharedInstance")
    private func mas(_ cls: String, _ method: String) -> NSObject? {
        guard let c: AnyClass = NSClassFromString(cls) else { return nil }
        return (c as AnyObject).perform(NSSelectorFromString(method))?.takeUnretainedValue() as? NSObject
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let key = call.getString("appKey"), !key.isEmpty else { call.reject("appKey missing"); return }
        if started { call.resolve(); return }
        if starting { call.reject("already starting"); return }
        starting = true
        DispatchQueue.main.async {
            // MAS's own privacy window: asks the player's age and consent, and sets GDPR, CCPA and COPPA from the answers
            if let config = self.mas("Yodo1MasAdBuildConfig", "instance") {
                config.setValue(true, forKey: "enableUserPrivacyDialog")
                _ = Yodo1Mas.sharedInstance().perform(NSSelectorFromString("setAdBuildConfig:"), with: config)
            }
            // the ad's events come to the @objc methods at the bottom (the same names MAS's delegate uses)
            _ = self.mas("Yodo1MasInterstitialAd", "sharedInstance")?.perform(NSSelectorFromString("setAdDelegate:"), with: self)
            Yodo1Mas.sharedInstance().initMas(withAppKey: key, successful: {
                self.started = true; self.starting = false
                call.resolve()
                self.load()
            }, fail: { error in
                self.starting = false
                call.reject("MAS init failed: \(error)")
            })
        }
    }

    @objc func isLoaded(_ call: CAPPluginCall) {
        call.resolve(["loaded": started && loaded])
    }

    @objc func showInterstitial(_ call: CAPPluginCall) {
        if !started || !loaded || showCall != nil { call.resolve(["shown": false]); return }
        showCall = call
        loaded = false
        let placement = call.getString("placement") ?? ""
        DispatchQueue.main.async {
            guard let ad = self.mas("Yodo1MasInterstitialAd", "sharedInstance") else { self.finishShow(false); return }
            if placement.isEmpty { _ = ad.perform(NSSelectorFromString("showAd")) }
            else { _ = ad.perform(NSSelectorFromString("showAdWithPlacement:"), with: placement) }
        }
    }

    // "Ad privacy choices" (EU/UK): Google's consent form, which MAS uses. Called through the Objective-C runtime so it works
    // with whichever version of Google's UMP library MAS brings along.
    @objc func privacyOptions(_ call: CAPPluginCall) {
        var required = false
        if let info = mas("UMPConsentInformation", "sharedInstance"),
           let status = info.value(forKey: "privacyOptionsRequirementStatus") as? Int {
            required = status == 1   // UMPPrivacyOptionsRequirementStatusRequired
        }
        call.resolve(["required": required])
    }

    @objc func showPrivacyOptions(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let cls: AnyClass = NSClassFromString("UMPConsentForm"), let vc = self.bridge?.viewController else {
                call.reject("Privacy options aren't available"); return
            }
            let done: @convention(block) (NSError?) -> Void = { err in
                if let err = err { call.reject(err.localizedDescription) } else { call.resolve() }
            }
            _ = (cls as AnyObject).perform(NSSelectorFromString("presentPrivacyOptionsFormFromViewController:completionHandler:"),
                            with: vc, with: unsafeBitCast(done, to: AnyObject.self))
        }
    }

    // ---- loading, and the ad's events (Objective-C names, exactly as the MAS SDK calls them)
    private func load() {
        DispatchQueue.main.async { _ = self.mas("Yodo1MasInterstitialAd", "sharedInstance")?.perform(NSSelectorFromString("loadAd")) }
    }

    private func finishShow(_ shown: Bool) {
        let c = showCall; showCall = nil
        c?.resolve(["shown": shown])
    }

    @objc(onInterstitialAdLoaded:)
    public func interstitialLoaded(_ ad: AnyObject) {
        retries = 0; loaded = true
        notifyListeners("interstitialLoaded", data: [:])
    }

    @objc(onInterstitialAdFailedToLoad:withError:)
    public func interstitialFailedToLoad(_ ad: AnyObject, error: AnyObject) {
        loaded = false
        notifyListeners("interstitialFailedToLoad", data: [:])
        // try again after a pause that doubles each time (10 s, 20 s, 40 s ... up to about 10 minutes), as MAS recommends
        let delay = 10.0 * pow(2.0, Double(min(retries, 6)))
        retries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { self.load() }
    }

    @objc(onInterstitialAdOpened:)
    public func interstitialOpened(_ ad: AnyObject) {}

    @objc(onInterstitialAdFailedToOpen:withError:)
    public func interstitialFailedToOpen(_ ad: AnyObject, error: AnyObject) {
        finishShow(false)
        load()
    }

    @objc(onInterstitialAdClosed:)
    public func interstitialClosed(_ ad: AnyObject) {
        finishShow(true)
        load()   // get the next one ready
    }
}

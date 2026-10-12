package world.soapcuberacing.yodo1mas;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.ump.ConsentInformation;
import com.google.android.ump.UserMessagingPlatform;
import com.yodo1.mas.Yodo1Mas;
import com.yodo1.mas.error.Yodo1MasError;
import com.yodo1.mas.helper.model.Yodo1MasAdBuildConfig;
import com.yodo1.mas.interstitial.Yodo1MasInterstitialAd;
import com.yodo1.mas.interstitial.Yodo1MasInterstitialAdListener;

/**
 * Yodo1 MAS for Soapcube Racing: full-screen (interstitial) ads only.
 *
 * The game calls (JavaScript, Capacitor.Plugins.Yodo1Mas):
 *   start({appKey})              starts MAS (its privacy window shows the first time), then loads the first ad
 *   isLoaded()                   -> {loaded}
 *   showInterstitial({placement}) -> {shown}, when the ad has been closed (or couldn't be shown)
 *   privacyOptions()             -> {required}: does this player need an "Ad privacy choices" button (EU/UK)?
 *   showPrivacyOptions()         opens Google's consent form again
 * and listens for "interstitialLoaded" / "interstitialFailedToLoad".
 * After every ad (and after a failed load, with a growing pause) the next ad is loaded by itself.
 */
@CapacitorPlugin(name = "Yodo1Mas")
public class Yodo1MasPlugin extends Plugin {
    private static final String TAG = "Yodo1Mas";
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean started = false, starting = false;
    private int retries = 0;
    private PluginCall showCall = null;

    @PluginMethod
    public void start(PluginCall call) {
        String key = call.getString("appKey", "");
        if (key == null || key.isEmpty()) { call.reject("appKey missing"); return; }
        if (started) { call.resolve(); return; }
        if (starting) { call.reject("already starting"); return; }
        starting = true;
        final Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            // MAS's own privacy window: asks the player's age and consent, and sets GDPR, CCPA and COPPA from the answers
            Yodo1MasAdBuildConfig config = new Yodo1MasAdBuildConfig.Builder().enableUserPrivacyDialog(true).build();
            Yodo1Mas.getInstance().setAdBuildConfig(config);
            Yodo1MasInterstitialAd.getInstance().setAdListener(listener);
            Yodo1Mas.getInstance().initMas(activity, key, initListener(call));
        });
    }

    // MAS's start-up callbacks. Different MAS versions call onMasInitSuccessful() or onMasInitSuccessful(configuration),
    // so the listener answers to both names (whatever their parameters) and resolves the call once.
    private Yodo1Mas.InitListener initListener(final PluginCall call) {
        final boolean[] done = { false };
        InvocationHandler h = (proxy, method, args) -> {
            switch (method.getName()) {
                case "onMasInitSuccessful":
                    if (!done[0]) { done[0] = true; started = true; starting = false; call.resolve(); loadNext(); }
                    return null;
                case "onMasInitFailed":
                    if (!done[0]) {
                        done[0] = true; starting = false;
                        Object error = args != null && args.length > 0 ? args[0] : null;
                        Log.w(TAG, "init failed: " + error);
                        call.reject("MAS init failed: " + error);
                    }
                    return null;
                case "hashCode": return System.identityHashCode(proxy);
                case "equals": return args != null && proxy == args[0];
                case "toString": return "Yodo1MasPlugin.InitListener";
                default: return null;
            }
        };
        return (Yodo1Mas.InitListener) Proxy.newProxyInstance(Yodo1Mas.InitListener.class.getClassLoader(),
                new Class<?>[] { Yodo1Mas.InitListener.class }, h);
    }

    @PluginMethod
    public void isLoaded(PluginCall call) {
        JSObject r = new JSObject();
        r.put("loaded", started && Yodo1MasInterstitialAd.getInstance().isLoaded());
        call.resolve(r);
    }

    @PluginMethod
    public void showInterstitial(PluginCall call) {
        if (!started || !Yodo1MasInterstitialAd.getInstance().isLoaded()) { done(call, false); return; }
        if (showCall != null) { done(call, false); return; }   // one ad at a time
        showCall = call;
        final String placement = call.getString("placement", "");
        getActivity().runOnUiThread(() -> {
            if (placement == null || placement.isEmpty()) Yodo1MasInterstitialAd.getInstance().showAd(getActivity());
            else Yodo1MasInterstitialAd.getInstance().showAd(getActivity(), placement);
        });
    }

    @PluginMethod
    public void privacyOptions(PluginCall call) {
        JSObject r = new JSObject();
        ConsentInformation ci = UserMessagingPlatform.getConsentInformation(getContext());
        r.put("required", ci.getPrivacyOptionsRequirementStatus() == ConsentInformation.PrivacyOptionsRequirementStatus.REQUIRED);
        call.resolve(r);
    }

    @PluginMethod
    public void showPrivacyOptions(PluginCall call) {
        getActivity().runOnUiThread(() -> UserMessagingPlatform.showPrivacyOptionsForm(getActivity(), formError -> {
            if (formError != null) call.reject(formError.getMessage());
            else call.resolve();
        }));
    }

    // ---- loading, and the ad's events
    private void loadNext() {   // (not "load": Capacitor's Plugin already has a load())
        main.post(() -> Yodo1MasInterstitialAd.getInstance().loadAd(getActivity()));
    }

    private void done(PluginCall call, boolean shown) {
        JSObject r = new JSObject();
        r.put("shown", shown);
        call.resolve(r);
    }

    private void finishShow(boolean shown) {
        PluginCall c = showCall;
        showCall = null;
        if (c != null) done(c, shown);
    }

    private final Yodo1MasInterstitialAdListener listener = new Yodo1MasInterstitialAdListener() {
        @Override
        public void onInterstitialAdLoaded(Yodo1MasInterstitialAd ad) {
            retries = 0;
            notifyListeners("interstitialLoaded", new JSObject());
        }

        @Override
        public void onInterstitialAdFailedToLoad(Yodo1MasInterstitialAd ad, @NonNull Yodo1MasError error) {
            Log.w(TAG, "load failed: " + error);
            JSObject e = new JSObject(); e.put("error", String.valueOf(error));
            notifyListeners("interstitialFailedToLoad", e);
            // try again after a pause that doubles each time (10 s, 20 s, 40 s ... up to about 10 minutes), as MAS recommends
            long delay = 10_000L * (1L << Math.min(retries, 6));
            retries++;
            main.postDelayed(() -> Yodo1MasInterstitialAd.getInstance().loadAd(getActivity()), delay);
        }

        @Override
        public void onInterstitialAdOpened(Yodo1MasInterstitialAd ad) { }

        @Override
        public void onInterstitialAdFailedToOpen(Yodo1MasInterstitialAd ad, @NonNull Yodo1MasError error) {
            Log.w(TAG, "show failed: " + error);
            JSObject e = new JSObject(); e.put("error", String.valueOf(error));
            notifyListeners("interstitialFailedToShow", e);
            finishShow(false);
            loadNext();
        }

        @Override
        public void onInterstitialAdClosed(Yodo1MasInterstitialAd ad) {
            finishShow(true);
            loadNext();   // get the next one ready
        }
    };
}

# capacitor-yodo1-mas

A small Capacitor plugin that shows Yodo1 MAS full-screen (interstitial) ads in the Soapcube Racing iOS and Android apps.
How to install and set it up: main `README.md`, step 6.

JavaScript (`Capacitor.Plugins.Yodo1Mas`), used by the game file:

| Call | Result |
|---|---|
| `start({appKey})` | Starts MAS. Its privacy window shows the first time, then the first ad loads. |
| `isLoaded()` | `{loaded}` |
| `showInterstitial({placement})` | `{shown}`, once the ad has been closed (or couldn't be shown). |
| `privacyOptions()` | `{required}`: whether this player needs the "Ad privacy choices" button (EU/UK). |
| `showPrivacyOptions()` | Opens Google's consent form again. |

Events: `interstitialLoaded`, `interstitialFailedToLoad`. After every ad, and after a failed load (with a pause that doubles each time), the next ad is loaded by itself.

# Soapcube Racing: online services

The game's online side is made of four parts:

| Part | What it does |
|---|---|
| **Render** (this server, `server.js`) | Multiplayer: lobbies (12-car races, 50-car Survival, AI cars), live car positions, results, the next-track vote. Also serves the game at `/` and receives purchase notifications from RevenueCat. |
| **Supabase** | Accounts: sign-up with email and password, sign-in, password reset, racer names, best times, unlocked cars, career progress, purchases, account deletion. The game talks to it directly. |
| **Resend** | Sends Supabase's emails (welcome + confirmation code, password-reset code, "password changed"). |
| **RevenueCat** | In-app purchases in the iOS/Android apps. Tells this server about every purchase or refund, and the server records it in the player's Supabase profile. |

Nothing important is stored on the Render server any more, so a restart, redeploy or Render's free-plan sleep loses nothing.

## Setup, step by step

### 1. Resend (email sending)

1. Create an account at resend.com.
2. **Domains → Add domain**: use a domain you own (e.g. `pebblehillderby.com`) and add the DNS records Resend shows you at your domain registrar. Wait until it says *Verified*. Without a verified domain Resend can only email you.
3. **API Keys → Create API key** (permission: *Sending access*). Copy it: you'll paste it into Supabase in step 2.

### 2. Supabase (accounts and saved progress)

1. Create a project at supabase.com. Region: **Frankfurt (eu-central-1)**, next to the Render server.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and press **Run**. It creates the `profiles` table, the security rules and the functions the game uses. Running it again later (after an update) is safe.
3. **Authentication → Sign In / Providers → Email**:
   - *Enable Email provider*: on
   - *Confirm email*: **on** (new players type the code from their welcome email)
   - *Secure password change*: off
   - *Minimum password length*: 6
   - *Email OTP length*: 6 (the game accepts 6–10 digits, so a longer setting also works)
4. **Authentication → Emails → SMTP Settings**: switch on *Custom SMTP* and fill in:
   - Sender email: e.g. `hello@pebblehillderby.com` (on your Resend domain)
   - Sender name: `Soapcube Racing`
   - Host: `smtp.resend.com`, Port: `465`
   - Username: `resend`, Password: your Resend API key
5. **Authentication → Emails → Templates**: for each template, set the subject and paste the matching file from `supabase/emails/` into the message body (switch the editor to *Source*/HTML first):

   | Template | Subject | Body |
   |---|---|---|
   | Confirm sign up | `Welcome to Soapcube Racing! Your code: {{ .Token }}` | `confirm-signup.html` |
   | Reset password | `{{ .Token }} is your Soapcube Racing code` | `reset-password.html` |
   | Password changed (under *Security notifications*: switch it on) | `Your Soapcube Racing password was changed` | `password-changed.html` |

6. **Authentication → Rate Limits**: *Rate limit for sending emails* starts at 30 an hour. Raise it once players arrive.
7. **Project Settings → API Keys**: copy the **Project URL**, the **publishable key** (`sb_publishable_…`, or the legacy *anon* key) and the **secret key** (`sb_secret_…`, or the legacy *service_role* key).
   - The publishable key is meant to ship inside the game.
   - The secret key bypasses every security rule. It only ever goes into Render (step 4), never into the game or GitHub.

The free Supabase plan pauses a project after a week with no activity. Before launch, move to **Pro** so it never pauses.

### 3. The game file

The game needs to know which Supabase project to talk to. You give it two values from step 2.7: the **Project URL** and the **publishable key**.

1. Open `public/pebble-hill-derby.html` in a text editor (VS Code, Notepad++, or GitHub's web editor: open the file, then the pencil icon).
2. Search (Ctrl+F) for `const SUPABASE_URL`. You'll find these two lines, with empty quotes:
   ```js
   const SUPABASE_URL='';
   const SUPABASE_KEY='';
   ```
3. Paste your values between the quotes, keeping the quotes:
   ```js
   const SUPABASE_URL='https://abcdefghijklmnop.supabase.co';
   const SUPABASE_KEY='sb_publishable_xxxxxxxxxxxxxxxx';
   ```
4. Save, commit, and let Render redeploy.

Use the **publishable** key here, never the secret one: the game file is public, and the publishable key is made to be public.

Until these are filled in, the Account screen says *Accounts are coming soon*. Guests can still race online.

### 4. Render (this server)

Under **Environment**, set:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | the Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | the publishable key (same as in the game) |
| `SUPABASE_SECRET_KEY` | the secret key (only needed for purchases) |
| `REVENUECAT_WEBHOOK_AUTH` | a long random password you make up, e.g. from a password generator (used in step 5) |

Delete the old `DATA_DIR`, `ADMIN_KEY`, `RESEND_API_KEY`, `BREVO_API_KEY` and `MAIL_FROM` variables if you set them: they aren't used any more.

After the deploy, open `https://<your server>/health`. It should show `"accounts":true` (and `"purchases":true` once step 5 is done).

The free Render plan works because nothing is stored on the server. A paid instance only removes the up-to-a-minute wake-up after the server has slept.

### 5. RevenueCat (when you make the iOS/Android apps)

1. Create a project at revenuecat.com and add your Google Play app (and later the App Store app). Step 10 walks through Google Play and the gold packs.
2. **Integrations → Webhooks → Add**:
   - URL: `https://<your server>/hooks/revenuecat`
   - Authorization header: the same value as `REVENUECAT_WEBHOOK_AUTH`
   - Press *Send test event*. Render's log should show `[revenuecat] TEST -> no player`.
3. **The app.** The Android app in `app/` already has the RevenueCat plugin (`@revenuecat/purchases-capacitor`); GitHub installs it with every build. (For iOS later: switch on *In-App Purchase* under *Signing & Capabilities* in Xcode.) The game finds the plugin by itself when it runs inside the app.
4. **The keys.** RevenueCat gives every app in your project its own **public SDK key**, and a key only appears once that app is added:
   - The App Store app's key starts with `appl_`; the Google Play app's key starts with `goog_`.
   - A new project also has a **Test Store** key (`test_…`). It's for testing only, never for a store build.
   - All of them are under **Project settings → API keys** (or **Apps** → pick the app).

   In the game file, put the `appl_` key in `REVENUECAT_IOS_KEY` and the `goog_` key in `REVENUECAT_ANDROID_KEY`. Each build picks the right one by itself.

How purchases flow:
- The game logs in to RevenueCat with the player's Supabase user id.
- Buying calls `iapBuy('<product id>')`.
- RevenueCat sends the purchase to this server, and the server calls `rc_event` in Supabase. That adds the product to the player's `owned_products` and the entitlements to `entitlements`.
- A refund takes them away again.
- *Restore purchases* appears on the Account screen inside the app.

### 6. Ads (Yodo1 MAS, in the iOS/Android apps)

The game shows a full-screen ad after every other drive: every race, Time attack, Career and online race counts, and so does a race you restart or quit after the start (not one quit during the countdown). Ads only run inside the apps; the browser version has none. To check the timing in a browser, open the game with `?adtest` at the end of the address (for example `https://soapcuberacing.world/?adtest`): a stand-in "TEST AD" screen then shows for 3 seconds wherever a real ad would. It stays on for that browser until you clear its site data. Like RevenueCat, this is done once the Capacitor app project exists.

Yodo1 MAS has no ready-made Capacitor plugin, so this repo has a small one: the folder `capacitor-yodo1-mas/` (Android in Java, iOS in Swift). It only does full-screen ads and the ad privacy choices. MAS brings its own ad accounts (AppLovin, Google AdMob and its other partners), so you don't need your own AdMob account.

1. **MAS account.** At the MAS dashboard (developers.yodo1.com → Dashboard), add your two games (Android and iOS). For each game, copy:
   - the **App Key**,
   - the **AdMob App ID** that MAS gives you (*Management → Games → Manage*). It looks like `ca-app-pub-…~…`.
2. **The app keys go into the game file.** They're in `YODO1_APP_KEY_ANDROID` (`XrUCntZjB3`) and `YODO1_APP_KEY_IOS` (`RMBrSj19Sy`).
   Your two MAS AdMob App IDs are `ca-app-pub-5784311004955543~1919610929` and `ca-app-pub-5784311004955543~7986868396`. The part before `~` is the same because it's MAS's account; the part after `~` is the app. Check in the MAS dashboard which one belongs to the Android game and which to the iOS game, and use each in its own app (steps 5 and 6).
3. **Create the iOS app with CocoaPods.** MAS is only available through CocoaPods, and new Capacitor projects use Swift Package Manager by default. So add the iOS platform like this:
   ```
   npx cap add ios --packagemanager CocoaPods
   ```
4. **Install the plugin.** The `capacitor-yodo1-mas` folder lives in this repo (next to `server.js`; Render ignores it). From inside the Capacitor project folder, install it by its path. For example, if the Capacitor project sits next to this repo's folder:
   ```
   npm install ../phd-server/capacitor-yodo1-mas
   ```
5. **Android** (folder `android/`):
   - In `android/build.gradle`, inside `allprojects { repositories { … } }`, add MAS's ad-network repositories:
     ```
     maven { url "https://artifact.bytedance.com/repository/pangle" }
     maven { url "https://android-sdk.is.com" }
     maven { url "https://dl-maven-android.mintegral.com/repository/mbridge_android_sdk_oversea" }
     maven { url "https://artifactory.bidmachine.io/bidmachine" }
     maven { url "https://ysonetwork.s3.eu-west-3.amazonaws.com/sdk/android" }
     maven { url "https://repo.pubmatic.com/artifactory/public-repos" }
     maven { url "https://cboost.jfrog.io/artifactory/chartboost-ads/" }
     maven { url "https://jfrog.anythinktech.com/artifactory/overseas_sdk" }
     maven { url "https://jitpack.io" }
     ```
   - In `android/app/build.gradle`, inside `defaultConfig`, add `multiDexEnabled true`. Keep `minSdkVersion` at 24 or higher (`android/variables.gradle`).
   - In `android/gradle.properties`, add:
     ```
     android.enableJetifier=true
     ```
   - In `android/app/src/main/AndroidManifest.xml`, inside `<application>`, add MAS's AdMob App ID for the Android game:
     ```xml
     <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="ca-app-pub-…~…"/>
     ```
6. **iOS** (folder `ios/App/`):
   - In `ios/App/Podfile`, add these two lines at the very top, and change `use_frameworks!` to `use_frameworks! :linkage => :static`:
     ```
     source 'https://github.com/CocoaPods/Specs.git'
     source 'https://github.com/Yodo1Games/MAS-Spec.git'
     ```
   - In `ios/App/App/Info.plist`, add:
     - `GADApplicationIdentifier`: MAS's AdMob App ID for the iOS game.
     - `GADIsAdManagerApp`: `YES`.
     - `NSUserTrackingUsageDescription`: for example "Used to show you more relevant ads."
     - `NSAppTransportSecurity` → `NSAllowsArbitraryLoads`: `YES`.
     - `SKAdNetworkItems`: the list linked from Yodo1's iOS integration guide.
   - In Xcode, set *Always Embed Swift Standard Libraries* to *Yes* (Build Settings).
7. **Sync**, from the project folder:
   ```
   npx cap sync
   ```
   (On iOS this runs `pod install`. If it complains about the MAS repo, run `pod install --repo-update` inside `ios/App`.)
8. **Test ads first.** In the MAS dashboard, add your phone under *Management → Testing* (a free "device ID" app shows its id), and switch on *Test Mode* for the game under *Management → Games → Manage*. Your phone then gets test ads. Switch Test Mode off for the release, and never click your own real ads.

What players see:
- **First launch:** MAS's privacy window asks the player's age and whether they agree to their data being used for ads. That covers GDPR, CCPA and COPPA. On iPhone, Apple's "allow tracking?" question follows.
- **EU/UK players:** Google's consent form (which MAS uses) appears from the second launch. *Options → Ad privacy choices* lets them change their answer later. The button only shows for players who need it.
- **Single player:** the ad plays when you leave the results screen (*Race again*, *Next*, or the menu button), or when you restart or quit from the pause menu.
- **Multiplayer:** the ad plays a couple of seconds after you cross the line, while the others are still finishing.
- When an ad isn't loaded yet, or fails, the game carries on after a short wait. A new ad is loaded straight after each one.

Notes:
- The plugin follows Yodo1's own Android and iOS reference code for MAS 4.18. It hasn't been built here (that needs the real app project), so if Android Studio or Xcode flags a line when you first build, send me the message.
- If you change the MAS version, change it in both `capacitor-yodo1-mas/android/build.gradle` and `capacitor-yodo1-mas/CapacitorYodo1Mas.podspec`.

### 7. Your domain (soapcuberacing.world)

This server also serves the How to play clips (`public/howto/*.webp`, at `/howto/…`), the music (`public/music/*.mp4`, at `/music/…`), the privacy policy (`public/privacy.html`) at `/privacy`, and the ads' `app-ads.txt` at `/app-ads.txt`. To put them on your own domain:

1. In Render, open the service and go to **Settings → Custom Domains → Add**. Add `soapcuberacing.world` and `www.soapcuberacing.world`.
2. Render shows the DNS records to create. Add them at the company you bought the domain from, under its DNS settings:
   - an `A` record for the bare domain,
   - a `CNAME` record for `www`.
3. Wait until Render shows the domain as *Verified*; it sets up HTTPS by itself. Then `https://soapcuberacing.world/privacy` works.
   The game page is also served at `https://soapcuberacing.world/`.
4. **The contact email.** The policy gives `privacy@soapcuberacing.world` as the contact address, so make it reach your inbox. Most domain sellers offer free email forwarding (Cloudflare Email Routing works too): forward `privacy@` to your own address. To use a different address, replace the email in `public/privacy.html`.
5. **app-ads.txt.** The server serves it by itself at `/app-ads.txt`: it copies MAS's list of ad sellers from `https://yodo1.com/app-ads.txt` and refreshes it every 6 hours, so nothing to upload or update. Enter `https://soapcuberacing.world` as the developer website in both store accounts, then open `https://soapcuberacing.world/app-ads.txt` to check it shows a long list. If MAS gives your game its own app-ads.txt microsite (MAS → Games → Manage → Ads Management, e.g. `2v37.ads-txt.site`), put it in the Europe service's environment as `APP_ADS_URL` (with or without `https://`): the server then serves your game's list, and falls back to the general one if that link ever fails. `/health` shows which list is in use under `appAds`. A file at `public/app-ads.txt` overrides both.

### 8. Money: cash and gold

Cash (green paper money) is won in races. Gold ingots are bought in the apps. Both balances are kept in Supabase, and the game can only show them, never change them:

- **Single player** (Quick race, Custom race, Career, Survival, Time attack): the game tells the database when a race starts and where you finished. The database works out the prize and pays each race once. A race that ends quicker than anyone could drive that track pays nothing. A player can be paid for at most 150 races a day.
- **Online races**: this server saw the race, so it pays every signed-in racer the moment they cross the line (it needs `SUPABASE_SECRET_KEY`, see step 4). Guests don't earn cash.

**Prizes** (all in `phd_prize` / `phd_cup_prize` in `schema.sql`):

| Place | Race (12 cars) | Race, Pebble Hill | Survival (50 cars) | Survival, Pebble Hill |
|---|---|---|---|---|
| 1st | 1,500 | 1,200 | 5,000 | 3,500 |
| 2nd | 1,100 | 900 | 4,000 | 2,700 |
| 3rd | 800 | 700 | 3,500 | 2,200 |
| 4th | 600 | 500 | 3,400 | 2,150 |
| after that | 50 less a place (11th: 250) | 50 less a place (11th: 150) | 100 less a place (0 from 38th) | 50 less a place (0 from 47th) |
| last | 0 | 0 | 0 | 0 |

- **Career cups**: the race table above. Race 2 pays 20% more, race 3 another 30% on top (×1.56), to the nearest 100 (1st: 1,500 → 1,800 → 2,300). Winning the cup on points adds **10,000** (once per go at the cup, and only if all three races were raced). Career Survival bonuses pay like Survival.
- **Time attack**: beating Pal's time on a track pays **10,000 cash + 10 gold**, once per track. Pal's times are in the `ta_targets` table (seconds; the game reads them when it starts, so they can be changed there). Pal's times: Pebble Hill 1:33.18, City Scape 1:54.61, Nomahe 2:13.89, Tokiyama 1:32.81, Whitecow 1:37.18, Aloma 2:10.87, Mesozon 2:33.39.
- **Online**: the same tables. A field that isn't full pays its share of them: 3 cars in a race get 3/12 (25%), 25 cars in Survival get 25/50 (50%). AI cars count as cars. Online Survival only starts with at least 13 cars (players + AI); with AI on it always has 50.

**Gold packs.** Three **consumable** in-app products, with the same ids in Google Play Console (and later App Store Connect) and RevenueCat. Step 10 shows where to make them.

| Product id | Gold | Price | Gold per $ |
|---|---|---|---|
| `gold_100` | 100 | $1.99 | 50 |
| `gold_300` | 300 | $4.99 | 60 |
| `gold_500` | 500 | $6.99 | 72 ("Best value") |

You set the prices in the stores (in US dollars; the store works out the other currencies).

To change how much gold a pack gives, or to add a pack, edit the `gold_products` table in Supabase (the game's list is `GOLD_PACKS` in the game file). The purchase reaches the database through the RevenueCat webhook from step 5. A refund takes the gold back.

**Music.** Three playlists, each played in a random order: **lounge** in the menus (`main-lounge`, `lounge-perc`, `super-easy`), **garage** in the garage (`superchill`), **racing** from GO until you cross the line (`beat-lover`, `percussion-finger`, `quid-racer`, `quister`). A playlist starting afresh often begins its track part-way through, for variety. The files are AAC audio in `.mp4` files (plays on Android and iPhone), evened out to the same loudness (-16 LUFS), in `public/music/`; the app build copies them into the app. Music has its own volume in Options (starts at 50%), and the speaker button in a race is now a music on/off button (sound effects keep playing). To add a track: convert it the same way (`ffmpeg -i in.ogg -af loudnorm=I=-16:TP=-1.5 -c:a aac -b:a 112k -ar 44100 -f mp4 out.mp4`), put it in `public/music/` (lower-case name, no spaces), and add its name and length in seconds to `MUSIC` in the game file.

**Custom colours & wheel tuning (200 gold).** Any body colour, a second colour for the graphics of the GT44, Carato, Ryper, 3EM (red lower body), Retta C18 and Shimita, any wheel colour, wheel size, offset and ride height are a one-time unlock. Without it a player picks from the standard paints (white, silver, black, red, blue) and rim finishes, on 18" rims and the stock stance; the custom picks they had are kept and come back once they unlock. The database does the buying (`buy_perk`) and records it in `profiles.perks`; the game server checks it too, so a player who hasn't unlocked it can't show a custom look to others online. To change the price, edit the `perk_prices` table (the game reads it with `perk_shop`). Run `schema.sql` again after updating to add all this.

**Online prizes** are paid the moment a racer crosses the line (their place can't change after that), so leaving straight away loses nothing. Racers still on the course when the race ends are paid then.

**The car shop.** Every car has a price in cash and in gold. Every player has one stock car, the Shutter RR. The rest are bought in the garage, which lists them from the cheapest up. A car you haven't bought can be looked at and painted, but you race in your own car. The database does the buying (`buy_car`): it checks the balance, takes the money and adds the car to `profiles.cars`, so a player can't give themselves a car.

- **Cash prices** follow the real cars each one looks like (GT44 ≈ Mustang 45,000; M20 ≈ F40 1,500,000).
- **Gold prices** are `12 × (cash ÷ 45,000)^0.8`, rounded, so gold is a better deal on the big cars. With the packs above, a 45,000 car costs 10 gold (about $0.15–0.20), the M20 200 gold (about $3–4) and the dearest car (DRZ1) 525 gold (about $7–10).
- **Change a price** in the `car_prices` table (Table Editor). The game reads the list when it starts (`car_shop`), so no app update is needed. The list in the game (`CAR_SHOP`) is only used until then, or offline. A car's number is its place in the game's car list (not the order the garage shows), so don't renumber the cars.

| # | Car | Looks like | Cash | Gold |
|---|---|---|---|---|
| 6 | Shutter RR | hot hatch | 40,000 | 10 (stock car: everyone has it) |
| 21 | Tiremu S | Toyota AE86 | 30,000 | 10 |
| 23 | Retta C18 | Corvette C3 | 35,000 | 10 |
| 12 | GT44 | Ford Mustang | 45,000 | 10 |
| 17 | Shimita | Lancer Evo | 55,000 | 15 |
| 18 | Katsuki | Datsun 240Z | 60,000 | 15 |
| 2 | Channer | Dodge Challenger | 70,000 | 15 |
| 19 | Carato | Chevrolet Camaro | 75,000 | 20 |
| 0 | Sparu | Toyota Supra | 85,000 | 20 |
| 16 | GT11 | Dodge Charger | 90,000 | 20 |
| 14 | 3000M | BMW M3 E30 | 100,000 | 25 |
| 3 | Ryper | Dodge Viper | 110,000 | 25 |
| 11 | 3EM | BMW M3 GTR | 120,000 | 25 |
| 1 | Manto V8 | Aston Martin Vantage | 150,000 | 30 |
| 15 | Shielder | time-attack widebody | 150,000 | 30 |
| 7 | Collogiallo | Ferrari Testarossa | 180,000 | 35 |
| 9 | P119 | Porsche 930 Turbo | 200,000 | 40 |
| 22 | Mosi 4R4 | Nissan Skyline R34 | 220,000 | 45 |
| 10 | CM33 | Ferrari 458 | 280,000 | 50 |
| 5 | Portello 11 | Lamborghini Murciélago | 400,000 | 70 |
| 24 | Stellos | Lancia Stratos | 550,000 | 90 |
| 4 | Portello 12 | Lamborghini Countach | 650,000 | 100 |
| 20 | M20 | Ferrari F40 | 1,500,000 | 200 |
| 8 | Koetale ZZ | Koenigsegg | 3,000,000 | 350 |
| 13 | DRZ1 | McLaren F1 | 5,000,000 | 525 |

After updating, run `schema.sql` again in Supabase (SQL Editor). It adds the shop and keeps everyone's money.

### 9. Android test app (an APK for your phone, built by GitHub)

The folder `app/` is the Android app: a Capacitor project that wraps `public/pebble-hill-derby.html` (and the How to play clips in `public/howto/`), with the Yodo1 MAS plugin already set up (step 6 is done in it, for Android).
- App ID: `world.soapcuberacing.app`.
- Always landscape and full screen.
- Uses the public game server and your Supabase accounts, like the website.

GitHub builds it for you: nothing to install on your computer.

1. **Build it.** The workflow `.github/workflows/android-apk.yml` (it must be in the repository's top folder: create it with **Actions → New workflow → set up a workflow yourself**, name it `android-apk.yml`, paste the file) builds the APK when you start it: **Actions → Android test app → Run workflow**. A build takes about 10 minutes.
2. **Download it.** Open the finished run (green tick) and, under **Artifacts**, download **soapcube-racing-apk**. It's a zip with `app-debug.apk` inside.
3. **Install it.** On the phone, open `app-debug.apk` (from Downloads, or the Files app after unzipping). Android asks to allow installing apps from this source (your browser or Files app): allow it, then install. Play Protect may warn that the app is unknown: choose *Install anyway*.
4. **Updates** install over the old version and keep your progress, because every build is signed with the same test key (`app/android/app/soapcube-test.keystore`). That key is only for testing, not for Google Play.

If a build fails (red cross), open it, click the failed step, and send me the last part of the log.

When you run the workflow it asks **What to build**: *Test APK* (this step) or *Google Play* (step 10). Buying gold doesn't work in the test APK: Google only sells through a copy of the app installed from Play.

Ads in the test app: add your phone in the MAS dashboard (*Management → Testing*) and switch on *Test Mode* for the Android game. Your phone then gets test ads, and you never click your own real ads by mistake.

### 10. Google Play and gold purchases

Purchases only work in a copy of the app that came from Google Play, so this is done through Play's **internal testing** (open to new personal accounts straight away, no 12-tester rule).

1. **Your upload key** (Google uses it to check that uploads really come from you). Keep `soapcube-upload.jks` and its password somewhere safe, *not* in the repository.
   - Put `upload-key.jks.enc` in `phd-server/app/android/`. It's the upload key locked with its password, so it's safe in the repository: it can't be used without the password.
   - In GitHub: **Settings → Secrets and variables → Actions → New repository secret**: name `UPLOAD_KEYSTORE_PASSWORD`, value: the text of `UPLOAD_KEYSTORE_PASSWORD.txt`.
   - (Instead of the locked file, a second secret `UPLOAD_KEYSTORE_B64` with the text of `UPLOAD_KEYSTORE_B64.txt` also works.)
2. **Build for Play.** **Actions → Android test app → Run workflow**, pick **Google Play (AAB to upload)**. Download the artifact **soapcube-racing-play**: it has `app-release.aab` inside. Every run gets a higher build number, as Play wants.
3. **Upload it.** Play Console → your app → **Test and release → Testing → Internal testing → Create new release**. Let Google manage the app signing key (the default), upload `app-release.aab`, save and roll out. Under **Testers**, add your Gmail address and open the **join link** on your phone, then install the game from the Play Store. (Uninstall the test APK first: it's signed with a different key.)
4. **Payments profile.** Play Console → **Settings → Payments profile**: set one up (needed to sell anything).
5. **The gold packs.** Play Console → **Monetize with Play → Products → One-time products → Create**: `gold_100` ($1.99), `gold_300` ($4.99), `gold_500` ($6.99). Give each a name ("100 gold") and activate it. (This menu only opens after the first upload.)
6. **Free test purchases.** Play Console (the account level, not the app) → **Settings → License testing**: add your Gmail address. Your test purchases then use a test card and cost nothing.
7. **RevenueCat.**
   - Add the Google Play app: in your project's settings, under the apps list, **+ New app → Google Play Store**, package name `world.soapcuberacing.app`. It doesn't have to be published. Its `goog_…` key appears straight away under **API keys** (the `test_…` key there is only for RevenueCat's Test Store).
   - Upload the **service account credentials** RevenueCat asks for (its guide "Google Play Store: service credentials" walks you through it; it can take up to 36 hours to start working).
   - **Product catalog → Products → New**: add `gold_100`, `gold_300` and `gold_500` (or import them from Play).
   - Copy the app's public SDK key (`goog_…`) into `REVENUECAT_ANDROID_KEY` in the game file (or send it to me).
   - Check the webhook from step 5 points at your server.
8. **Try it.** Build for Play again (with the key in the game), upload, update from the Play Store, sign in, open the wallet and buy a pack. The gold arrives a few seconds later (RevenueCat → this server → Supabase).

### 11. More servers (Americas, Asia)

Every server runs its own lobbies; accounts, money and cars are shared (they're in Supabase). The game pings each server and joins the closest by itself. Players can pick another in **Multiplayer → 🌍 (server button)**. Friends who want to race together pick the same one.

The game already knows these three addresses:

| Server | Render region | Service name (gives the address) |
|---|---|---|
| Europe | Frankfurt | `pebble-hill-derby-server-eu` (the one you have) |
| Americas | Virginia (US East) | `pebble-hill-derby-server-us` |
| Asia | Singapore | `pebble-hill-derby-server-asia` |

For each new one: Render → **New → Web Service** → the same GitHub repository.
- **Name**: exactly as in the table. It becomes `https://<name>.onrender.com`. If Render adds letters to the address because the name is taken, send me the address.
- **Region**: as in the table (it can't be changed later).
- **Root directory, Build command, Start command**: copy them from the Europe service (its **Settings** page).
- **Instance type**: a paid one ($7/month) for real players. A free instance goes to sleep when nobody plays and takes about a minute to wake up.
- **Environment**: copy the variables from the Europe service (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`). The RevenueCat webhook stays pointed at the Europe server only.

Each new commit to GitHub redeploys all of them. A server that isn't set up yet just shows as "offline" in the list.

## Seeing your players

In Supabase:
- **Table Editor → profiles**: racer name, email, sign-up date, last seen, best times, unlocked cars, career, purchases.
- **Authentication → Users**: every account and its sign-ins. Deleting a user there also deletes their profile.
- **Table Editor → purchase_events**: every RevenueCat event.
- **Table Editor → profiles → cash / gold**: each player's balances. **wallet_log** lists every change and its reason (race, online race, gold purchase, gold refund).

## Run it on your computer

Needs Node.js 18 or newer.

```
npm install
npm start
```

Open http://localhost:8080 and choose **Multiplayer**. Other devices on the same Wi-Fi can join at `http://<your computer's IP>:8080`. For accounts to work locally, set the same `SUPABASE_*` variables before `npm start`.

The game connects to `wss://pebble-hill-derby-server-eu.onrender.com/ws` by default (`DEFAULT_SERVER` in the game file). When it's opened from `localhost` or your home network, it uses that local server instead. You can still type a different address under **Multiplayer → Server**.

## Updating

- **Game:** replace `public/pebble-hill-derby.html` and redeploy. The How to play clips are separate files in `public/howto/` (push, brake, handbrake, slipstream, reset `.webp`); keep them next to the game. `TRACK_IDS` at the top of `server.js` must list the same track ids as the game.
- **Database:** when `supabase/schema.sql` changes, run it again in the SQL Editor.

## Security notes

- Passwords are handled by Supabase and never reach this server.
- Players can read only their own profile. Every change goes through database functions that check the input: best times between 15 s and 1 hour, unique racer names, career data up to 16 KB.
- Only the server, using the secret key, can record purchases and pay online race prizes.
- Players can't change their cash or gold. Single-player prizes are worked out by the database from the place the game reports, after a timing check and a daily limit. The place itself comes from the player's game, so it could still be faked, but only within those limits.
- Deleting an account (Account screen → *Delete account*, password required) removes the sign-in and the whole profile. The purchase log keeps its records with the user id.
- Changing or resetting a password signs out the player's other devices.
- Wrong private-server passwords and sign-in tries from one IP are slowed down (12 per 5 minutes).
- The RevenueCat webhook rejects requests without the right Authorization header.
- Each player sends their own car's position. The server checks finish times against its own clock, but there's no anti-cheat beyond that.

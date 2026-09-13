# The widget (Scriptable)

## Install

1. Install **Scriptable** from the App Store — free.
2. Open `reel-metrics.js` and fill in the two lines at the top:

   ```js
   const CONFIG = {
     url: "https://reel-metrics.YOUR-SUBDOMAIN.workers.dev",
     key: "PASTE_YOUR_API_KEY",
   };
   ```

   Both are in `worker/.deploy-info` on your Mac:

   ```bash
   cat ~/Data/Claude/Projects/insta_metrics/worker/.deploy-info
   ```

3. Get the file onto your phone — AirDrop it, or paste it into a new
   Scriptable script named `Reel Metrics`. Run it once inside the app; it
   shows the large layout as a preview, which is the fastest way to confirm
   the URL and key are right.
4. **Add the widget from the home screen, not from inside Scriptable.**

   - Go to your home screen and long-press an empty area until the icons
     jiggle.
   - Tap the **+** (top of the screen).
   - Search for **Scriptable**, pick a size, tap **Add Widget**.
   - The placed widget will show a Scriptable placeholder at first. Long-press
     it → **Edit Widget** → set **Script** to *Reel Metrics*.
   - While in that sheet: **When Interacting** should be *Run Script*, and
     **Parameter** should be empty.

   > **Do not use "Add to Home Screen"** in the share sheet while inside
   > Scriptable. That is Safari's feature for creating a web bookmark icon,
   > not a widget. It tries to make a web clip out of a `scriptable://` URL
   > and fails with *"Not allowed to use restricted network port"*, which
   > looks like a network fault and is really the wrong menu item. Nothing is
   > wrong with the script when this happens.

## The three sizes

| Size | Shows |
|---|---|
| Small | Latest reel's views, movement in the last hour, age, likes |
| Medium | The above plus likes / comments / shares / saved / average watch, with a sparkline |
| Large | All of that, plus the five tracked reels on a log scale and the account line |

Tapping any size opens the latest reel. On the large size, tapping a row in
the list opens that specific reel.

## Things that look like bugs but aren't

**"collecting…" instead of a number.** There is no reading old enough to
compare against yet. The 1h window fills first, 24h last. Zero would be a
lie, so it doesn't say zero.

**The widget doesn't update when you expect.** iOS decides when widgets
refresh; the script asks for 15 minutes and iOS treats that as a suggestion,
sometimes leaving it an hour. This is why the timestamp is always on screen,
and why the widget computes nothing itself — the server is the clock.

**"stale 04:47" in the corner.** The fetch failed and you're seeing the last
good response from the on-device cache. Deliberate: an error card is the
worst thing to put on a home screen, where things are mostly seen in
passing.

**The bars don't look proportional.** They aren't — it's a log scale, marked
as such. A single breakout reel can out-perform an ordinary one by two orders of
magnitude, and on a linear scale every bar but that one collapses to a
sliver. Every bar is labelled with its real number.

**"53% skipped".** `reels_skip_rate`, which turned up only because Meta's
error message listed it while rejecting something else. It's the one
retention figure that's normalised — average watch time isn't comparable
across reels of different lengths, and the API gives no video duration.
